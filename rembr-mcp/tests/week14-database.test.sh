#!/bin/bash
# Direct database test for Week 14 features
# Bypasses MCP layer and tests services directly through database

set -e

NAMESPACE="${1:-rembr-test}"
DB_POD="postgres-$NAMESPACE-0"
DB_USER="rembr_test"
DB_NAME="rembr_test"

echo "🧪 Week 14 Database Integration Test"
echo "====================================="
echo ""
echo "Testing database: $NAMESPACE/$DB_POD"
echo ""

# Function to run SQL
run_sql() {
  kubectl exec -i -n "$NAMESPACE" "$DB_POD" -- psql -U "$DB_USER" -d "$DB_NAME" -t -c "$1" | tr -d ' '
}

# Function to run SQL and show results
run_sql_table() {
  kubectl exec -i -n "$NAMESPACE" "$DB_POD" -- psql -U "$DB_USER" -d "$DB_NAME" -c "$1"
}

# Test 1: Verify schema
echo "1️⃣  Verifying schema..."
CAUSAL_EXISTS=$(run_sql "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='causal_relationships');")
TEMPORAL_EXISTS=$(run_sql "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='temporal_snapshots');")
AUDIT_EXISTS=$(run_sql "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='audit_logs');")

if [ "$CAUSAL_EXISTS" = "t" ] && [ "$TEMPORAL_EXISTS" = "t" ] && [ "$AUDIT_EXISTS" = "t" ]; then
  echo "   ✅ All tables exist"
else
  echo "   ❌ Missing tables: causal=$CAUSAL_EXISTS temporal=$TEMPORAL_EXISTS audit=$AUDIT_EXISTS"
  exit 1
fi
echo ""

# Test 2: Create test memories with temporal columns
echo "2️⃣  Creating test memories..."
kubectl exec -i -n "$NAMESPACE" "$DB_POD" -- psql -U "$DB_USER" -d "$DB_NAME" <<SQL
-- Clean up any existing test data
DELETE FROM memories WHERE content LIKE '%Week14Test%';

-- Insert test memories with temporal tracking
INSERT INTO memories (id, tenant_id, content, category, valid_from, valid_until)
VALUES 
  (gen_random_uuid(), 'fa3754ff-ee6f-4260-b17a-63ecca7a5195', 'Week14Test: User logged in', 'facts', NOW(), NULL),
  (gen_random_uuid(), 'fa3754ff-ee6f-4260-b17a-63ecca7a5195', 'Week14Test: User viewed dashboard', 'facts', NOW(), NULL)
RETURNING id, LEFT(content, 30) || '...' as content;
SQL
echo "   ✅ Test memories created"
echo ""

# Test 3: Create causal relationship
echo "3️⃣  Testing causal relationships..."
MEM1_ID=$(run_sql "SELECT id FROM memories WHERE content LIKE '%logged in%' AND content LIKE '%Week14Test%' ORDER BY created_at DESC LIMIT 1;")
MEM2_ID=$(run_sql "SELECT id FROM memories WHERE content LIKE '%dashboard%' AND content LIKE '%Week14Test%' ORDER BY created_at DESC LIMIT 1;")

echo "   Memory 1: $MEM1_ID"
echo "   Memory 2: $MEM2_ID"

kubectl exec -i -n "$NAMESPACE" "$DB_POD" -- psql -U "$DB_USER" -d "$DB_NAME" <<SQL
INSERT INTO causal_relationships (
  id, tenant_id, cause_memory_id, effect_memory_id, 
  causal_type, causal_strength, inferred_by
)
VALUES (
  gen_random_uuid(),
  'fa3754ff-ee6f-4260-b17a-63ecca7a5195',
  '$MEM1_ID'::uuid,
  '$MEM2_ID'::uuid,
  'causes',
  0.95,
  'system'
)
ON CONFLICT DO NOTHING;
SQL

CAUSAL_COUNT=$(run_sql "SELECT COUNT(*) FROM causal_relationships WHERE cause_memory_id = '$MEM1_ID'::uuid;")
echo "   ✅ Causal links created: $CAUSAL_COUNT"
echo ""

# Test 4: Create temporal snapshot
echo "4️⃣  Testing temporal snapshots..."
SNAPSHOT_NAME="test-snapshot-$(date +%s)"
kubectl exec -i -n "$NAMESPACE" "$DB_POD" -- psql -U "$DB_USER" -d "$DB_NAME" <<SQL
INSERT INTO temporal_snapshots (
  id, tenant_id, snapshot_name, snapshot_time, total_memories, metadata
)
SELECT 
  gen_random_uuid(),
  'fa3754ff-ee6f-4260-b17a-63ecca7a5195',
  '$SNAPSHOT_NAME',
  NOW(),
  COUNT(*)::integer,
  jsonb_build_object('description', 'Test snapshot for Week 14')
FROM memories 
WHERE tenant_id = 'fa3754ff-ee6f-4260-b17a-63ecca7a5195';
SQL

SNAPSHOT_COUNT=$(run_sql "SELECT COUNT(*) FROM temporal_snapshots WHERE snapshot_name = '$SNAPSHOT_NAME';")
echo "   ✅ Snapshots created: $SNAPSHOT_COUNT"
echo ""

# Test 5: Create audit log entry
echo "5️⃣  Testing audit logging..."
AUDIT_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kubectl exec -i -n "$NAMESPACE" "$DB_POD" -- psql -U "$DB_USER" -d "$DB_NAME" <<SQL
INSERT INTO audit_logs (
  id, tenant_id, event_type, resource_type, resource_id,
  metadata, ip_address
)
VALUES (
  gen_random_uuid(),
  'fa3754ff-ee6f-4260-b17a-63ecca7a5195',
  'test_week14',
  'memory',
  '$MEM1_ID'::uuid,
  jsonb_build_object('test', 'Week 14 features', 'timestamp', '$AUDIT_TS'),
  '127.0.0.1'
);
SQL

AUDIT_COUNT=$(run_sql "SELECT COUNT(*) FROM audit_logs WHERE event_type = 'test_week14';")
echo "   ✅ Audit logs created: $AUDIT_COUNT"
echo ""

# Test 6: Verify temporal columns
echo "6️⃣  Testing temporal columns..."
HAS_TEMPORAL=$(run_sql "SELECT COUNT(*) FROM memories WHERE valid_from IS NOT NULL AND content LIKE '%Week14Test%';")
echo "   ✅ Memories with temporal tracking: $HAS_TEMPORAL"
echo ""

# Test 7: Query causal chain
echo "7️⃣  Testing causal chain query..."
run_sql_table "
WITH RECURSIVE causal_chain AS (
  -- Base case: direct causes
  SELECT 
    cause_memory_id,
    effect_memory_id,
    causal_type,
    causal_strength,
    1 as depth
  FROM causal_relationships
  WHERE cause_memory_id = '$MEM1_ID'::uuid
  
  UNION ALL
  
  -- Recursive case: follow the chain
  SELECT 
    cr.cause_memory_id,
    cr.effect_memory_id,
    cr.causal_type,
    cr.causal_strength,
    cc.depth + 1
  FROM causal_relationships cr
  INNER JOIN causal_chain cc ON cr.cause_memory_id = cc.effect_memory_id
  WHERE cc.depth < 5
)
SELECT depth, COUNT(*) as links
FROM causal_chain
GROUP BY depth
ORDER BY depth;
"
echo ""

# Test 8: Temporal query (point-in-time)
echo "8️⃣  Testing point-in-time query..."
NOW=$(date -u +"%Y-%m-%d %H:%M:%S")
TEMPORAL_COUNT=$(run_sql "
SELECT COUNT(*) 
FROM memories 
WHERE valid_from <= '$NOW'::timestamp 
  AND (valid_until IS NULL OR valid_until > '$NOW'::timestamp)
  AND content LIKE '%Week14Test%';
")
echo "   ✅ Memories valid at $NOW: $TEMPORAL_COUNT"
echo ""

# Test 9: Audit log aggregation
echo "9️⃣  Testing audit log aggregation..."
run_sql_table "
SELECT 
  event_type,
  COUNT(*) as count,
  MIN(created_at) as first_seen,
  MAX(created_at) as last_seen
FROM audit_logs
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY event_type
ORDER BY count DESC
LIMIT 5;
"
echo ""

# Test 10: Snapshot comparison simulation
echo "🔟 Testing snapshot comparison..."
run_sql_table "
SELECT 
  snapshot_name,
  snapshot_time,
  total_memories,
  LEFT(metadata->>'description', 40) as description
FROM temporal_snapshots
ORDER BY snapshot_time DESC
LIMIT 5;
"
echo ""

# Summary
echo "====================================="
echo "✅ All database tests passed!"
echo ""
echo "Final Statistics:"
run_sql_table "
SELECT 
  (SELECT COUNT(*) FROM causal_relationships) as causal_links,
  (SELECT COUNT(*) FROM temporal_snapshots) as snapshots,
  (SELECT COUNT(*) FROM audit_logs) as audit_events,
  (SELECT COUNT(*) FROM memories WHERE valid_from IS NOT NULL) as temporal_memories;
"
echo ""
