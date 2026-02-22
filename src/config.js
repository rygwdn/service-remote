const fs = require('fs');
const path = require('path');

const defaultConfig = require('../config.default.json');

let userConfig = {};
const userConfigPath = path.join(__dirname, '..', 'config.json');
if (fs.existsSync(userConfigPath)) {
  userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
}

function merge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      result[key] = merge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

module.exports = merge(defaultConfig, userConfig);
