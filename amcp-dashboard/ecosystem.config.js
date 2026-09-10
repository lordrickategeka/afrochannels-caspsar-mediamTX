// PM2 process definition for the dashboard itself - restarts it automatically
// if it crashes. This is layered on top of, not instead of, the dashboard's
// own supervision of CasparCG/MediaMTX (process-manager.js): PM2 watches this
// one Node process; this process watches its two children. On a PM2-triggered
// restart, the dashboard's SIGINT/SIGTERM handler in server.js stops those
// children cleanly first, and its own startup sequence does a broad cleanup
// sweep regardless, so a stale child can't be left behind either way.
module.exports = {
  apps: [
    {
      name: 'amcp-dashboard',
      script: 'server.js',
      cwd: __dirname,
      // MUST stay single-instance/fork mode: this process holds in-memory
      // playout state, one CasparCG connection, and spawns CasparCG/MediaMTX
      // itself - clustering it would spawn multiple competing copies of both.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      min_uptime: '10s', // must survive this long to count as a real start
      max_restarts: 10, // give up after this many rapid failures, don't loop forever
      restart_delay: 5000
    }
  ]
};
