require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { CasparCG } = require('casparcg-connection');
const { sequelize, User, Channel, Source, BrandingPreset, CloudStream } = require('./db/models');
const procManager = require('./process-manager');
const vmControl = require('./vm-control');

// Mirror every console.log/error into the same log stream as the managed
// CasparCG/MediaMTX processes, so the browser's log console is the single
// place to watch everything instead of needing this process's own terminal.
const rawConsoleLog = console.log.bind(console);
const rawConsoleError = console.error.bind(console);
console.log = (...args) => { rawConsoleLog(...args); procManager.pushLog('dashboard', args.map(String).join(' ')); };
console.error = (...args) => { rawConsoleError(...args); procManager.pushLog('dashboard', args.map(String).join(' ')); };

const app = express();
const PORT = process.env.PORT || 3005;
const CASPAR_DIR = path.join(__dirname, '..', 'casparcg-server-v2.5.0-stable-windows');
const MEDIAMTX_DIR = path.join(__dirname, '..', 'mediamtx_v1.20.1_windows_amd64');

// Fixed consumer index for the RTMP STREAM output on every CasparCG channel we
// manage. CasparCG's ADD auto-assigns an index when none is given and never
// reports it back in the response, so there's no way to target that consumer
// again later (e.g. to remove it when switching to a channel profile with a
// different RTMP target). Using a fixed, app-chosen index instead means
// REMOVE can always find it (verified live: "ADD 1-100 STREAM ..." then
// "REMOVE 1-100" both return 202 OK against a real running consumer).
const STREAM_CONSUMER_INDEX = 100;

if (!process.env.SESSION_SECRET) {
  console.error('[Config] SESSION_SECRET must be set in .env - see .env.example');
  process.exit(1);
}

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 } // 12h
}));

// --- AUTH ---
// Real session-based login (replacing the earlier HTTP Basic Auth prompt) backed
// by the Users table. /login itself must stay reachable before the auth gate.
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await User.findOne({ where: { username } });
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ status: 'error', message: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ status: 'success' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ status: 'success' }));
});

// Uploaded branding images must stay reachable without a session: CasparCG's
// CEF-based HTML producer loads them as plain <img> requests with no
// awareness of the dashboard's login, so gating them behind auth would just
// break every image-based graphic (broken image, no error visible anywhere).
// Not a real exposure - these are assets meant to go out on the live
// broadcast anyway.
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

app.use((req, res, next) => {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ status: 'error', message: 'Not authenticated' });
  return res.redirect('/login');
});

// Serve static frontend files - placed after the auth gate so index.html itself
// requires a session.
app.use(express.static(path.join(__dirname, 'public')));

// --- CASPARCG CONNECTION ---
const caspar = new CasparCG({
  host: process.env.CASPAR_HOST || '127.0.0.1',
  port: Number(process.env.CASPAR_PORT) || 5250,
  autoConnect: true
});

// Server-side state so the UI can show what's actually happening instead of
// operators having to infer it from a single overwritten log line.
const state = {
  casparConnected: false,
  activeChannelId: null,
  activeChannelName: null,
  activeSourceId: null,
  activeSourceLabel: null,
  streamConsumerActive: false,
  streamConsumerTarget: null, // which rtmpTarget the live consumer is pointed at
  activeGraphics: {}, // populated below once TEMPLATES is defined
  lastError: null
};

caspar.on('connect', async () => {
  state.casparConnected = true;
  console.log('[AMCP] Connected successfully to CasparCG Server on port 5250');

  // Fires on every (re)connection, not just the first - including after
  // CasparCG restarts for any reason (an explicit restart from the UI, a
  // crash, or anything else). A fresh CasparCG process has no consumers or
  // producers at all, so if we were previously showing something, put it
  // back rather than leaving a silently-dead stream. Tying recovery to the
  // actual reconnection event (rather than a fixed delay after a restart we
  // asked for) is what makes this correct even for a restart the dashboard
  // didn't initiate itself - observed live: CasparCG restarted a second,
  // unexpected time during testing, and a delay-based recovery in the
  // restart handler alone missed it.
  state.streamConsumerActive = false;
  state.streamConsumerTarget = null;
  resetFailoverTracking();
  if (state.activeSourceId) {
    try {
      await playSourceById(state.activeSourceId);
      console.log(`[AMCP] Re-established playout after (re)connect: source ${state.activeSourceId}`);
    } catch (err) {
      console.error('[AMCP] Failed to re-establish playout after reconnect:', err.message);
    }
  }
  if (state.activeChannelId) {
    for (const key of Object.keys(state.activeGraphics)) state.activeGraphics[key] = false;
    await applyDefaultPresets(state.activeChannelId);
  }
});

caspar.on('disconnect', () => {
  state.casparConnected = false;
  console.log('[AMCP] Disconnected from CasparCG Server');
});

caspar.on('error', (err) => {
  state.casparConnected = false;
  state.lastError = err?.message || String(err);
  console.error('[AMCP Error]', err);
});

// CG template registry - each template runs on its own layer so multiple
// graphics can be on air simultaneously (e.g. a lower third and a ticker at
// the same time). Adding a new template only requires a new HTML file under
// casparcg-server.../template/branding/ plus an entry here.
//
// Image overlays are registered as several independent slots ("image_overlay_1",
// "_2", "_3") rather than one fixed template, so more than one image can be on
// air at once (e.g. a station bug and a sponsor logo together) - each slot gets
// its own layer and is shown/hidden/positioned completely independently. Bump
// IMAGE_OVERLAY_SLOTS to add more; nothing else needs to change since show/hide/
// presets already key off whatever templates exist in this registry.
const IMAGE_OVERLAY_SLOTS = 3;
// Solid occlusion boxes, not a true blur: CasparCG's ffmpeg consumer doesn't
// support "-filter_complex" (confirmed empirically - it's an ffmpeg CLI-only
// concept, not a real AVOption, and this build's wrapper only implements
// simple non-branching "-filter:v"/"-filter:a" chains), and a CG overlay layer
// has no access to the video pixels beneath it for a CSS backdrop-filter to
// blur anyway. Fully covering the region is the achievable alternative.
const CENSOR_BOX_SLOTS = 3;

const TEMPLATES = {
  lower_third: { path: 'branding/lower_third', layer: 10, defaultData: { title: 'CINEMACHI ACTION', subtitle: 'AFRO MOBILE MEDIA | CH 06', position: { xPercent: 5, yPercent: 75 } } },
  logo_bug: { path: 'branding/logo_bug', layer: 11, defaultData: { text: 'CH 06', position: { xPercent: 82, yPercent: 6 } } },
  ticker: { path: 'branding/ticker', layer: 12, defaultData: { text: 'BREAKING NEWS...', position: { mode: 'bottom' } } }
};
for (let i = 1; i <= IMAGE_OVERLAY_SLOTS; i++) {
  TEMPLATES[`image_overlay_${i}`] = {
    path: 'branding/image_overlay',
    layer: 12 + i, // 13, 14, 15, ...
    defaultData: { imageUrl: '', position: { xPercent: 3, yPercent: 6 + (i - 1) * 22 }, widthPercent: 15, heightPercent: 15 }
  };
}
for (let i = 1; i <= CENSOR_BOX_SLOTS; i++) {
  TEMPLATES[`censor_box_${i}`] = {
    path: 'branding/censor_box',
    layer: 15 + i, // 16, 17, 18, ...
    defaultData: { color: '#000000', position: { xPercent: 40, yPercent: 40 + (i - 1) * 15 }, widthPercent: 15, heightPercent: 15 }
  };
}
state.activeGraphics = Object.fromEntries(Object.keys(TEMPLATES).map((k) => [k, false]));

// --- IMAGE UPLOADS ---
// Uploaded assets (logos etc. for the "image_overlay" template) are saved
// under public/uploads and served statically by express.static above, so
// CasparCG's CEF-based HTML producer can load them the same way a browser
// would - by plain HTTP URL, no special handling needed on CasparCG's side.
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'public', 'uploads'),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  }
});

/**
 * POST /api/assets/upload
 * multipart/form-data, field name "image". Returns { url } for use as a
 * BrandingPreset's imageUrl.
 */
app.post('/api/assets/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ status: 'error', message: err.message });
    if (!req.file) return res.status(400).json({ status: 'error', message: 'No image uploaded' });
    // Must be absolute: this URL gets embedded in an <img src> inside a template
    // that CasparCG's CEF process loads in its own context, not the browser's -
    // a relative path would resolve against CasparCG's own template server
    // instead of this dashboard.
    res.json({ status: 'success', url: `http://127.0.0.1:${PORT}/uploads/${req.file.filename}` });
  });
});

function getActiveChannel() {
  return Channel.findOne({ where: { isActive: true }, include: [{ model: Source }] });
}

/**
 * Shows every default-marked BrandingPreset for a channel (one per template,
 * at most). Called after activating a channel, after CasparCG reconnects for
 * any reason, and on dashboard startup, so branding comes back on its own
 * instead of needing to be manually re-applied every time.
 */
async function applyDefaultPresets(channelId) {
  const defaults = await BrandingPreset.findAll({ where: { channelId, isDefault: true } });
  const channel = await Channel.findByPk(channelId);
  if (!channel) return;
  for (const preset of defaults) {
    const template = TEMPLATES[preset.template];
    if (!template) continue;
    try {
      await caspar.cgAdd({ channel: channel.casparChannelNumber, layer: template.layer, template: template.path, playOnLoad: true, data: preset.data });
      state.activeGraphics[preset.template] = true;
      console.log(`[Preset] Default "${preset.name}" (${preset.template}) applied`);
    } catch (err) {
      console.error(`[Preset] Failed to apply default "${preset.name}":`, err.message);
    }
  }
}

/**
 * Plays a Source (by DB id) on its Channel's layer 1, attaching/repointing the
 * RTMP STREAM consumer as needed. Shared by /api/stream/play, channel
 * activation, and the failover watchdog below.
 */
async function playSourceById(sourceId) {
  const source = await Source.findByPk(sourceId, { include: [Channel] });
  if (!source) throw new Error(`Source ${sourceId} not found`);
  const channel = source.Channel;
  const channelNo = channel.casparChannelNumber;

  await caspar.play({ channel: channelNo, layer: 1, clip: source.url });
  state.activeSourceId = source.id;
  state.activeSourceLabel = source.label;

  // The consumer captures the channel's output continuously, so it only needs
  // to be (re)created when there isn't one yet, or when the active channel's
  // RTMP target has changed (a channel-profile switch).
  if (state.streamConsumerActive && state.streamConsumerTarget === channel.rtmpTarget) {
    console.log(`[Stream] Active Feed: ${source.url}`);
    return source;
  }

  if (state.streamConsumerActive) {
    try {
      await caspar.sendCustom({ command: `REMOVE ${channelNo}-${STREAM_CONSUMER_INDEX}` });
    } catch (err) {
      console.error('[Stream] Failed to remove previous STREAM consumer (continuing anyway):', err.message);
    }
  }

  // The classic AMCP ADD command uses the "STREAM" consumer keyword (not "FFMPEG"),
  // and CasparCG's own output-format override flag really is "-format" (confirmed against
  // the live server log: "-f flv" leaves the muxer unset and throws "Unable to choose an
  // output format"). Do not "fix" this back to "-f".
  // CasparCG 2.5.0's ffmpeg consumer only applies options given with ffmpeg's modern
  // "-key:v"/"-key:a" stream-specifier syntax; the legacy "-vcodec"/"-acodec"/"-preset"/"-g"
  // (no specifier) are silently dropped ("Unused option" in caspar's log), which fell back to
  // FLV's ancient defaults: Sorenson H.263 video (MediaMTX: "unsupported video codec: 2") and
  // mp2/mp3 audio.
  // It also hands the audio encoder the raw 16-channel ("hexadecagonal") mixer layout
  // regardless of "-ac"/"-channel_layout"/"-af", so an explicit ffmpeg "pan" filter via
  // "-filter:a" is required to force a hard stereo downmix (see CasparCG forum "Stream
  // (preview) in CasparCG 2.5.0").
  // "-bf:v 0" disables B-frames: MediaMTX's WebRTC output rejects H264 streams that have them.
  // "-filter:v format=yuv420p" forces standard 4:2:0 chroma before encoding: without it,
  // libx264 auto-selects "High 4:4:4 Predictive" profile from whatever CasparCG's OpenGL
  // pipeline hands it, which most real decoders (confirmed: VLC - opens the stream fine,
  // renders a black screen forever) don't support, even though browsers' HLS.js/MSE
  // decode path tolerated it, which is why this went unnoticed all night. Plain "-pix_fmt"
  // is silently dropped the same way the legacy codec flags are - it has to go through
  // "-filter:v" the same way the audio downmix has to go through "-filter:a".
  //
  // Uses sendCustom (the v7 casparcg-connection replacement for the removed .custom())
  // with an explicit "channel-100" index rather than the typed add() method, so the
  // consumer can be reliably targeted again later by REMOVE when switching channels -
  // add() has no way to specify an index and CasparCG never reports back the
  // auto-assigned one.
  await caspar.sendCustom({
    command: `ADD ${channelNo}-${STREAM_CONSUMER_INDEX} STREAM "${channel.rtmpTarget}" -codec:v libx264 -preset:v superfast -tune:v zerolatency -filter:v format=yuv420p -bf:v 0 -g:v 50 -b:v 4000k -codec:a aac -b:a 128k -filter:a pan=stereo|c0=c0|c1=c1 -format flv`
  });

  state.streamConsumerActive = true;
  state.streamConsumerTarget = channel.rtmpTarget;
  console.log(`[Stream] Active Feed: ${source.url}`);
  console.log(`[Output] Pushing RTMP to: ${channel.rtmpTarget}`);
  return source;
}

// --- CHANNEL MANAGEMENT ---

/**
 * GET /api/channels
 * All saved channel profiles with their sources and branding presets, for
 * the management UI.
 */
app.get('/api/channels', async (req, res) => {
  const channels = await Channel.findAll({
    include: [{ model: Source }, { model: BrandingPreset }],
    order: [['id', 'ASC'], [Source, 'priority', 'ASC']]
  });
  res.json(channels);
});

/**
 * POST /api/channels
 * Body: { name, rtmpTarget, casparChannelNumber?, sources: [{label, url, priority}] }
 */
function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'channel';
}

async function generateRtmpTarget(name) {
  const base = slugify(name);
  let path = base;
  let n = 2;
  // Guard against two channels pushing to the same MediaMTX path, which would
  // have one silently kick the other off (RTMP is single-publisher-per-path).
  while (await Channel.findOne({ where: { rtmpTarget: `rtmp://127.0.0.1:1935/live/${path}` } })) {
    path = `${base}_${n++}`;
  }
  return `rtmp://127.0.0.1:1935/live/${path}`;
}

app.post('/api/channels', async (req, res) => {
  const { name, sources } = req.body || {};
  let { rtmpTarget, casparChannelNumber } = req.body || {};
  if (!name) {
    return res.status(400).json({ status: 'error', message: '"name" is required' });
  }
  try {
    // rtmpTarget is optional - MediaMTX creates paths on demand for any name
    // (confirmed: no per-path config needed), so a channel only strictly needs
    // its input sources; the output path can just be derived from its name.
    if (!rtmpTarget) rtmpTarget = await generateRtmpTarget(name);
    const channel = await Channel.create({ name, rtmpTarget, casparChannelNumber: casparChannelNumber || 1 });
    if (Array.isArray(sources) && sources.length > 0) {
      await Source.bulkCreate(sources.map((s, i) => ({
        channelId: channel.id,
        label: s.label || `Source ${i + 1}`,
        url: s.url,
        priority: s.priority ?? i
      })));
    }
    const full = await Channel.findByPk(channel.id, { include: [Source, BrandingPreset] });
    res.json(full);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * PUT /api/channels/:id
 * Body: any of { name, rtmpTarget, casparChannelNumber }
 */
app.put('/api/channels/:id', async (req, res) => {
  const channel = await Channel.findByPk(req.params.id);
  if (!channel) return res.status(404).json({ status: 'error', message: 'Channel not found' });
  const { name, rtmpTarget, casparChannelNumber } = req.body || {};
  await channel.update({
    ...(name !== undefined && { name }),
    ...(rtmpTarget !== undefined && { rtmpTarget }),
    ...(casparChannelNumber !== undefined && { casparChannelNumber })
  });
  res.json(channel);
});

/**
 * DELETE /api/channels/:id
 */
app.delete('/api/channels/:id', async (req, res) => {
  const channel = await Channel.findByPk(req.params.id);
  if (!channel) return res.status(404).json({ status: 'error', message: 'Channel not found' });
  if (channel.isActive) {
    return res.status(400).json({ status: 'error', message: 'Cannot delete the active channel - activate a different one first' });
  }
  await channel.destroy(); // cascades to Sources/BrandingPresets
  res.json({ status: 'success' });
});

/**
 * GET /api/channels/active
 * The full active channel record (with sources/presets), for the frontend to
 * build its per-channel controls.
 */
app.get('/api/channels/active', async (req, res) => {
  const channel = await getActiveChannel();
  if (!channel) return res.status(404).json({ status: 'error', message: 'No active channel' });
  const full = await Channel.findByPk(channel.id, { include: [Source, BrandingPreset] });
  res.json(full);
});

/**
 * POST /api/channels/:id/activate
 * Switches which channel profile is live: clears the previously active
 * channel's output, marks this one active, and auto-plays its top-priority
 * source (attaching/repointing the STREAM consumer as needed).
 */
app.post('/api/channels/:id/activate', async (req, res) => {
  try {
    const channel = await Channel.findByPk(req.params.id, { include: [Source] });
    if (!channel) return res.status(404).json({ status: 'error', message: 'Channel not found' });

    const previouslyActive = await Channel.findOne({ where: { isActive: true } });
    if (previouslyActive && previouslyActive.id !== channel.id) {
      await caspar.clear({ channel: previouslyActive.casparChannelNumber });
      await Channel.update({ isActive: false }, { where: { isActive: true } });
    }
    await channel.update({ isActive: true });

    state.activeChannelId = channel.id;
    state.activeChannelName = channel.name;
    state.activeSourceId = null;
    state.activeSourceLabel = null;
    for (const key of Object.keys(state.activeGraphics)) state.activeGraphics[key] = false;

    resetFailoverTracking();
    const topSource = [...channel.Sources].sort((a, b) => a.priority - b.priority)[0];
    if (topSource) await playSourceById(topSource.id);
    await applyDefaultPresets(channel.id);

    console.log(`[Channel] Activated "${channel.name}"`);
    res.json({ status: 'success', channelId: channel.id });
  } catch (err) {
    state.lastError = err.message;
    console.error('[Channel Activate Error]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- SOURCE MANAGEMENT ---

/**
 * POST /api/channels/:id/sources
 * Body: { label, url, priority? }
 * Sources can be any URL format CasparCG's ffmpeg producer can open (SRT,
 * RTMP, RTSP, HTTP(S), etc.) - the protocol is read from the URL itself, so
 * nothing here needs to know or validate which kind of source it is.
 */
app.post('/api/channels/:id/sources', async (req, res) => {
  const { label, url, priority } = req.body || {};
  if (!label || !url) return res.status(400).json({ status: 'error', message: '"label" and "url" are required' });
  const channel = await Channel.findByPk(req.params.id);
  if (!channel) return res.status(404).json({ status: 'error', message: 'Channel not found' });
  const source = await Source.create({ channelId: channel.id, label, url, priority: priority ?? 0 });
  res.json(source);
});

/**
 * PUT /api/sources/:id
 * Body: any of { label, url, priority }
 */
app.put('/api/sources/:id', async (req, res) => {
  const source = await Source.findByPk(req.params.id);
  if (!source) return res.status(404).json({ status: 'error', message: 'Source not found' });
  const { label, url, priority } = req.body || {};
  await source.update({
    ...(label !== undefined && { label }),
    ...(url !== undefined && { url }),
    ...(priority !== undefined && { priority })
  });
  res.json(source);
});

/**
 * DELETE /api/sources/:id
 */
app.delete('/api/sources/:id', async (req, res) => {
  const source = await Source.findByPk(req.params.id);
  if (!source) return res.status(404).json({ status: 'error', message: 'Source not found' });

  if (Number(source.id) === Number(state.activeSourceId)) {
    return res.status(400).json({ status: 'error', message: 'Cannot delete the currently playing source - switch to a different one first' });
  }
  const siblingCount = await Source.count({ where: { channelId: source.channelId } });
  if (siblingCount <= 1) {
    return res.status(400).json({ status: 'error', message: 'Cannot delete the only source on a channel' });
  }

  await source.destroy();
  res.json({ status: 'success' });
});

// --- PLAYOUT ---

/**
 * POST /api/stream/play
 * Body: { "sourceId": number }
 */
app.post('/api/stream/play', async (req, res) => {
  const { sourceId } = req.body || {};
  if (!sourceId) return res.status(400).json({ status: 'error', message: '"sourceId" is required' });
  try {
    resetFailoverTracking();
    const source = await playSourceById(sourceId);
    res.json({ status: 'success', activeStream: source.url, sourceId: source.id, label: source.label });
  } catch (err) {
    state.lastError = err.message;
    console.error('[Stream Error]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/status
 * Current server-side state, for the UI status bar.
 */
app.get('/api/status', (req, res) => {
  res.json(state);
});

/**
 * POST /api/graphic/show
 * Body: { "template": "lower_third" | "logo_bug" | "ticker", "data": {...} }
 */
app.post('/api/graphic/show', async (req, res) => {
  const templateKey = req.body?.template || 'lower_third';
  const template = TEMPLATES[templateKey];
  if (!template) return res.status(400).json({ status: 'error', message: `Unknown template "${templateKey}"` });
  const data = { ...template.defaultData, ...(req.body?.data || {}) };

  try {
    const channel = await getActiveChannel();
    if (!channel) throw new Error('No active channel');
    await caspar.cgAdd({ channel: channel.casparChannelNumber, layer: template.layer, template: template.path, playOnLoad: true, data });

    state.activeGraphics[templateKey] = true;
    console.log(`[Graphic] "${templateKey}" shown:`, data);
    res.json({ status: 'success', template: templateKey, data });
  } catch (err) {
    state.lastError = err.message;
    console.error('[Graphic Error]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/graphic/hide
 * Body: { "template": "lower_third" | "logo_bug" | "ticker" }
 */
app.post('/api/graphic/hide', async (req, res) => {
  const templateKey = req.body?.template || 'lower_third';
  const template = TEMPLATES[templateKey];
  if (!template) return res.status(400).json({ status: 'error', message: `Unknown template "${templateKey}"` });

  try {
    const channel = await getActiveChannel();
    if (!channel) throw new Error('No active channel');
    await caspar.cgStop({ channel: channel.casparChannelNumber, layer: template.layer });

    state.activeGraphics[templateKey] = false;
    console.log(`[Graphic] "${templateKey}" hidden`);
    res.json({ status: 'success', template: templateKey, message: 'Graphic removed' });
  } catch (err) {
    state.lastError = err.message;
    console.error('[Graphic Error]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- BRANDING PRESETS ---

/**
 * POST /api/channels/:id/presets
 * Body: { name, template, data }
 * Saves the given data as a reusable, named preset for one CG template.
 */
app.post('/api/channels/:id/presets', async (req, res) => {
  const { name, template, data } = req.body || {};
  if (!name || !template || !data) return res.status(400).json({ status: 'error', message: '"name", "template" and "data" are required' });
  if (!TEMPLATES[template]) return res.status(400).json({ status: 'error', message: `Unknown template "${template}"` });
  const channel = await Channel.findByPk(req.params.id);
  if (!channel) return res.status(404).json({ status: 'error', message: 'Channel not found' });
  const preset = await BrandingPreset.create({ channelId: channel.id, name, template, data });
  res.json(preset);
});

/**
 * DELETE /api/presets/:id
 */
app.delete('/api/presets/:id', async (req, res) => {
  const preset = await BrandingPreset.findByPk(req.params.id);
  if (!preset) return res.status(404).json({ status: 'error', message: 'Preset not found' });
  await preset.destroy();
  res.json({ status: 'success' });
});

/**
 * POST /api/presets/:id/set-default
 * Body: { "isDefault": true | false }
 * Marks (or unmarks) this preset as the one auto-applied for its template
 * whenever this channel is activated or CasparCG reconnects. At most one
 * default per (channel, template) - setting a new one clears any previous.
 */
app.post('/api/presets/:id/set-default', async (req, res) => {
  const preset = await BrandingPreset.findByPk(req.params.id);
  if (!preset) return res.status(404).json({ status: 'error', message: 'Preset not found' });
  const isDefault = req.body?.isDefault !== false;

  if (isDefault) {
    await BrandingPreset.update(
      { isDefault: false },
      { where: { channelId: preset.channelId, template: preset.template } }
    );
  }
  await preset.update({ isDefault });
  res.json({ status: 'success', id: preset.id, isDefault });
});

/**
 * POST /api/presets/:id/apply
 * Shows the preset's saved data on its template's layer, on the active channel.
 */
app.post('/api/presets/:id/apply', async (req, res) => {
  const preset = await BrandingPreset.findByPk(req.params.id);
  if (!preset) return res.status(404).json({ status: 'error', message: 'Preset not found' });
  const template = TEMPLATES[preset.template];
  if (!template) return res.status(400).json({ status: 'error', message: `Unknown template "${preset.template}"` });

  try {
    const channel = await getActiveChannel();
    if (!channel) throw new Error('No active channel');
    await caspar.cgAdd({ channel: channel.casparChannelNumber, layer: template.layer, template: template.path, playOnLoad: true, data: preset.data });

    state.activeGraphics[preset.template] = true;
    console.log(`[Preset] "${preset.name}" (${preset.template}) applied`);
    res.json({ status: 'success', template: preset.template, data: preset.data });
  } catch (err) {
    state.lastError = err.message;
    console.error('[Preset Error]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/stream/clear
 */
app.post('/api/stream/clear', async (req, res) => {
  try {
    const channel = await getActiveChannel();
    if (!channel) throw new Error('No active channel');
    // CLEAR stops all producers on the channel (the source, the CG graphics) but
    // does not remove consumers, so the STREAM consumer stays attached and keeps
    // pushing to MediaMTX - it'll just be encoding black/silence until something
    // plays again.
    await caspar.clear({ channel: channel.casparChannelNumber });
    state.activeSourceId = null;
    state.activeSourceLabel = null;
    for (const key of Object.keys(state.activeGraphics)) state.activeGraphics[key] = false;
    res.json({ status: 'success', message: 'Channel cleared' });
  } catch (err) {
    state.lastError = err.message;
    console.error('[Clear Error]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- CLOUD STREAMS (any stream source -> HLS via the VM's MediaMTX) ---
// Each CloudStream pairs a source URL (udp://, srt://, rtmp(s)://, rtsp://,
// http(s)://) with a per-stream ffmpeg container on the cloud VM (see
// vm-control.js), which republishes it as RTMP into the VM's MediaMTX,
// exposed there as HLS. This is independent of the local CasparCG/Channel
// pipeline above - it's for taking a raw feed (e.g. a multicast broadcast/
// IPTV source) and handing out an HLS link that any other system can pull.

async function generateCloudSlug(name) {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (await CloudStream.findOne({ where: { slug } })) {
    slug = `${base}_${n++}`;
  }
  return slug;
}

/**
 * GET /api/cloud-streams/vm-status
 * Whether the cloud VM is reachable at all right now, independent of any
 * saved stream - GET /api/cloud-streams alone can't answer this when the
 * list is empty, since it has no slugs to check and skips the VM entirely.
 * Registered before the "/:id/..." routes below only for readability; Express
 * wouldn't actually confuse "vm-status" with an :id segment either way since
 * this path has no trailing segment for those routes to match against.
 */
app.get('/api/cloud-streams/vm-status', async (req, res) => {
  const reachable = await vmControl.isReachable();
  res.json({ reachable });
});

/**
 * GET /api/cloud-streams
 * Saved streams plus their live running status, queried fresh from the VM on
 * every call. If the VM can't be reached, "running" comes back null for every
 * stream rather than failing the whole request - the list itself is still
 * useful even when the VM is temporarily unreachable.
 */
app.get('/api/cloud-streams', async (req, res) => {
  const streams = await CloudStream.findAll({ order: [['id', 'ASC']] });
  let statusBySlug = {};
  try {
    statusBySlug = await vmControl.getStatus(streams.map((s) => s.slug));
  } catch (err) {
    console.error('[CloudStream] Could not reach VM for status:', err.message);
  }
  res.json(streams.map((s) => ({
    ...s.toJSON(),
    // hlsUrl kept for anything already reading it; hlsUrls carries both
    // variants (lan always, tailscale only if MEDIAMTX_HLS_BASE_TAILSCALE
    // is configured - see vm-control.js).
    hlsUrl: vmControl.hlsUrl(s.slug),
    hlsUrls: vmControl.hlsUrls(s.slug),
    running: s.slug in statusBySlug ? statusBySlug[s.slug] : null
  })));
});

/**
 * POST /api/cloud-streams
 * Body: { name, sourceUrl, program? } - sourceUrl may be udp://, srt://,
 * rtmp(s)://, rtsp://, or http(s)://. "program" is optional and only
 * meaningful for a udp:// source that bundles several TV services into one
 * multicast address - see the comment on vm-control.js's startIngest().
 * Starts the VM-side ingest first and only saves the record if that
 * succeeds, so there's never a saved stream with no actual container behind it.
 */
app.post('/api/cloud-streams', async (req, res) => {
  const { name, sourceUrl, program } = req.body || {};
  if (!name || !sourceUrl) return res.status(400).json({ status: 'error', message: '"name" and "sourceUrl" are required' });
  try {
    const slug = await generateCloudSlug(name);
    await vmControl.startIngest(slug, sourceUrl, program);
    const stream = await CloudStream.create({ name, slug, sourceUrl });
    console.log(`[CloudStream] Started ingest "${name}" (${slug}) -> ${vmControl.hlsUrl(slug)}`);
    res.json({ ...stream.toJSON(), hlsUrl: vmControl.hlsUrl(slug), hlsUrls: vmControl.hlsUrls(slug) });
  } catch (err) {
    console.error('[CloudStream] Failed to start ingest:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/cloud-streams/:id/stop
 */
app.post('/api/cloud-streams/:id/stop', async (req, res) => {
  const stream = await CloudStream.findByPk(req.params.id);
  if (!stream) return res.status(404).json({ status: 'error', message: 'Stream not found' });
  try {
    await vmControl.stopIngest(stream.slug);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/cloud-streams/:id/start
 * Resumes a previously-stopped ingest container (does not recreate it - use
 * DELETE then re-create the stream if the UDP source itself changed).
 */
app.post('/api/cloud-streams/:id/start', async (req, res) => {
  const stream = await CloudStream.findByPk(req.params.id);
  if (!stream) return res.status(404).json({ status: 'error', message: 'Stream not found' });
  try {
    await vmControl.resumeIngest(stream.slug);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/cloud-streams/:id
 * Removes the container on the VM first, but still deletes the local record
 * even if that fails (e.g. VM unreachable) - the user asked for it gone from
 * their list; a container orphaned on an unreachable VM needs manual cleanup
 * either way, and it can't stay in a list with no way to remove it.
 */
app.delete('/api/cloud-streams/:id', async (req, res) => {
  const stream = await CloudStream.findByPk(req.params.id);
  if (!stream) return res.status(404).json({ status: 'error', message: 'Stream not found' });
  try {
    await vmControl.removeIngest(stream.slug);
  } catch (err) {
    console.error('[CloudStream] Failed to remove container on VM (deleting record anyway):', err.message);
  }
  await stream.destroy();
  res.json({ status: 'success' });
});

// --- PROCESS SUPERVISION ---
// CasparCG and MediaMTX run as child processes of this dashboard (see
// process-manager.js and their startup in start() below) instead of separate
// terminal windows, so their live output can be shown in the browser and so
// there's one reliable place to kill CasparCG's whole CEF process tree on
// restart. The dashboard itself is the long-running supervisor here and
// doesn't restart itself - only its two children do.

/**
 * POST /api/system/restart
 * Body: { "target": "casparcg" | "mediamtx" } - restarts just that one.
 */
app.post('/api/system/restart', async (req, res) => {
  const target = req.body?.target;
  if (target !== 'casparcg' && target !== 'mediamtx') {
    return res.status(400).json({ status: 'error', message: '"target" must be "casparcg" or "mediamtx"' });
  }
  console.log(`[System] Restart requested for ${target}`);
  try {
    if (target === 'casparcg') {
      // Recovery itself happens generically in caspar.on('connect', ...) above,
      // triggered by the actual reconnection rather than a fixed delay guess -
      // this handler only needs to do the process-level restart.
      await procManager.restartProcess('casparcg', { preStart: () => procManager.clearCasparCefLock(CASPAR_DIR) });
    } else {
      // MediaMTX restarting drops CasparCG's outbound RTMP connection; CasparCG
      // doesn't retry it on its own (confirmed live: the consumer throws and
      // silently disappears from the channel, but the dashboard's own
      // streamConsumerActive flag doesn't know that either) - the source itself
      // is untouched, so just re-establish the consumer against it.
      await procManager.restartProcess('mediamtx');
      await sleep(2000);
      state.streamConsumerActive = false;
      if (state.activeSourceId) await playSourceById(state.activeSourceId);
    }
    res.json({ status: 'success' });
  } catch (err) {
    console.error('[System] Restart error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/system/status
 * Whether each managed child process is currently running.
 */
app.get('/api/system/status', (req, res) => {
  res.json({
    casparcg: procManager.isRunning('casparcg'),
    mediamtx: procManager.isRunning('mediamtx')
  });
});

/**
 * GET /api/logs/stream (Server-Sent Events)
 * Sends the buffered recent history for all three log sources (dashboard,
 * casparcg, mediamtx) immediately on connect, then streams new lines live.
 */
app.get('/api/logs/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  for (const entry of procManager.getAllBuffered()) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const unsubscribe = procManager.onLog((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  req.on('close', unsubscribe);
});

// Explicit Root Route Catch
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SOURCE FAILOVER WATCHDOG ---
//
// caspar.play() only rejects for immediate connection failures. A source that
// dies mid-broadcast (e.g. the SRT I/O error seen on the primary feed tonight,
// which surfaces ~3s *after* CasparCG already ACKed the PLAY command) never
// throws anywhere the dashboard can see it. The only reliable signal is
// INFO LAYER's foreground.file[].time[0] (current playback position, verified
// live: it advances continuously on a healthy feed) - if it stops advancing,
// the source has stalled. Sources are read fresh from the active channel on
// every tick, so adding/reordering sources takes effect immediately.
const WATCHDOG_INTERVAL_MS = 6000;
const STALL_THRESHOLD = 2; // consecutive non-advancing polls (~12s) before failing over
const ALL_DOWN_COOLDOWN_MS = 60000; // pause after cycling through every source with no luck

let lastPlaybackTime = null;
let stallTicks = 0;
let watchdogPausedUntil = 0;
let failoverStartSourceId = null; // detects a full cycle back to where we started

// Must be called on every *manual* source change (an explicit /api/stream/play
// or a channel activation) - not from within the watchdog's own cascade. Stale
// tracking state left over from a previous channel/source otherwise corrupts
// the "have we cycled through everything" check: it was observed live tonight
// switching a single-source channel to itself in a loop instead of correctly
// pausing, because failoverStartSourceId still held an id from the channel
// that was active before the switch.
function resetFailoverTracking() {
  lastPlaybackTime = null;
  stallTicks = 0;
  failoverStartSourceId = null;
  watchdogPausedUntil = 0;
}

async function checkSourceHealth() {
  if (!state.activeSourceId || Date.now() < watchdogPausedUntil) return;

  const channel = await getActiveChannel().catch(() => null);
  if (!channel) return;

  let response;
  try {
    const sendResult = await caspar.infoLayer({ channel: channel.casparChannelNumber, layer: 1 });
    if (sendResult.error) throw sendResult.error;
    response = await sendResult.request;
  } catch (err) {
    return; // CasparCG unreachable - the connect/disconnect events already track that
  }

  const layer = response?.data?.channel?.layers?.[0];
  const currentTime = layer?.foreground?.file?.[0]?.time?.[0];
  const producer = layer?.foreground?.producer?.[0];

  const stalled = producer !== 'ffmpeg' || currentTime === undefined || currentTime === lastPlaybackTime;
  lastPlaybackTime = currentTime;

  if (!stalled) {
    stallTicks = 0;
    failoverStartSourceId = null;
    return;
  }

  stallTicks += 1;
  if (stallTicks < STALL_THRESHOLD) return;

  // Confirmed stalled - fail over to the next source in rotation, ordered by priority.
  stallTicks = 0;
  lastPlaybackTime = null;
  if (failoverStartSourceId === null) failoverStartSourceId = state.activeSourceId;

  const ordered = [...channel.Sources].sort((a, b) => a.priority - b.priority);
  const currentIndex = ordered.findIndex((s) => s.id === state.activeSourceId);
  const next = ordered[(currentIndex + 1) % ordered.length];

  if (!next || next.id === failoverStartSourceId) {
    console.error('[Failover] All configured sources appear to be down - pausing auto-failover for 60s');
    watchdogPausedUntil = Date.now() + ALL_DOWN_COOLDOWN_MS;
    failoverStartSourceId = null;
    return;
  }

  console.error(`[Failover] "${state.activeSourceLabel}" stalled - switching to "${next.label}"`);
  try {
    await playSourceById(next.id);
  } catch (err) {
    state.lastError = err.message;
    console.error('[Failover Error]', err);
  }
}

setInterval(checkSourceHealth, WATCHDOG_INTERVAL_MS);

// --- STARTUP ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start() {
  // Broad, name-based cleanup first: catches any stray casparcg.exe/mediamtx.exe
  // left running from before this dashboard process existed (e.g. a previous
  // crash), the same guarantee start-all.bat used to provide. Routine
  // stop/restart afterwards targets this dashboard's own tracked PID instead.
  console.log('[Startup] Clearing any leftover CasparCG/MediaMTX processes...');
  await procManager.killAllByImageName('casparcg.exe');
  await procManager.killAllByImageName('mediamtx.exe');
  procManager.clearCasparCefLock(CASPAR_DIR);
  await sleep(1000);

  console.log('[Startup] Starting MediaMTX...');
  procManager.startProcess('mediamtx', path.join(MEDIAMTX_DIR, 'mediamtx.exe'), MEDIAMTX_DIR);
  await sleep(1500);

  console.log('[Startup] Starting CasparCG Server...');
  procManager.startProcess('casparcg', path.join(CASPAR_DIR, 'casparcg.exe'), CASPAR_DIR);
  await sleep(1500);

  await sequelize.authenticate();
  const channel = await getActiveChannel();
  if (channel) {
    state.activeChannelId = channel.id;
    state.activeChannelName = channel.name;
    // Pre-set the source we intend to play (without playing it yet - CasparCG
    // isn't necessarily reachable this instant). caspar.on('connect', ...)
    // above already knows how to (re)establish whatever state.activeSourceId
    // points at, including applying that channel's default presets, so a
    // fully fresh boot recovers the exact same way a mid-session reconnect
    // does - no separate "first boot" logic needed.
    const topSource = [...channel.Sources].sort((a, b) => a.priority - b.priority)[0];
    if (topSource) state.activeSourceId = topSource.id;
  } else {
    console.warn('[Startup] No active channel found in the database - run "node db/seed.js" first.');
  }

  app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(` AMCP Controller Engine Running on http://localhost:${PORT}`);
    console.log(`==================================================\n`);
  });
}

// Clean up managed children on a graceful dashboard shutdown (Ctrl+C, or being
// stopped normally) so they don't linger as orphans needing a manual taskkill.
async function shutdown() {
  console.log('[Shutdown] Stopping managed CasparCG/MediaMTX processes...');
  await procManager.stopProcess('casparcg');
  await procManager.stopProcess('mediamtx');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('[Startup] Failed:', err);
  process.exit(1);
});
