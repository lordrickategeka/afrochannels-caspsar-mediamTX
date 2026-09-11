// Controls the cloud MediaMTX VM over SSH: each "cloud stream" is a UDP
// source ingested by a dedicated ffmpeg container on the VM (named
// "ingest-<slug>"), which republishes it as RTMP into the VM's own MediaMTX,
// which in turn exposes it as HLS. See CloudStream model / server.js for the
// dashboard-side half of this.
//
// A fresh SSH connection is opened and disposed per call rather than kept
// alive - this is an occasional admin action (creating/stopping a handful of
// streams), not a hot path, so the extra connect latency isn't worth the
// complexity of managing a persistent connection/reconnect lifecycle.
const { NodeSSH } = require('node-ssh');

const VM_HOST = process.env.VM_HOST;
const VM_SSH_PORT = Number(process.env.VM_SSH_PORT) || 22;
const VM_SSH_USER = process.env.VM_SSH_USER;
const VM_SSH_KEY_PATH = process.env.VM_SSH_KEY_PATH;
const VM_SSH_PASSWORD = process.env.VM_SSH_PASSWORD;
const MEDIAMTX_PUBLISH_USER = process.env.MEDIAMTX_PUBLISH_USER || 'syscg-publisher';
const MEDIAMTX_PUBLISH_PASSWORD = process.env.MEDIAMTX_PUBLISH_PASSWORD;
const MEDIAMTX_HLS_BASE = process.env.MEDIAMTX_HLS_BASE;
// Optional second base for the same MediaMTX HLS listener, reached over
// Tailscale instead of the LAN - both work simultaneously since MediaMTX
// binds 0.0.0.0:8888, so the same path is valid on either host. Useful when
// the dashboard is browsed from a LAN address but the link needs to go to
// someone off that LAN. Unset = that variant simply isn't offered.
const MEDIAMTX_HLS_BASE_TAILSCALE = process.env.MEDIAMTX_HLS_BASE_TAILSCALE;

// Source URLs are user-submitted from the dashboard UI and get interpolated
// straight into a remote shell command below - this allow-list (scheme +
// the character set real stream URLs use, including credentials embedded as
// user:pass@host) is what stands between that and shell/command injection on
// the VM, so it must stay strict rather than just checking for a known
// prefix. ffmpeg's "-i" reads all of these the same way, so any of them work
// as a Cloud Stream source, not just UDP.
const SAFE_SOURCE_URL_RE = /^(udp|srt|rtmp|rtmps|rtsp|http|https):\/\/[A-Za-z0-9.\-:/?=&@%_+]+$/;
// Slugs are always derived from Channel-style slugify() before reaching here,
// but re-checked at the point they're interpolated into shell commands too.
const SAFE_SLUG_RE = /^[a-z0-9_]+$/;

function assertSafeSourceUrl(sourceUrl) {
  if (typeof sourceUrl !== 'string' || !SAFE_SOURCE_URL_RE.test(sourceUrl)) {
    throw new Error('Invalid source URL - expected udp://, srt://, rtmp://, rtmps://, rtsp://, http:// or https://');
  }
}

// ffmpeg input-side options, which have to precede "-i".
//
// analyzeduration/probesize are ceilings rather than fixed delays - ffmpeg
// stops probing the moment it has identified the streams - so raising them
// only costs time on sources that are genuinely slow to describe themselves,
// notably MPEG-TS over multicast where the PAT/PMT tables may not arrive in
// the first few hundred KB. Left at the default, those sources either take a
// long time to start or fail outright with "could not find codec parameters".
//
// "+genpts+discardcorrupt" is limited to udp:// on purpose: plain multicast
// has no retransmission, so loss arrives as corrupt packets and holes in the
// timestamps, and dropping those beats feeding them to the muxer. The other
// schemes are either TCP-based or (SRT) recover loss themselves, so they keep
// ffmpeg's default handling rather than silently discarding data.
function inputFlags(sourceUrl) {
  const flags = ['-analyzeduration 10000000', '-probesize 10000000'];
  if (sourceUrl.startsWith('udp://')) {
    flags.push('-fflags +genpts+discardcorrupt');
  }
  return flags.join(' ');
}

// A UDP input that goes quiet makes ffmpeg block forever rather than exit -
// verified on this VM: a container froze mid-stream for hours because
// "restart: unless-stopped" only helps once ffmpeg actually exits. Appending
// "timeout" (microseconds) to the URL if the caller didn't already set one
// makes ffmpeg error out after 10s of silence instead, so Docker's restart
// policy can recover it once the source comes back.
function withUdpTimeout(sourceUrl) {
  if (!sourceUrl.startsWith('udp://') || /[?&]timeout=/.test(sourceUrl)) {
    return sourceUrl;
  }
  return sourceUrl + (sourceUrl.includes('?') ? '&' : '?') + 'timeout=10000000';
}

function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || !SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid stream slug "${slug}"`);
  }
}

function assertConfigured() {
  if (!VM_HOST || !VM_SSH_USER) {
    throw new Error('VM_HOST and VM_SSH_USER must be set in .env to control the cloud MediaMTX VM');
  }
  if (!VM_SSH_KEY_PATH && !VM_SSH_PASSWORD) {
    throw new Error('Set VM_SSH_KEY_PATH or VM_SSH_PASSWORD in .env for VM SSH authentication');
  }
  if (!MEDIAMTX_PUBLISH_PASSWORD) {
    throw new Error('MEDIAMTX_PUBLISH_PASSWORD must be set in .env, matching the VM\'s mediamtx.yml authInternalUsers entry');
  }
  if (!MEDIAMTX_HLS_BASE) {
    throw new Error('MEDIAMTX_HLS_BASE must be set in .env, e.g. http://192.168.28.77:8888');
  }
}

async function withConnection(fn, { readyTimeout } = {}) {
  assertConfigured();
  const ssh = new NodeSSH();
  const config = { host: VM_HOST, port: VM_SSH_PORT, username: VM_SSH_USER };
  if (readyTimeout) config.readyTimeout = readyTimeout;
  if (VM_SSH_KEY_PATH) config.privateKeyPath = VM_SSH_KEY_PATH;
  else config.password = VM_SSH_PASSWORD;

  await ssh.connect(config);
  try {
    return await fn(ssh);
  } finally {
    ssh.dispose();
  }
}

function containerName(slug) {
  assertSafeSlug(slug);
  return `ingest-${slug}`;
}

function hlsUrl(slug) {
  assertSafeSlug(slug);
  return `${MEDIAMTX_HLS_BASE}/live/${slug}/index.m3u8`;
}

// All configured HLS link variants for a slug - currently just the LAN one
// (always present) and, if MEDIAMTX_HLS_BASE_TAILSCALE is set, a second link
// over Tailscale to the same path. tailscale is null rather than omitted so
// callers don't need an "in" check to know it wasn't configured.
function hlsUrls(slug) {
  return {
    lan: hlsUrl(slug),
    tailscale: MEDIAMTX_HLS_BASE_TAILSCALE
      ? `${MEDIAMTX_HLS_BASE_TAILSCALE}/live/${slug}/index.m3u8`
      : null
  };
}

/**
 * Starts (or replaces) the ffmpeg ingest container for a stream source
 * (udp/srt/rtmp/rtmps/rtsp/http/https), pushing it into the VM's MediaMTX as
 * RTMP path "live/<slug>". Throws on a malformed source URL, unreachable VM,
 * or a failing docker command - callers should not create a CloudStream
 * record unless this resolves successfully.
 *
 * program (optional): for a udp:// source that is a multi-program transport
 * stream - one multicast address carrying several TV services at once, as
 * this deployment's headend does - selects which one via "-map 0:p:N".
 * Inspect a source first with:
 *   ffprobe -show_programs -of compact=p=0 "<the source URL>"
 * and read each program's "tag:service_name". Without it, ffmpeg falls back
 * to its own stream selection, which is not guaranteed to pair the video and
 * audio of the same service. Not persisted anywhere - like sourceUrl, it's
 * baked into the container's command at creation time; resumeIngest() only
 * starts/stops that same container, it never needs this again.
 */
async function startIngest(slug, sourceUrl, program) {
  assertSafeSlug(slug);
  assertSafeSourceUrl(sourceUrl);
  if (program !== undefined && !/^\d+$/.test(String(program))) {
    throw new Error('program must be a non-negative integer');
  }
  sourceUrl = withUdpTimeout(sourceUrl);
  const name = containerName(slug);
  // Credentials go in the query string, NOT as user:pass@host. MediaMTX reads
  // RTMP credentials only from the "user"/"pass" query parameters; the userinfo
  // form is ignored, the connection is treated as anonymous, and a server with
  // authInternalUsers configured rejects it. Verified against MediaMTX v1.21.0:
  // userinfo -> "failed to authenticate", query params -> "is publishing to".
  // encodeURIComponent matters twice over - it keeps a password containing URL
  // metacharacters intact, and it strips quotes that would otherwise break out
  // of the single-quoted shell argument this ends up inside.
  const rtmpUrl = `rtmp://127.0.0.1:1935/live/${slug}`
    + `?user=${encodeURIComponent(MEDIAMTX_PUBLISH_USER)}`
    + `&pass=${encodeURIComponent(MEDIAMTX_PUBLISH_PASSWORD)}`;

  // udp:// re-encodes video rather than copying it: this deployment's
  // headend never emits an H.264 IDR frame at all (measured over a 35s
  // window - SPS every ~2.3s, PPS every frame, zero IDR - gradual/intra
  // refresh instead). "-c:v copy" waits forever for a keyframe that never
  // arrives, so ffmpeg produces audio only, forever. libx264 with a fixed
  // GOP inserts real IDRs. Other schemes (srt/rtmp/rtsp/http) aren't known to
  // have this problem and copying is cheaper, so they keep the original
  // stream-copy path.
  const isUdp = sourceUrl.startsWith('udp://');
  const videoArgs = isUdp
    ? '-c:v libx264 -preset veryfast -tune zerolatency -g 50 -keyint_min 50 -sc_threshold 0 -pix_fmt yuv420p'
    : '-c:v copy';
  const mapArgs = program !== undefined ? `-map 0:p:${program}` : '';

  return withConnection(async (ssh) => {
    // "docker run --name" fails outright if a container by that name already
    // exists, even a stopped one - clear the way first (e.g. a previous
    // failed attempt, or re-creating with a new sourceUrl).
    await ssh.execCommand(`docker rm -f ${name}`);
    const cmd = [
      'docker run -d --network host',
      `--name ${name}`,
      '--restart unless-stopped',
      'linuxserver/ffmpeg',
      inputFlags(sourceUrl),
      `-i '${sourceUrl}'`,
      mapArgs,
      videoArgs,
      '-c:a aac -f flv',
      `'${rtmpUrl}'`
    ].filter(Boolean).join(' ');
    const result = await ssh.execCommand(cmd);
    if (result.code !== 0) {
      throw new Error(result.stderr || `docker run exited with code ${result.code}`);
    }
    return { containerName: name, hlsUrl: hlsUrl(slug) };
  });
}

async function stopIngest(slug) {
  const name = containerName(slug);
  return withConnection((ssh) => ssh.execCommand(`docker stop ${name}`));
}

async function resumeIngest(slug) {
  const name = containerName(slug);
  return withConnection((ssh) => ssh.execCommand(`docker start ${name}`));
}

async function removeIngest(slug) {
  const name = containerName(slug);
  return withConnection((ssh) => ssh.execCommand(`docker rm -f ${name}`));
}

// Short timeout for isReachable() specifically: it's a UI status indicator
// polled on a timer, so a dead/unreachable VM needs to fail fast (a few
// seconds) rather than hanging the poll for ssh2's ~20s default handshake
// timeout on every single tick.
const REACHABILITY_CHECK_TIMEOUT_MS = 6000;

/**
 * Quick "is the VM reachable at all" check, independent of any particular
 * CloudStream - unlike getStatus(), this doesn't skip the check just because
 * there happen to be zero saved streams. Never throws; returns true/false.
 */
async function isReachable() {
  try {
    await withConnection((ssh) => ssh.execCommand('echo ok'), { readyTimeout: REACHABILITY_CHECK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Live "is it running" status for a set of slugs, queried fresh from the VM
 * (never cached) so it can't drift from what docker actually reports.
 * Returns { [slug]: boolean }.
 */
async function getStatus(slugs) {
  if (!slugs.length) return {};
  return withConnection(async (ssh) => {
    const result = await ssh.execCommand('docker ps -a --filter "name=ingest-" --format "{{.Names}}|{{.Status}}"');
    const map = {};
    for (const line of result.stdout.split('\n')) {
      const [name, status] = line.split('|');
      if (!name) continue;
      map[name.replace(/^ingest-/, '')] = /^Up /.test(status || '');
    }
    return map;
  });
}

module.exports = { startIngest, stopIngest, resumeIngest, removeIngest, getStatus, isReachable, hlsUrl, hlsUrls, containerName };
