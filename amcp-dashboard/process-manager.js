// Spawns and supervises CasparCG and MediaMTX as child processes of this
// dashboard, instead of them being launched as separate terminal windows by
// start-all.bat. This exists for two reasons:
//
// 1. It's the only way to show their live output in the browser - MediaMTX
//    doesn't write a log file (only stdout), so there's nothing to tail; the
//    dashboard has to be the one that spawns it to capture that output at all.
// 2. It gives one reliable place to kill the whole process tree on restart.
//    CasparCG's CEF engine spawns GPU/renderer/network helper processes that
//    a plain kill of the main PID leaves orphaned (this caused real, repeated
//    "Failed to initialize CEF" failures earlier tonight because a stale
//    instance was still holding the profile lock) - "taskkill /T /F" is the
//    only thing that reliably takes the whole tree down at once.
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_BUFFER_SIZE = 500;
const emitter = new EventEmitter();
const buffers = {}; // name -> [{ source, line, ts }]
const managed = {}; // name -> { proc, exePath, cwd }

function ensureBuffer(name) {
  if (!buffers[name]) buffers[name] = [];
  return buffers[name];
}

function pushLog(name, line) {
  const buf = ensureBuffer(name);
  const entry = { source: name, line: line.toString(), ts: Date.now() };
  buf.push(entry);
  if (buf.length > LOG_BUFFER_SIZE) buf.shift();
  emitter.emit('log', entry);
}

function onLog(cb) {
  emitter.on('log', cb);
  return () => emitter.off('log', cb);
}

/** Fires whenever a managed process exits, for ANY reason - a restart we
 * asked for, a crash, or an external kill. Callers must treat this as the
 * single source of truth for "this process's state is gone", rather than
 * only resetting their own tracking inside their own restart code path -
 * that leaves stale state (e.g. "a STREAM consumer already exists") if the
 * process dies some other way, which was observed live: CasparCG restarted
 * once outside of an explicit restart request, and the dashboard kept
 * believing its old consumer was still there on the new process, silently
 * skipping re-creating it. */
function onExit(cb) {
  emitter.on('exit', cb);
  return () => emitter.off('exit', cb);
}

function getAllBuffered() {
  return Object.values(buffers)
    .flat()
    .sort((a, b) => a.ts - b.ts);
}

/** Broad, name-based cleanup for stray processes left over from before this
 * dashboard instance existed (e.g. a previous crashed session) - not for
 * routine stop/restart, which targets our own tracked PID precisely instead. */
function killAllByImageName(imageName) {
  return new Promise((resolve) => {
    exec(`taskkill /IM ${imageName} /T /F`, () => resolve());
  });
}

function clearCasparCefLock(casparDir) {
  try {
    fs.unlinkSync(path.join(casparDir, 'cef-cache', 'lockfile'));
  } catch {
    // Fine if it doesn't exist - nothing to clear.
  }
}

function startProcess(name, exePath, cwd) {
  if (managed[name]?.proc && managed[name].proc.exitCode === null) {
    pushLog(name, '[already running, skipping start]');
    return;
  }
  const proc = spawn(exePath, [], { cwd });
  managed[name] = { proc, exePath, cwd };
  pushLog(name, `[started, pid ${proc.pid}]`);

  proc.stdout.on('data', (d) => pushLog(name, d));
  proc.stderr.on('data', (d) => pushLog(name, d));
  proc.on('exit', (code, signal) => {
    pushLog(name, `[exited: code=${code} signal=${signal}]`);
    emitter.emit('exit', { name, code, signal });
  });
  proc.on('error', (err) => pushLog(name, `[spawn error: ${err.message}]`));
}

function stopProcess(name) {
  return new Promise((resolve) => {
    const entry = managed[name];
    if (!entry?.proc?.pid || entry.proc.exitCode !== null) return resolve();
    exec(`taskkill /PID ${entry.proc.pid} /T /F`, () => resolve());
  });
}

async function restartProcess(name, { preStart } = {}) {
  const entry = managed[name];
  if (!entry) throw new Error(`"${name}" is not a managed process`);
  await stopProcess(name);
  await new Promise((r) => setTimeout(r, 1500)); // let Windows release ports/handles
  if (preStart) preStart();
  startProcess(name, entry.exePath, entry.cwd);
}

function isRunning(name) {
  return Boolean(managed[name]?.proc && managed[name].proc.exitCode === null);
}

module.exports = {
  pushLog,
  onLog,
  onExit,
  getAllBuffered,
  killAllByImageName,
  clearCasparCefLock,
  startProcess,
  stopProcess,
  restartProcess,
  isRunning
};
