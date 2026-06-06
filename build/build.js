'use strict';

// Channel-aware packager. Usage:
//   node build/build.js daily           → local daily installer (no upload)
//   node build/build.js daily --publish → daily installer + publish to GitHub
//   node build/build.js nightly         → local nightly installer (never uploads)
//
// Only the daily channel is ever published. Nightly is dev/local-only.
//
// extraMetadata.buildChannel is written into the packaged package.json so that
// src/main/channel.js can read it at runtime without needing env vars.
const builder = require('electron-builder');
const pkg = require('../package.json');
const base = pkg.build;

const channel = process.argv[2] === 'nightly' ? 'nightly' : 'daily';
const nightly = channel === 'nightly';
const shouldPublish = !nightly && process.argv.includes('--publish');

const config = {
  ...base,
  extraMetadata: { ...(base.extraMetadata || {}), buildChannel: channel },
};

if (shouldPublish) {
  // Restore publish config for daily release uploads. electron-builder 26's
  // programmatic API validates this block more strictly than its package.json
  // loader, so we only include it when actually publishing.
  config.publish = base.publish;
} else {
  // Local build — drop publish to avoid electron-builder 26 schema error.
  delete config.publish;
}

if (nightly) {
  // Distinct identity so Nightly installs alongside Daily instead of over it.
  config.appId = 'com.utopiabot.jarvis.nightly';
  config.productName = 'UtopiaBot JARVIS Nightly';
  config.nsis = {
    ...(base.nsis || {}),
    shortcutName: 'UtopiaBot JARVIS Nightly',
    uninstallDisplayName: 'UtopiaBot JARVIS Nightly',
  };
}

console.log(`Building ${channel} channel…`);
builder.build({ config }).then(
  (artifacts) => {
    console.log(`\n${channel} build complete:`);
    for (const a of artifacts) console.log('  ' + a);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
