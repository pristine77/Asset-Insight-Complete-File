/* global __dirname */
const fs = require('fs');
const path = require('path');

// Expo passes the normalized app.json configuration to this function.
// Keep all existing settings, including local native-plugin configuration.
module.exports = ({ config }) => {
  const android = { ...config.android };
  const googleServicesFile = android.googleServicesFile;

  if (googleServicesFile && !fs.existsSync(path.resolve(__dirname, googleServicesFile))) {
    delete android.googleServicesFile;
  }

  const plugins = config.plugins || [];
  return { ...config, android, plugins: plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-sqlite')
    ? plugins : [...plugins, 'expo-sqlite'] };
};
