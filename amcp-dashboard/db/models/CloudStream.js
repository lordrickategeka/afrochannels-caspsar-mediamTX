const { DataTypes } = require('sequelize');
const sequelize = require('../sequelize');

// A stream ingest running on the cloud VM's MediaMTX (see vm-control.js).
// This table only stores what a stream *is* (name, source URL) - whether its
// ffmpeg container is actually running is queried live from the VM via SSH,
// never cached here, so it can't drift out of sync with reality.
const CloudStream = sequelize.define('CloudStream', {
  name: { type: DataTypes.STRING, allowNull: false },
  // Derived from name via slugify(); used as the VM container name suffix
  // ("ingest-<slug>") and the MediaMTX/HLS path ("live/<slug>").
  slug: { type: DataTypes.STRING, allowNull: false, unique: true },
  // Any format ffmpeg's "-i" can read: udp://, srt://, rtmp(s)://, rtsp://,
  // http(s)://. Kept as TEXT/unvalidated-by-type, same reasoning as
  // Source.url - the dashboard doesn't need to know which protocol this is,
  // vm-control.js only checks it's shell-safe.
  sourceUrl: { type: DataTypes.TEXT, allowNull: false },
  // Program number within the primary's transport stream (udp:// multicast
  // carrying several TV services), or null to let ffmpeg pick.
  program: { type: DataTypes.INTEGER, allowNull: true },
  // Backups tried in order when the primary stops: [{ url, program }].
  // All publish to the same path, so the HLS link never changes.
  backupSources: { type: DataTypes.JSON, allowNull: false, defaultValue: [] }
});

/** Every source in priority order - primary first - as vm-control expects them. */
CloudStream.prototype.allSources = function allSources() {
  return [{ url: this.sourceUrl, program: this.program }, ...(this.backupSources || [])];
};

module.exports = CloudStream;
