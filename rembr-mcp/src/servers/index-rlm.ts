#!/usr/bin/env node

/**
 * REMBR MCP Server - RLM (Relationship Learning & Memory) Operations
 * 
 * Specialized server exposing RLM-specific tools:
 * - causality: infer, trace, get, validate
 * - temporal: search, history
 * - audit: query, report, stats
 * - classify: intent
 * 
 * Part of REM-38: Multi-Server Split
 */

// Set server type before importing main server
process.env.SERVER_TYPE = 'rlm';

// Import and start the main server
import '../index-http.js';

console.log('🚀 Starting REMBR MCP Server - RLM Operations');
console.log('📦 Exposing 4 RLM tools: causality, temporal, audit, classify');
