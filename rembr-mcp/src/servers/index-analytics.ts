#!/usr/bin/env node

/**
 * REMBR MCP Server - Analytics Operations
 * 
 * Specialized server exposing analytics-specific tools:
 * - graph: get, generate, insights, infer, compare
 * - contradictions: detect
 * 
 * Part of REM-38: Multi-Server Split
 */

// Set server type before importing main server
process.env.SERVER_TYPE = 'analytics';

// Import and start the main server
import '../index-http.js';

console.log('🚀 Starting REMBR MCP Server - Analytics Operations');
console.log('📦 Exposing 2 analytics tools: graph, contradictions');
