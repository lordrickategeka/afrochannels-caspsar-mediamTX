// Samples how hard the machine is working - CPU (overall and per core),
// memory, disk, NVIDIA GPU, network cards, and the CasparCG / MediaMTX /
// dashboard processes - and keeps an hour of history plus an incident log.
//
// The point is to answer "was that channel problem the hardware?": every
// channel incident (a failover, all sources down, CasparCG dropping) is stored
// together with the peak load over the minute before it, and gets a verdict.
//
// Only two helper processes are spawned, each ONCE and kept running, rather
// than one per sample: Windows' own performance counters (Get-Counter,
// Get-NetAdapterStatistics) were measured at ~50s per read on this hardware,
// and spawning PowerShell per sample costs ~1.5s of CPU each time.
//   - nvidia-smi in its own looping mode (-l) for the GPU
//   - one PowerShell loop reading Get-Process + .NET NIC counters (Windows only)
// Either may be missing (no NVIDIA card, not Windows) - that section is then
// reported as unavailable and everything else keeps working.
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const SAMPLE_INTERVAL_MS = 5000;
const HISTORY_SAMPLES = 720; // 1 hour at 5s
const MAX_INCIDENTS = 200;
const INCIDENT_LOOKBACK_MS = 60000;
// A hardware incident is logged only once a metric has stayed critical for
// this many samples in a row, so a one-sample spike doesn't flood the log.
const SUSTAINED_CRITICAL_SAMPLES = 3;
const DISK_PATH = path.join(__dirname, '..');

// Percent thresholds. diskFree is inverted: LOW is bad.
const THRESHOLDS = {
  cpu: { warning: 80, critical: 95 },
  maxCore: { warning: 90, critical: 98 },
  memory: { warning: 85, critical: 95 },
  gpu: { warning: 85, critical: 97 },
  encoder: { warning: 85, critical: 97 },
  decoder: { warning: 85, critical: 97 },
  gpuTemp: { warning: 83, critical: 90 },
  diskFree: { warning: 15, critical: 5 }
};

const METRIC_LABELS = {
  cpu: 'CPU',
  maxCore: 'Busiest CPU core',
  memory: 'Memory',
  gpu: 'GPU',
  encoder: 'GPU video encoder',
  decoder: 'GPU video decoder',
  gpuTemp: 'GPU temperature',
  diskFree: 'Free disk space'
};

// Process groups shown in the process table. CasparCG's HTML (CEF) graphics
// engine runs as extra casparcg.exe helper processes, so the group sums every
// instance - that's where lower thirds and tickers actually cost CPU.
const PROCESS_GROUPS = ['casparcg', 'mediamtx', 'ffmpeg'];

const history = [];
const incidents = [];
let latest = null;
let started = false;
let sampleTimer = null;
let incidentSeq = 0;
const criticalStreak = {}; // metric -> consecutive critical samples

// --- CPU (from os.cpus() tick deltas) ---
let prevCpuTimes = null;

function readCpu() {
  const cpus = os.cpus();
  const times = cpus.map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
  let cores = null;
  if (prevCpuTimes && prevCpuTimes.length === times.length) {
    cores = times.map((t, i) => {
      const total = t.total - prevCpuTimes[i].total;
      const idle = t.idle - prevCpuTimes[i].idle;
      return total > 0 ? round1(100 * (1 - idle / total)) : 0;
    });
  }
  prevCpuTimes = times;
  if (!cores) return { cpu: null, cores: [], model: cpus[0]?.model?.trim() || null };
  return { cpu: round1(avg(cores)), cores, model: cpus[0]?.model?.trim() || null };
}

// --- Dashboard's own process ---
let prevSelfCpu = null;
let prevSelfAt = null;

function readSelf() {
  const now = Date.now();
  const usage = process.cpuUsage();
  let cpu = null;
  if (prevSelfCpu) {
    const usedMicros = (usage.user - prevSelfCpu.user) + (usage.system - prevSelfCpu.system);
    cpu = round1((usedMicros / 1000) / ((now - prevSelfAt) * os.cpus().length) * 100);
  }
  prevSelfCpu = usage;
  prevSelfAt = now;
  return { cpu, memoryBytes: process.memoryUsage().rss, count: 1 };
}

function readDisk() {
  try {
    const s = fs.statfsSync(DISK_PATH);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path: DISK_PATH, totalBytes: total, freeBytes: free, freePct: total > 0 ? round1((free / total) * 100) : null };
  } catch {
    return null;
  }
}

// --- NVIDIA GPU (nvidia-smi -l) ---
// Tried in order: newer drivers support the encoder/decoder utilization
// fields, older ones reject the whole query if any field is unknown.
const GPU_QUERIES = [
  ['index', 'name', 'utilization.gpu', 'utilization.encoder', 'utilization.decoder', 'memory.used', 'memory.total', 'temperature.gpu', 'encoder.stats.sessionCount'],
  ['index', 'name', 'utilization.gpu', 'memory.used', 'memory.total', 'temperature.gpu', 'encoder.stats.sessionCount'],
  ['index', 'name', 'utilization.gpu', 'memory.used', 'memory.total', 'temperature.gpu']
];
const gpu = { status: 'starting', devices: {}, proc: null, queryIndex: 0, restartTimer: null };

function parseGpuValue(v) {
  const s = (v || '').trim();
  if (!s || s.startsWith('[') || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

function startGpuReader() {
  const fields = GPU_QUERIES[gpu.queryIndex];
  let gotData = false;
  let proc;
  try {
    proc = spawn('nvidia-smi', [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits', '-l', String(SAMPLE_INTERVAL_MS / 1000)], { windowsHide: true });
  } catch {
    gpu.status = 'unavailable';
    return;
  }
  gpu.proc = proc;
  proc.on('error', () => { gpu.status = 'unavailable'; gpu.proc = null; });
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const parts = line.split(',');
    if (parts.length !== fields.length) return;
    const row = Object.fromEntries(fields.map((f, i) => [f, parseGpuValue(parts[i])]));
    if (row.index === null) return;
    gotData = true;
    gpu.status = 'ok';
    gpu.devices[row.index] = {
      index: row.index,
      name: row.name,
      util: row['utilization.gpu'] ?? null,
      encoder: row['utilization.encoder'] ?? null,
      decoder: row['utilization.decoder'] ?? null,
      memoryUsedMB: row['memory.used'] ?? null,
      memoryTotalMB: row['memory.total'] ?? null,
      tempC: row['temperature.gpu'] ?? null,
      encoderSessions: row['encoder.stats.sessionCount'] ?? null,
      at: Date.now()
    };
  });
  proc.on('exit', () => {
    gpu.proc = null;
    if (!started) return;
    if (!gotData && gpu.queryIndex < GPU_QUERIES.length - 1) {
      gpu.queryIndex += 1; // this driver rejected a field - retry with fewer
      startGpuReader();
      return;
    }
    if (gpu.status !== 'unavailable') gpu.status = gotData ? 'restarting' : 'unavailable';
    // Keep retrying slowly: a driver update/reset can bring it back.
    gpu.restartTimer = setTimeout(startGpuReader, 30000);
  });
}

// --- Processes + network cards (one persistent PowerShell loop, Windows) ---
const sys = { status: process.platform === 'win32' ? 'starting' : 'unavailable', proc: null, prev: null, processes: null, network: null, restartTimer: null };

function psLoopScript() {
  // Exits on its own if the dashboard dies without killing it (PM2 hard
  // restart, crash): both a parent-PID check and a failed stdout write.
  return `
$ErrorActionPreference = 'SilentlyContinue'
$parentPid = ${process.pid}
while ($true) {
  if (-not (Get-Process -Id $parentPid)) { exit }
  $procs = @(Get-Process -Name ${PROCESS_GROUPS.map((n) => `'${n}'`).join(', ')} | ForEach-Object {
    [pscustomobject]@{ n = $_.ProcessName; id = $_.Id; cpu = $_.TotalProcessorTime.TotalSeconds; mem = $_.WorkingSet64 }
  })
  $nics = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
    ForEach-Object { $s = $_.GetIPStatistics(); [pscustomobject]@{ name = $_.Name; rx = $s.BytesReceived; tx = $s.BytesSent; speed = $_.Speed } })
  $json = [pscustomobject]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); procs = $procs; nics = $nics } | ConvertTo-Json -Compress -Depth 3
  try { [Console]::Out.WriteLine($json); [Console]::Out.Flush() } catch { exit }
  Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}
}`;
}

function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function handleSysReading(r) {
  const prev = sys.prev;
  sys.prev = { t: r.t, procs: new Map(asArray(r.procs).map((p) => [p.id, p])), nics: new Map(asArray(r.nics).map((n) => [n.name, n])) };
  if (!prev) return; // need two readings for rates
  const seconds = (r.t - prev.t) / 1000;
  if (seconds <= 0) return;
  const cores = os.cpus().length;

  const processes = {};
  for (const name of PROCESS_GROUPS) processes[name] = { cpu: 0, memoryBytes: 0, count: 0 };
  for (const p of asArray(r.procs)) {
    const group = processes[p.n];
    if (!group) continue;
    group.count += 1;
    group.memoryBytes += p.mem || 0;
    const before = prev.procs.get(p.id);
    // A brand-new PID has no previous reading; it's counted from the next one.
    if (before && typeof p.cpu === 'number' && typeof before.cpu === 'number') {
      group.cpu += Math.max(0, p.cpu - before.cpu) / (seconds * cores) * 100;
    }
  }
  for (const g of Object.values(processes)) g.cpu = round1(g.cpu);
  sys.processes = processes;

  sys.network = asArray(r.nics).map((n) => {
    const before = prev.nics.get(n.name);
    const rxMbps = before ? round2(Math.max(0, n.rx - before.rx) * 8 / seconds / 1e6) : null;
    const txMbps = before ? round2(Math.max(0, n.tx - before.tx) * 8 / seconds / 1e6) : null;
    const speedMbps = n.speed > 0 ? Math.round(n.speed / 1e6) : null;
    const loadPct = speedMbps && rxMbps !== null ? round1(Math.max(rxMbps, txMbps) / speedMbps * 100) : null;
    return { name: n.name, rxMbps, txMbps, speedMbps, loadPct };
  });
  sys.status = 'ok';
}

function startSysReader() {
  if (process.platform !== 'win32') return;
  const encoded = Buffer.from(psLoopScript(), 'utf16le').toString('base64');
  let proc;
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
  } catch {
    sys.status = 'unavailable';
    return;
  }
  sys.proc = proc;
  proc.on('error', () => { sys.status = 'unavailable'; sys.proc = null; });
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    try { handleSysReading(JSON.parse(line)); } catch { /* partial/garbled line - skip */ }
  });
  proc.on('exit', () => {
    sys.proc = null;
    sys.prev = null;
    if (!started) return;
    if (sys.status !== 'unavailable') sys.status = 'restarting';
    sys.restartTimer = setTimeout(startSysReader, 10000);
  });
}

// --- Sampling ---
function levelFor(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t || value === null || value === undefined) return 'unknown';
  if (metric === 'diskFree') return value <= t.critical ? 'critical' : value <= t.warning ? 'warning' : 'ok';
  return value >= t.critical ? 'critical' : value >= t.warning ? 'warning' : 'ok';
}

const LEVEL_RANK = { unknown: 0, ok: 1, warning: 2, critical: 3 };

function maxOrNull(values) {
  const v = values.filter((x) => typeof x === 'number');
  return v.length ? Math.max(...v) : null;
}

function takeSample() {
  const { cpu, cores, model } = readCpu();
  const total = os.totalmem();
  const free = os.freemem();
  const gpus = Object.values(gpu.devices).filter((d) => Date.now() - d.at < SAMPLE_INTERVAL_MS * 4);
  const disk = readDisk();

  const sample = {
    t: Date.now(),
    cpu,
    cpuModel: model,
    cores,
    maxCore: cores.length ? Math.max(...cores) : null,
    memory: { usedPct: round1(((total - free) / total) * 100), usedBytes: total - free, totalBytes: total },
    gpus,
    disk,
    processes: { ...(sys.processes || {}), dashboard: readSelf() },
    network: sys.network || []
  };

  // The values thresholds apply to - with several GPUs, the busiest one counts.
  const metrics = {
    cpu: sample.cpu,
    maxCore: sample.maxCore,
    memory: sample.memory.usedPct,
    gpu: maxOrNull(gpus.map((g) => g.util)),
    encoder: maxOrNull(gpus.map((g) => g.encoder)),
    decoder: maxOrNull(gpus.map((g) => g.decoder)),
    gpuTemp: maxOrNull(gpus.map((g) => g.tempC)),
    diskFree: disk?.freePct ?? null
  };
  sample.metrics = metrics;
  sample.levels = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, levelFor(k, v)]));

  if (sample.cpu === null) return; // first call only primes the CPU deltas
  latest = sample;
  history.push({
    t: sample.t,
    cpu: metrics.cpu,
    maxCore: metrics.maxCore,
    memory: metrics.memory,
    gpu: metrics.gpu,
    encoder: metrics.encoder,
    rxMbps: sample.network.length ? round2(sample.network.reduce((s, n) => s + (n.rxMbps || 0), 0)) : null,
    txMbps: sample.network.length ? round2(sample.network.reduce((s, n) => s + (n.txMbps || 0), 0)) : null
  });
  if (history.length > HISTORY_SAMPLES) history.shift();

  // Sustained critical load is itself an incident, even if no channel has
  // failed (yet) - often it's the early warning.
  for (const [metric, level] of Object.entries(sample.levels)) {
    if (level === 'critical') {
      criticalStreak[metric] = (criticalStreak[metric] || 0) + 1;
      if (criticalStreak[metric] === SUSTAINED_CRITICAL_SAMPLES) {
        const value = metrics[metric];
        const unit = metric === 'gpuTemp' ? '°C' : '%';
        recordIncident({
          type: 'hardware',
          message: `${METRIC_LABELS[metric]} critical at ${value}${unit} for ${(SUSTAINED_CRITICAL_SAMPLES * SAMPLE_INTERVAL_MS) / 1000}s`
        });
      }
    } else {
      criticalStreak[metric] = 0;
    }
  }
}

/** Peak of each metric over the lookback window before `at`. */
function peaksBefore(at) {
  const window = history.filter((h) => h.t <= at && h.t >= at - INCIDENT_LOOKBACK_MS);
  const peak = (k) => maxOrNull(window.map((h) => h[k]));
  return {
    cpu: peak('cpu'),
    maxCore: peak('maxCore'),
    memory: peak('memory'),
    gpu: peak('gpu'),
    encoder: peak('encoder'),
    gpuTemp: latest?.metrics?.gpuTemp ?? null,
    diskFree: latest?.metrics?.diskFree ?? null
  };
}

/**
 * Logs a channel/system incident with the hardware load around it and a
 * verdict on whether the hardware is a plausible cause.
 * { type, message, channel? }
 */
function recordIncident({ type, message, channel = null }) {
  const at = Date.now();
  const peaks = peaksBefore(at);
  const pressured = Object.entries(peaks)
    .map(([metric, value]) => ({ metric, value, level: levelFor(metric, value) }))
    .filter((p) => p.level === 'warning' || p.level === 'critical')
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);

  let verdict;
  if (history.length === 0) verdict = 'unknown';
  else if (pressured.some((p) => p.level === 'critical')) verdict = 'likely';
  else if (pressured.length) verdict = 'possible';
  else verdict = 'unlikely';

  const incident = {
    id: ++incidentSeq,
    at,
    type,
    channel,
    message,
    peaks,
    pressured: pressured.map((p) => ({ ...p, label: METRIC_LABELS[p.metric] })),
    verdict
  };
  incidents.unshift(incident);
  if (incidents.length > MAX_INCIDENTS) incidents.pop();
  return incident;
}

function overallStatus() {
  if (!latest) return { level: 'unknown', issues: [] };
  const issues = Object.entries(latest.levels)
    .filter(([, level]) => level === 'warning' || level === 'critical')
    .map(([metric, level]) => ({ metric, level, label: METRIC_LABELS[metric], value: latest.metrics[metric] }))
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  return { level: issues[0]?.level || 'ok', issues };
}

/** Everything the Health tab needs. `since` limits history to newer points. */
function getReport(since = 0) {
  return {
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    thresholds: THRESHOLDS,
    sources: { gpu: gpu.status, processesAndNetwork: sys.status },
    status: overallStatus(),
    current: latest,
    history: since ? history.filter((h) => h.t > since) : history,
    incidents
  };
}

function start() {
  if (started) return;
  started = true;
  readCpu(); // prime deltas
  readSelf();
  startGpuReader();
  startSysReader();
  sampleTimer = setInterval(takeSample, SAMPLE_INTERVAL_MS);
}

function stop() {
  started = false;
  clearInterval(sampleTimer);
  clearTimeout(gpu.restartTimer);
  clearTimeout(sys.restartTimer);
  for (const proc of [gpu.proc, sys.proc]) {
    try { proc?.kill(); } catch { /* already gone */ }
  }
}

function avg(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { start, stop, getReport, recordIncident };
