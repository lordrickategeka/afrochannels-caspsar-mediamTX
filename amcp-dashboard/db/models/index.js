const sequelize = require('../sequelize');
const User = require('./User');
const Channel = require('./Channel');
const Source = require('./Source');
const BrandingPreset = require('./BrandingPreset');
const CloudStream = require('./CloudStream');

Channel.hasMany(Source, { foreignKey: 'channelId', onDelete: 'CASCADE' });
Source.belongsTo(Channel, { foreignKey: 'channelId' });

Channel.hasMany(BrandingPreset, { foreignKey: 'channelId', onDelete: 'CASCADE' });
BrandingPreset.belongsTo(Channel, { foreignKey: 'channelId' });

module.exports = { sequelize, User, Channel, Source, BrandingPreset, CloudStream };
