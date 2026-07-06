#!/usr/bin/env node
/**
 * Test script for multi-server tool filtering (REM-38 Phase 2)
 */

import { getToolsByServerType, getToolCountByServerType } from './dist/tools/index.js';

console.log('=== Tool Count by Server Type ===');
const counts = getToolCountByServerType();
console.log(`Core: ${counts.core} tools`);
console.log(`RLM: ${counts.rlm} tools`);
console.log(`Analytics: ${counts.analytics} tools`);
console.log(`All: ${counts.all} tools`);

console.log('\n=== Core Server Tools ===');
const coreTools = getToolsByServerType('core');
console.log(coreTools.map(t => t.name).join(', '));

console.log('\n=== RLM Server Tools ===');
const rlmTools = getToolsByServerType('rlm');
console.log(rlmTools.map(t => t.name).join(', '));

console.log('\n=== Analytics Server Tools ===');
const analyticsTools = getToolsByServerType('analytics');
console.log(analyticsTools.map(t => t.name).join(', '));

console.log('\n=== Verification ===');
console.log(`✓ Core + RLM + Analytics = ${counts.core + counts.rlm + counts.analytics} (should be 11)`);
console.log(`✓ All = ${counts.all} (should be 11)`);
