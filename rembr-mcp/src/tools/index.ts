/**
 * Phase 1: Consolidated MCP Tools
 * 
 * Exports consolidated tool definitions and routing utilities.
 * Reduces 83 legacy tools to 18 operation-based tools for better agent UX.
 * 
 * Phase 2: Multi-Server Split (REM-38)
 * Adds server type filtering for specialized server deployments.
 */

// Tool definitions
export {
  getConsolidatedTools,
  getLegacyToolMigration,
  TOOL_CONSOLIDATION_MAP,
  // Phase 2: Multi-Server Split
  getToolsByServerType,
  getToolCountByServerType,
  TOOL_SERVER_MAP,
  type ServerType
} from './consolidated-tools.js';

// Routing utilities
export {
  routeLegacyTool,
  addPaginationMetadata,
  wrapWithDeprecationWarning,
  getOperationValidator,
  validateMemoryOperation,
  validateSearchOperation,
  validateStatsOperation,
  validateContextOperation,
  validateSnapshotOperation,
  validateGraphOperation,
  validateContradictionsOperation,
  validateCausalityOperation,
  validateTemporalOperation,
  validateAuditOperation,
  validateClassifyOperation,
  validateCompressionOperation,
  type ToolResult,
  type ToolRouterContext,
  type MemoryOperation,
  type SearchOperation,
  type StatsOperation,
  type ContextOperation,
  type SnapshotOperation,
  type GraphOperation,
  type ContradictionsOperation,
  type CausalityOperation,
  type TemporalOperation,
  type AuditOperation,
  type ClassifyOperation,
  type CompressionOperation
} from './tool-router.js';

/**
 * Consolidated tool list for quick reference:
 * 
 * 1. memory        - create, get, update, delete, list, list_personal, set_visibility
 * 2. search        - query, smart, similar
 * 3. stats         - usage, embeddings, insights, generate_insights, predictions
 * 4. context       - create, get, list, search, add_memory, delete
 * 5. snapshot      - create, get, list, create_temporal, list_temporal
 * 6. graph         - get, generate, insights, infer, compare
 * 7. contradictions - detect
 * 8. causality     - infer, trace, get, validate
 * 9. temporal      - search, history
 * 10. audit        - query, report, stats
 * 11. classify     - intent
 * 12. compression  - compress, preview
 * 
 * Plus: pii tool (Phase 0.5) - detect, redact, audit, compliance_report, batch_scan
 */
