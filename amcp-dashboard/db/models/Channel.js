const { DataTypes } = require('sequelize');
const sequelize = require('../sequelize');

// One "Channel" is a saved broadcast profile: a name, an output target, and
// (via association) its own ordered list of input Sources and BrandingPresets.
// Only one Channel is ever "active" at a time - the CasparCG server in this
// setup has a single physical channel/consumer chain, so this models
// switchable profiles rather than simultaneous multi-channel output.
const Channel = sequelize.define('Channel', {
  name: { type: DataTypes.STRING, allowNull: false },
  casparChannelNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  // Output target for the RTMP push consumer. Kept as TEXT, not a typed URL
  // field, since output targets can be RTMP now and something else later.
  rtmpTarget: { type: DataTypes.TEXT, allowNull: false },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
});

module.exports = Channel;
