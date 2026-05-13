#!/usr/bin/env node

/**
 * REMBR MCP Server - Core Memory Operations
 * 
 * Specialized server exposing core memory management tools:
 * - memory: create, get, update, delete, list, set_visibility
 * - search: query, smart, similar
 * - stats: usage, embeddings, insights
 * - context: create, get, list, search, add_memory, delete
 * - snapshot: create, get, list, create_temporal, list_temporal
 * 
 * Part of REM-38: Multi-Server Split
 */

// Set server type before importing main server
process.env.SERVER_TYPE = 'core';

// Import and start the main server
import '../index-http.js';

console.log('🚀 Starting REMBR MCP Server - Core Operations');
console.log('📦 Exposing 5 core tools: memory, search, stats, context, snapshot');
