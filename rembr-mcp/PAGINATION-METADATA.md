# Pagination Metadata (REM-68)

## Overview

All list and search operations in Rembr MCP now return standardized pagination metadata. This enhances agent UX by providing execution stats, total counts, and filter suggestions.

## Response Schema

All list/search tools return responses in this format:

```json
{
  "success": true,
  "data": [...],
  "metadata": {
    "returned": 10,
    "total_available": 487,
    "execution_time_ms": 45
  },
  "pagination": {
    "has_more": true,
    "suggested_filters": ["category: 'facts'"]
  },
  "related_tools": ["get_context_insights"]
}
```

### Fields

#### `success` (boolean, required)
- `true` if operation succeeded
- `false` if error occurred

#### `data` (array, required)
- Array of result items
- Empty array if no results
- Single item for get operations

#### `metadata` (object, required)
- **`returned`** (number): Count of items in this response
- **`total_available`** (number): Total items available (before limit)
- **`execution_time_ms`** (number): Query execution time in milliseconds

#### `pagination` (object, optional)
- **`has_more`** (boolean): Whether more results exist beyond this page
- **`suggested_filters`** (string[], optional): Recommended filters to narrow results

Present when:
- `has_more` is true, OR
- `suggested_filters` are provided

#### `related_tools` (string[], optional)
- List of tool names that might be useful next
- Examples: `['get_context_insights', 'generate_memory_insights']`

## Usage Examples

### Memory Search with Pagination

```typescript
// Request
const result = await callTool('search', {
  operation: 'query',
  query: 'database design',
  limit: 20
});

// Response
{
  "success": true,
  "data": [
    {
      "id": "mem-123",
      "content": "...",
      "score": 0.92
    },
    // ... 19 more items
  ],
  "metadata": {
    "returned": 20,
    "total_available": 487,
    "execution_time_ms": 45
  },
  "pagination": {
    "has_more": true,
    "suggested_filters": [
      "category: 'technical'",
      "Increase min_similarity",
      "Add metadata_filter"
    ]
  },
  "related_tools": ["get_context_insights"]
}
```

### List Memories (No More Results)

```typescript
// Request
const result = await callTool('memory', {
  operation: 'list',
  limit: 50,
  category: 'facts'
});

// Response
{
  "success": true,
  "data": [
    // ... 12 items
  ],
  "metadata": {
    "returned": 12,
    "total_available": 12,
    "execution_time_ms": 23
  }
  // No pagination section (all results fit)
}
```

### List Contexts with Related Tools

```typescript
// Request
const result = await callTool('context', {
  operation: 'list'
});

// Response
{
  "success": true,
  "data": [
    {
      "id": "ctx-456",
      "name": "Project Alpha",
      "memory_count": 15
    },
    // ... more contexts
  ],
  "metadata": {
    "returned": 5,
    "total_available": 5,
    "execution_time_ms": 18
  },
  "related_tools": ["search_context", "generate_context_graph"]
}
```

## Implementation Details

### Helper Function

All list/search handlers use `addPaginationToResponse()`:

```typescript
const responseData = addPaginationToResponse({
  items: results,
  limit: args.limit,
  totalAvailable: 487,  // Total count from database
  startTime: Date.now(),
  suggestedFilters: [
    'category: "facts"',
    'Add date range'
  ],
  relatedTools: ['get_context_insights']
});
```

### Total Count Strategy

**Option 1: Separate COUNT query (preferred)**
```typescript
// Count total
const countResult = await pool.query(
  'SELECT COUNT(*) FROM memories WHERE category = $1',
  [category]
);
const totalAvailable = parseInt(countResult.rows[0].count, 10);

// Fetch limited results
const results = await memoryService.listMemories(limit, category);

// Return with pagination
return addPaginationToResponse({
  items: results,
  limit,
  totalAvailable,
  startTime
});
```

**Option 2: Fallback to items.length**
```typescript
// When total count is expensive/unavailable
const results = await memoryService.listMemories(limit, category);

return addPaginationToResponse({
  items: results,
  limit,
  // totalAvailable omitted → uses results.length as fallback
  startTime
});
```

### Suggested Filters

Provide filter hints when results are truncated:

```typescript
const suggestedFilters = results.length === limit ? [
  'category: "facts"',        // Most common filter
  'Add date range filter',    // Temporal filter
  'Increase min_similarity',  // Quality filter
  'Add metadata_filter'       // Custom filter
] : undefined;
```

### Related Tools

Suggest contextually relevant tools:

- **Memory operations** → `['get_context_insights', 'generate_memory_insights']`
- **Context operations** → `['search_context', 'generate_context_graph']`
- **Search operations** → `['get_memory_graph', 'detect_contradictions']`
- **Snapshot operations** → `['compare_snapshots', 'get_context_insights']`

## Tools with Pagination Metadata

All list/search operations support pagination metadata:

### Core Tools
- `memory` (operations: `list`, `list_personal`)
- `search` (operations: `query`, `smart`, `similar`)
- `context` (operations: `list`, `search`)
- `snapshot` (operations: `list`, `list_temporal`)

### Analytics Tools
- `graph` (operations: `get`, `insights`)
- `contradictions` (operation: `detect`)

### RLM Tools
- `causality` (operations: `trace`, `get`)
- `temporal` (operations: `search`, `history`)
- `audit` (operations: `query`)

## Backward Compatibility

- All new fields are optional or have defaults
- Existing clients continue to work
- Old response format is a subset of new format
- No breaking changes to data structures

## Performance Considerations

### Execution Time
- Measured from tool call start to response ready
- Includes database queries, embedding lookups, and processing
- Typical range: 10-500ms

### Total Count Queries
- `COUNT(*)` can be expensive on large tables
- Consider caching counts for frequently accessed queries
- Use `EXPLAIN ANALYZE` to optimize count queries
- For very large datasets, approximate counts may be acceptable

### Suggested Filters
- Generated dynamically based on result set
- No additional database queries required
- Based on tool-specific knowledge of common filters

## Testing

Run pagination metadata tests:

```bash
npm test -- pagination-response.test.ts
```

**Test Coverage:**
- Response schema validation
- Execution time tracking
- Pagination logic (has_more calculation)
- Suggested filters generation
- Related tools suggestions
- Backward compatibility

## Migration Guide

### For New Tools

Use the helper function from the start:

```typescript
case 'list_something': {
  const startTime = Date.now();
  const results = await service.listSomething(limit);
  
  const response = addPaginationToResponse({
    items: results,
    limit,
    totalAvailable: results.length,  // Or query total count
    startTime,
    suggestedFilters: results.length === limit ? ['Add filter'] : undefined,
    relatedTools: ['related_tool_name']
  });
  
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response, null, 2)
    }]
  };
}
```

### For Existing Tools

1. Add `startTime` tracking at handler start
2. Wrap response with `addPaginationToResponse()`
3. Add total count query (optional but recommended)
4. Add suggested filters for truncated results
5. Add related tools suggestions

## Examples by Tool

### memory (list)
```json
{
  "metadata": {
    "returned": 10,
    "total_available": 487,
    "execution_time_ms": 34
  },
  "pagination": {
    "has_more": true,
    "suggested_filters": ["category: 'facts'", "Add date range"]
  },
  "related_tools": ["get_context_insights", "generate_memory_insights"]
}
```

### search (query)
```json
{
  "metadata": {
    "returned": 20,
    "total_available": 156,
    "execution_time_ms": 89
  },
  "pagination": {
    "has_more": true,
    "suggested_filters": [
      "Increase min_similarity",
      "Add category filter",
      "Add metadata_filter"
    ]
  },
  "related_tools": ["get_memory_graph", "detect_contradictions"]
}
```

### context (list)
```json
{
  "metadata": {
    "returned": 5,
    "total_available": 5,
    "execution_time_ms": 12
  },
  "related_tools": ["search_context", "generate_context_graph"]
}
```

## Future Enhancements

- **Cursor-based pagination**: For large result sets
- **Faceted search**: Pre-aggregate filter suggestions
- **Query cost estimation**: Predict execution time before running
- **Result caching**: Cache common queries with TTL
- **Streaming responses**: For very large result sets

---

**Related:**
- [Consolidated Tools](./tools/README.md)
- [Multi-Server Architecture](./servers/README.md)
- Performance Optimization Guide
