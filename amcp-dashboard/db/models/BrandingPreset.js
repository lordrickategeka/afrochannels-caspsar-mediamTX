const { DataTypes } = require('sequelize');
const sequelize = require('../sequelize');

// A saved, named set of data for one CG template (see server.js's TEMPLATES
// registry for the template keys and what fields each one expects). Lets an
// operator save and re-apply as many branding variations as they want
// instead of retyping text into the form every time.
const BrandingPreset = sequelize.define('BrandingPreset', {
  name: { type: DataTypes.STRING, allowNull: false },
  template: { type: DataTypes.STRING, allowNull: false }, // 'lower_third' | 'logo_bug' | 'ticker'
  data: { type: DataTypes.JSON, allowNull: false },
  // At most one default per (channel, template) - the preset that gets
  // auto-applied whenever this channel is activated or CasparCG reconnects
  // after any kind of restart, so branding doesn't need to be manually
  // re-shown every time.
  isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
});

module.exports = BrandingPreset;
