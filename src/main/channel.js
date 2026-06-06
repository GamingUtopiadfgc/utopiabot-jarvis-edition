'use strict';

// Build channel for this copy of UtopiaBot.
//   'daily'   — stable, safer use. Dangerous/experimental features are OFF.
//   'nightly' — dev build. Enables dangerous features (e.g. VM control).
//
// Resolution order (first wins), so it works in packaged builds and in dev:
//   1. package.json "buildChannel"  — injected at build time by build/build.js
//      via electron-builder's extraMetadata (present in the packaged app).
//   2. UTOPIA_CHANNEL env var        — used by `npm run dev:nightly`.
//   3. a `--nightly` CLI flag        — convenience for the main process.
//   4. 'daily'                       — safe default.
let raw = '';
try {
  raw = require('../../package.json').buildChannel || '';
} catch {
  /* package.json unreadable — fall through to env/argv */
}
raw =
  raw ||
  process.env.UTOPIA_CHANNEL ||
  (process.argv.includes('--nightly') ? 'nightly' : '') ||
  'daily';

const CHANNEL = raw === 'nightly' ? 'nightly' : 'daily';
const isNightly = CHANNEL === 'nightly';

module.exports = {
  CHANNEL,
  isNightly,
  // Single switch the rest of the app reads to gate dangerous, dev-only features.
  dangerousFeaturesEnabled: isNightly,
};
