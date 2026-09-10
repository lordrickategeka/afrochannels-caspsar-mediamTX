const path = require('path');
const { Sequelize } = require('sequelize');

// SQLite: a single self-contained file, no separate database server to
// install/run (this replaced MySQL/WAMP specifically to remove that extra
// setup step - everything lives in this one file, portable with the project).
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, 'database.sqlite'),
  logging: false
});

module.exports = sequelize;
