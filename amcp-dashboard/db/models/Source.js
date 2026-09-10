const { DataTypes } = require('sequelize');
const sequelize = require('../sequelize');

// An input source for a Channel. "url" is deliberately untyped/unvalidated
// beyond being text: sources aren't always SRT - they may be RTMP, RTSP,
// HTTP(S), or anything else CasparCG's ffmpeg producer can open. CasparCG
// figures out the protocol from the URL itself, so the dashboard doesn't
// need to know or care which format a given source is.
const Source = sequelize.define('Source', {
  label: { type: DataTypes.STRING, allowNull: false },
  url: { type: DataTypes.TEXT, allowNull: false },
  // Failover order within the channel - lower tries first.
  priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
});

module.exports = Source;
