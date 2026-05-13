#!/usr/bin/env node
const { setup } = require('./setup');
const path = require('path');
const fs = require('fs');

// Always run setup on postinstall, unless we're being installed globally
const isGlobalInstall = process.env.npm_config_global === 'true';

if (!isGlobalInstall) {
  console.log('\n📦 Running REMBR postinstall setup...');
  console.log('Current working directory:', process.cwd());
  console.log('Package directory:', __dirname);
  
  // Find the project root - look for nearest package.json that isn't us
  let projectRoot = process.cwd();
  const packageDir = path.resolve(__dirname, '../../../'); // Go up from node_modules/@rembr/client
  
  // Check if we're in a node_modules directory and use parent project
  if (process.cwd().includes('node_modules')) {
    projectRoot = packageDir;
  }
  
  console.log('Project root:', projectRoot);
  
  // Change to project directory before running setup
  process.chdir(projectRoot);
  setup(false);
} else {
  console.log('\n📦 @rembr/client installed globally. Run `npx rembr setup` to configure a project.\n');
}
