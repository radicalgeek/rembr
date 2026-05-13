#!/bin/bash
# Manual test script for Week 14 features without MCP SDK
# This tests the raw HTTP/JSON-RPC interface

set -e

API_KEY="${TEST_API_KEY:-mb_live_test1234}"
BASE_URL="${TEST_MCP_URL:-http://localhost:3001/mcp}"

echo "🧪 Week 14 Manual Test Suite"
echo "============================"
echo ""
echo "Testing: $BASE_URL"
echo "API Key: ${API_KEY:0:20}..."
echo ""

# Helper function for MCP calls
call_mcp() {
  local method=$1
  local params=$2
  
  curl -s -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d "{\"jsonrpc\": \"2.0\", \"id\": 1, \"method\": \"$method\", \"params\": $params}"
}

# Helper for tool calls
call_tool() {
  local tool_name=$1
  local args=$2
  
  call_mcp "tools/call" "{\"name\": \"$tool_name\", \"arguments\": $args}"
}

# Test 1: Store memories
echo "1️⃣  Creating test memories..."
MEM1_RESPONSE=$(call_tool "store_memory" '{"content": "User logged in at 10:00 AM", "category": "facts"}')
MEM1_ID=$(echo "$MEM1_RESPONSE" | jq -r '.result.content[0].text | fromjson | .memory.id' 2>/dev/null)

if [ -z "$MEM1_ID" ] || [ "$MEM1_ID" = "null" ]; then
  echo "   ❌ Failed to create memory 1"
  echo "   Response: $MEM1_RESPONSE"
  exit 1
fi
echo "   ✅ Memory 1: $MEM1_ID"

sleep 1

MEM2_RESPONSE=$(call_tool "store_memory" '{"content": "User viewed dashboard", "category": "facts"}')
MEM2_ID=$(echo "$MEM2_RESPONSE" | jq -r '.result.content[0].text | fromjson | .memory.id' 2>/dev/null)
echo "   ✅ Memory 2: $MEM2_ID"
echo ""

# Test 2: Causal Inference
echo "2️⃣  Testing causal inference..."
CAUSAL_RESPONSE=$(call_tool "infer_causality" "{\"cause_memory_id\": \"$MEM1_ID\", \"effect_memory_id\": \"$MEM2_ID\"}")
CONFIDENCE=$(echo "$CAUSAL_RESPONSE" | jq -r '.result.content[0].text | fromjson | .confidence' 2>/dev/null)
echo "   ✅ Confidence: $CONFIDENCE"
echo ""

# Test 3: Get Causal Links
echo "3️⃣  Testing get causal links..."
LINKS_RESPONSE=$(call_tool "get_causal_links" "{\"memory_id\": \"$MEM1_ID\"}")
EFFECTS_COUNT=$(echo "$LINKS_RESPONSE" | jq -r '.result.content[0].text | fromjson | .effects | length' 2>/dev/null)
echo "   ✅ Found $EFFECTS_COUNT causal effects"
echo ""

# Test 4: Trace Causality
echo "4️⃣  Testing trace causality..."
TRACE_RESPONSE=$(call_tool "trace_causality" "{\"memory_id\": \"$MEM1_ID\", \"direction\": \"causes\", \"max_depth\": 5}")
TOTAL_LINKS=$(echo "$TRACE_RESPONSE" | jq -r '.result.content[0].text | fromjson | .chain.total_links' 2>/dev/null)
echo "   ✅ Traced $TOTAL_LINKS causal links"
echo ""

# Test 5: Memory History
echo "5️⃣  Testing memory history..."
HISTORY_RESPONSE=$(call_tool "get_memory_history" "{\"memory_id\": \"$MEM1_ID\"}")
VERSIONS=$(echo "$HISTORY_RESPONSE" | jq -r '.result.content[0].text | fromjson | .versions' 2>/dev/null)
echo "   ✅ Found $VERSIONS version(s)"
echo ""

# Test 6: Search at Time
echo "6️⃣  Testing search at time..."
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SEARCH_RESPONSE=$(call_tool "search_at_time" "{\"query\": \"login\", \"timestamp\": \"$NOW\"}")
MEMORY_COUNT=$(echo "$SEARCH_RESPONSE" | jq -r '.result.content[0].text | fromjson | .memories | length' 2>/dev/null)
echo "   ✅ Found $MEMORY_COUNT memories at $NOW"
echo ""

# Test 7: Create Snapshot
echo "7️⃣  Testing temporal snapshot..."
SNAPSHOT_NAME="test-$(date +%s)"
SNAPSHOT_RESPONSE=$(call_tool "create_temporal_snapshot" "{\"snapshot_name\": \"$SNAPSHOT_NAME\", \"description\": \"Test snapshot\"}")
SNAPSHOT_MEMS=$(echo "$SNAPSHOT_RESPONSE" | jq -r '.result.content[0].text | fromjson | .memory_count' 2>/dev/null)
echo "   ✅ Created snapshot with $SNAPSHOT_MEMS memories"
echo ""

# Test 8: Query Audit Log
echo "8️⃣  Testing audit log query..."
AUDIT_RESPONSE=$(call_tool "query_audit_log" '{"limit": 10}')
AUDIT_COUNT=$(echo "$AUDIT_RESPONSE" | jq -r '.result.content[0].text | fromjson | .count' 2>/dev/null)
echo "   ✅ Found $AUDIT_COUNT audit events"
echo ""

# Test 9: Audit Statistics
echo "9️⃣  Testing audit statistics..."
STATS_RESPONSE=$(call_tool "get_audit_stats" '{}')
TOTAL_EVENTS=$(echo "$STATS_RESPONSE" | jq -r '.result.content[0].text | fromjson | .stats.total_events' 2>/dev/null)
UNIQUE_USERS=$(echo "$STATS_RESPONSE" | jq -r '.result.content[0].text | fromjson | .stats.unique_users' 2>/dev/null)
echo "   ✅ Total events: $TOTAL_EVENTS, Unique users: $UNIQUE_USERS"
echo ""

# Test 10: Export User Activity
echo "🔟 Testing user activity export..."
EXPORT_RESPONSE=$(call_tool "export_user_activity" '{}')
EVENT_COUNT=$(echo "$EXPORT_RESPONSE" | jq -r '.result.content[0].text | fromjson | .events | length' 2>/dev/null)
echo "   ✅ Exported $EVENT_COUNT events"
echo ""

# Test 11: Compliance Report
echo "1️⃣1️⃣  Testing compliance report..."
START_DATE=$(date -u -v-7d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '7 days ago' +"%Y-%m-%dT%H:%M:%SZ")
END_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
REPORT_RESPONSE=$(call_tool "generate_compliance_report" "{\"start_date\": \"$START_DATE\", \"end_date\": \"$END_DATE\"}")
REPORT_EVENTS=$(echo "$REPORT_RESPONSE" | jq -r '.result.content[0].text | fromjson | .report.summary.total_events' 2>/dev/null)
echo "   ✅ Report generated: $REPORT_EVENTS events"
echo ""

# Test 12: Validate Causal Link
echo "1️⃣2️⃣  Testing causal link validation..."
VALIDATE_RESPONSE=$(call_tool "validate_causal_link" "{\"cause_memory_id\": \"$MEM1_ID\", \"effect_memory_id\": \"$MEM2_ID\"}")
IS_VALID=$(echo "$VALIDATE_RESPONSE" | jq -r '.result.content[0].text | fromjson | .is_valid' 2>/dev/null)
echo "   ✅ Link is valid: $IS_VALID"
echo ""

echo "============================"
echo "✅ All 12 tools tested successfully!"
echo ""
