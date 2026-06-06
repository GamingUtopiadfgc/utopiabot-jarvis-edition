'use strict';

// Launch the app in dev on the Nightly channel so dangerous features (VM
// control, etc.) are enabled without making a full installer. Setting the env
// var ensures the channel propagates to both the main and renderer processes.
const { spawn } = require('child_process');
const electron = require('electron');

spawn(electron, ['.', '--dev', '--nightly'], {
  stdio: 'inherit',
  env: { ...process.env, UTOPIA_CHANNEL: 'nightly' },
});
