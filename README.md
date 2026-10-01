# Afro-channels

Playout and streaming control for NextMedia's Afro channels. There are two parts:

1. **Local playout (Windows)**: `amcp-dashboard`, a Node/Express web dashboard that drives
   **CasparCG Server 2.5** over AMCP. It switches channels and sources, overlays branding
   graphics, and pushes the result out through a local **MediaMTX**.
2. **Cloud ingest VM (Ubuntu + Docker)**: turns UDP/multicast TV feeds into HLS.
   ffmpeg re-encodes each feed and publishes it over RTMP to MediaMTX. MediaMTX serves it
   as HLS, and Caddy puts it on a public HTTPS domain. The dashboard manages these
   streams over SSH ("Cloud Streams").

```
                        ┌──────────────── Windows playout PC ────────────────┐
  Browser ──:3005──▶    │ amcp-dashboard (PM2)                               │
                        │   ├─ spawns/supervises CasparCG ──AMCP :5250       │
                        │   └─ spawns/supervises MediaMTX (local)            │
                        └──────────────────────┬─────────────────────────────┘
                                               │ SSH (vm-control.js)
                        ┌──────────────── Ingest VM (Docker) ────────────────┐
  Multicast LAN ──UDP─▶ │ ffmpeg "ingest-<slug>" ──RTMP──▶ MediaMTX ──HLS──▶ │──▶ Caddy (HTTPS)
                        │                         (:8888 on LAN and Tailscale)│
                        └────────────────────────────────────────────────────┘
```

## Repository layout

| Path | What it is |
|---|---|
| [amcp-dashboard/](amcp-dashboard/) | The dashboard: Express 5, SQLite through Sequelize, session login |
| [amcp-dashboard/server.js](amcp-dashboard/server.js) | HTTP API, CasparCG control, startup sequence |
| [amcp-dashboard/process-manager.js](amcp-dashboard/process-manager.js) | Spawns CasparCG and MediaMTX, restarts them, streams their logs to the browser |
| [amcp-dashboard/vm-control.js](amcp-dashboard/vm-control.js) | SSH control of the ingest VM (starts and stops per-stream ffmpeg containers) |
| [amcp-dashboard/db/](amcp-dashboard/db/) | Sequelize models (`User`, `Channel`, `Source`, `BrandingPreset`, `CloudStream`) and `seed.js` |
| [amcp-dashboard/public/](amcp-dashboard/public/) | Front end (`index.html`, `login.html`) and uploaded assets |
| [afro-logos/](afro-logos/) | Channel logo artwork |
| `casparcg-server-v2.5.0-stable-windows/` | CasparCG distribution. Only `casparcg.config`, the auto-restart script and `template/branding/` are tracked. |
| `mediamtx_v1.20.1_windows_amd64/` | Local MediaMTX. Only `mediamtx.yml` is tracked. |
| [start-all.bat](start-all.bat) / [stop-all.bat](stop-all.bat) | Start and stop the whole local stack |
| [docker-compose.cloud.yml](docker-compose.cloud.yml) | Ingest VM stack: MediaMTX, Caddy, and an optional static ffmpeg ingest |
| [mediamtx.cloud.yml](mediamtx.cloud.yml) | MediaMTX config for the VM. Holds a password placeholder. |
| [Caddyfile](Caddyfile) | Public HTTPS edge for the HLS output |
| [deploy.sh](deploy.sh) | Run on the VM to deploy the current `main` |
| [.env.vm.example](.env.vm.example) | Template for the VM's `.env` |

## Local playout setup (Windows)

### Installing on a new PC
You need Windows 10/11, [Node.js LTS](https://nodejs.org) (20 or newer) and
[Git](https://git-scm.com). An NVIDIA driver is optional; without it the Health tab
doesn't show GPU load.

```powershell
git clone https://github.com/lordrickategeka/afrochannels-caspsar-mediamTX.git Afro-channels
cd Afro-channels
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -AutoStart
```

[setup.ps1](setup.ps1) does the whole install:
1. Downloads **CasparCG 2.5.0** (about 234 MB) and **MediaMTX 1.20.1** and unpacks them
   into their folders. Interrupted downloads resume. Our own `casparcg.config`,
   `mediamtx.yml` and branding templates from git are never overwritten.
2. Installs the dashboard's Node dependencies (`npm ci`).
3. Creates `amcp-dashboard/.env` with a random `SESSION_SECRET`.
4. Creates the database, asks for an admin username and password, and adds **no
   channels**. You add those from the dashboard.
5. With `-AutoStart`, adds a Windows logon task that runs `start-all.bat`. It runs at
   logon rather than at boot because CasparCG's screen output needs a desktop session,
   so set the PC to sign in automatically if it must recover from a power cut by itself.

You can run it again safely: it skips anything already done and never touches an
existing `.env` or database. It refuses to run while the dashboard is up, so run
`stop-all.bat` first.

After setup:
- **Cloud Streams**: fill in the `VM_*` and `MEDIAMTX_*` values in
  `amcp-dashboard/.env` (see the table below) if you use that feature.
- **Firewall**: on first start, allow **Node.js** and **MediaMTX** through Windows
  Firewall. That lets other machines reach the dashboard (port 3005) and the HLS links
  (port 8888).
- **NDI**: CasparCG channel 1 also sends NDI. Install the
  [NDI Runtime](https://ndi.video/tools/) if you use that output. If you don't, remove
  the `<ndi>` block from `casparcg.config`.

To update an installed PC later, run `stop-all.bat`, then `git pull`, then `setup.ps1`
(it picks up new dependencies), then `start-all.bat`.

To create the admin user by hand instead, run `node db/seed.js` with
`SEED_ADMIN_USER` / `SEED_ADMIN_PASS` set. The default is `admin` / `admin`, and it
adds a sample channel unless `SEED_SKIP_SAMPLE_CHANNEL=1`.

### Running
From the repo root:
```powershell

start-all.bat   # stops anything already running, then starts the dashboard under PM2
stop-all.bat    # stops everything cleanly
```
Then open **http://localhost:3005**.

The dashboard starts **CasparCG and MediaMTX itself** and supervises them. Their output
appears in the browser Process Console, not in separate windows. On startup it first
kills any stray `casparcg.exe` / `mediamtx.exe`, because orphaned CEF helper processes
hold CasparCG's profile lock. PM2 in turn restarts the dashboard if it crashes. Keep it at
a single instance (see [ecosystem.config.js](amcp-dashboard/ecosystem.config.js)).

Useful commands (run from `amcp-dashboard/`):
```powershell
npm run pm2:status
npm run pm2:logs
npm run pm2:restart
```

### Dashboard environment (`amcp-dashboard/.env`)
See [.env.example](amcp-dashboard/.env.example) for the full commented list.

| Variable | Purpose |
|---|---|
| `PORT` | Dashboard port (default `3005`) |
| `CASPAR_HOST`, `CASPAR_PORT` | CasparCG AMCP endpoint (`127.0.0.1:5250`) |
| `SESSION_SECRET` | Signs the session cookie. **Required.** |
| `VM_HOST`, `VM_SSH_PORT`, `VM_SSH_USER` | Ingest VM SSH target (only needed for Cloud Streams) |
| `VM_SSH_KEY_PATH` *or* `VM_SSH_PASSWORD` | SSH auth. If the key path is set, it is used **instead of** the password, never as a fallback, so leave it empty when using password auth. |
| `MEDIAMTX_PUBLISH_USER`, `MEDIAMTX_PUBLISH_PASSWORD` | Must match the publisher user in the VM's `mediamtx.yml` |
| `MEDIAMTX_HLS_BASE` | Base URL for HLS links (public domain or `http://<vm-ip>:8888`) |
| `MEDIAMTX_HLS_BASE_TAILSCALE` | Optional Tailscale base for the same listener. When set, each stream also gets a Tailscale link, and the preview switches between LAN and Tailscale automatically. |

## Dashboard features

- **Multiple channels on air**: any number of channels can be live at once. Each one runs
  on its own CasparCG channel, with its own source, graphics, RTMP output and HLS link.
  Each has its own source failover too. Use **Go Live** / **Take Off Air** on each channel
  row (`/api/channels/:id/activate`, `/api/channels/:id/deactivate`). The **Controlling**
  picker in the header chooses which channel the page's controls act on. It never takes
  anything on or off air.
- **Channels and sources**: create channels, attach sources, play or clear the stream
  (`/api/channels`, `/api/sources`, `/api/stream/*`). `/api/stream/clear` and
  `/api/graphic/*` take a `channelId`. You can leave it out only while exactly one channel
  is on air.
- **Branding**: show or hide graphics, upload assets, and save per-channel presets with a
  default (`/api/graphic/*`, `/api/presets/*`, `/api/assets/upload`).
- **Cloud Streams**: add a UDP/SRT/RTMP/etc. source. The dashboard starts an
  `ingest-<slug>` ffmpeg container on the VM, which re-encodes and selects the program,
  and returns the HLS link(s). Streams can be stopped, started and deleted
  (`/api/cloud-streams/*`).
- **System**: status, restarting CasparCG and MediaMTX, and a live log stream
  (`/api/system/*`, `/api/logs/stream`).
- **Health** (`/api/health`, [health-monitor.js](amcp-dashboard/health-monitor.js)): shows
  hardware load every 5 seconds, with an hour of history. It covers CPU overall and per
  core, memory, disk, the NVIDIA GPU (load, video encoder and decoder, temperature),
  CasparCG / MediaMTX / dashboard processes, and each network card.
  - **Incidents**: every failover, all-sources-down, CasparCG disconnect and unexpected
    process crash is logged with the peak load in the minute before it. Each gets a
    verdict: *hardware likely*, *possible*, or *normal*, meaning look at the source or
    network instead. Load that stays critical for 15 seconds is logged on its own.
  - **Status bar**: shows the overall hardware status on every tab.
  - **Thresholds**: set in `THRESHOLDS` at the top of `health-monitor.js`.
  - **GPU figures** need `nvidia-smi` (it comes with the NVIDIA driver). Without it, that
    section shows as unavailable.
  - **Memory only**: history and incidents are lost when the dashboard restarts.

### CasparCG channels and capacity
Each on-air dashboard channel needs its own `<channel>` in
[casparcg.config](casparcg-server-v2.5.0-stable-windows/casparcg.config). The config
defines 4. Channel 1 also has the local screen and NDI outputs, and channels 2–4 are bare.
The dashboard attaches each channel's RTMP output itself.

- **New channels** get the lowest CasparCG channel number no other channel uses. Change it
  with **Ch #** on the channel row (only while the channel is off air).
- **Going live is refused** when another on-air channel already uses that number, or when
  CasparCG doesn't have that channel.
- **To run more at once**, add more `<channel>` blocks and restart CasparCG. Each branded
  1080p50 channel costs roughly 3–4 CPU cores with the current x264 encoder settings.

## Ingest VM setup (Ubuntu + Docker)

The VM sits on two networks: the multicast LAN, where the feeds arrive, and the internet.
All services use `network_mode: host`, so ffmpeg can receive multicast and publish to
MediaMTX over loopback. The VM's `mediamtx.yml` only accepts publishing from loopback.

### First deploy
```bash
git clone <this repo> ~/afrochannels-caspsar-mediamTX
mkdir -p ~/dewatch
cp ~/afrochannels-caspsar-mediamTX/.env.vm.example ~/dewatch/.env   # fill it in
~/afrochannels-caspsar-mediamTX/deploy.sh
```

### Updating
```bash
~/afrochannels-caspsar-mediamTX/deploy.sh
```
`deploy.sh` does the following:
1. Runs `git pull --ff-only`.
2. Copies the compose file, Caddyfile and `mediamtx.cloud.yml` into `~/dewatch`
   (override the location with `DEPLOY_DIR`).
3. Substitutes `MEDIAMTX_PUBLISH_PASSWORD` into `mediamtx.yml`. MediaMTX reads the file,
   not the environment.
4. Runs `docker compose up -d` for whichever services are configured.

It never touches `.env`.

### VM environment (`~/dewatch/.env`)
| Variable | Purpose |
|---|---|
| `MEDIAMTX_PUBLISH_PASSWORD` | RTMP publish password. Keep it alphanumeric, because it goes in a query string. |
| `MULTICAST_SOURCE` | Optional always-on feed (a full ffmpeg input URL, quoted). `localaddr` must be the VM's IP on the multicast interface. Keep `timeout=` so ffmpeg exits and restarts when a group goes quiet. If empty, the static ingest is skipped. |
| `MULTICAST_PROGRAM` | Program number inside the transport stream. List them with `ffprobe -show_programs`. |
| `MULTICAST_PATH` | MediaMTX path. The HLS URL becomes `https://<domain>/live/<path>/index.m3u8`. |
| `STREAM_DOMAIN` | Public hostname for Caddy. It must already resolve to the site's public IP. If empty, Caddy is skipped and HLS is available on `:8888` only. |

Streams added from the dashboard run as their own containers and do not depend on
`MULTICAST_SOURCE`.

## Secrets

The filled-in `.env` files, the SQLite database and uploads are git-ignored. The committed
`mediamtx.cloud.yml` contains only the `CHANGE_ME_MATCH_MEDIAMTX_PUBLISH_PASSWORD`
placeholder. The real value lives only on the VM.
