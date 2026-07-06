# Audit Logging Architecture

**REM-251** — Tamper-resistant audit trail for SOC2, HIPAA, and GDPR compliance.

---

## Overview

Rembr's audit logging system provides an **append-only, cryptographically-chained** audit trail that detects tampering attempts at the database level. All memory operations, API calls, and user actions are logged with:

1. **Hash chaining** — each record cryptographically links to the previous one
2. **Trigger-level immutability** — UPDATE and DELETE operations raise database exceptions
3. **Sequence gap detection** — identifies deleted records via sequential numbering
4. **Integrity verification API** — programmatic tamper detection

---

## Architecture

### Database Schema

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq_num BIGSERIAL,                    -- Sequential number for gap detection
  entry_hash TEXT,                      -- SHA-256 of this record
  prev_hash TEXT,                       -- entry_hash of the previous record
  tenant_id UUID,
  user_id UUID,
  agent_id VARCHAR(200),
  event_type VARCHAR(50),
  resource_type VARCHAR(50),
  resource_id UUID,
  action_result VARCHAR(20),            -- 'success' | 'failure' | 'denied'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- ... additional metadata fields ...
);
```

### Hash Chain

Each audit log entry contains:
- **`entry_hash`**: SHA-256 of the record's immutable fields
- **`prev_hash`**: Copy of the previous record's `entry_hash` (NULL for first record per tenant)

**Hash computation** (canonical field order):
```
entry_hash = SHA-256(
  id || '|' ||
  tenant_id || '|' ||
  user_id || '|' ||
  agent_id || '|' ||
  event_type || '|' ||
  resource_type || '|' ||
  resource_id || '|' ||
  action_result || '|' ||
  created_at_epoch || '|' ||
  (prev_hash || 'GENESIS')
)
```

### Trigger Functions

#### 1. `set_audit_entry_hash()` — BEFORE INSERT
Automatically computes `entry_hash` and `prev_hash` when a new audit log is inserted.

```sql
CREATE TRIGGER audit_set_hash
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_audit_entry_hash();
```

#### 2. `prevent_audit_modification()` — BEFORE UPDATE/DELETE
Raises an exception for any modification attempt:

```sql
CREATE TRIGGER audit_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_modification();
```

**Error message example:**
```
ERROR: Audit logs are immutable. UPDATE is not permitted on audit_logs (record id: abc123).
```

---

## Tamper Detection

### 1. Hash Mismatch
If a record's `entry_hash` no longer matches the recomputed hash, **the record was modified**.

**Detection:** `AuditLogger.verifyIntegrity()` recomputes hashes and compares.

### 2. Chain Break
If a record's `prev_hash` doesn't match the previous record's `entry_hash`, **the chain was broken** (either by inserting a fake record or modifying `prev_hash`).

**Detection:** `AuditLogger.verifyIntegrity()` checks `prev_hash` linkage using SQL `LAG()`.

### 3. Sequence Gap
If `seq_num` has missing values (e.g., 1, 2, 5, 6), **records 3 and 4 were deleted**.

**Detection:** `AuditLogger.detectGaps()` finds discontinuities in `seq_num`.

---

## API Usage

### Log an Audit Event

```typescript
import { AuditLogger } from './audit-logger.js';

const auditLogger = new AuditLogger(pool);

await auditLogger.log({
  tenantId: 'tenant-uuid',
  userId: 'user-uuid',
  eventType: 'memory.create',
  resourceType: 'memory',
  resourceId: 'memory-uuid',
  actionResult: 'success'
});
```

### Verify Chain Integrity

```typescript
const violations = await auditLogger.verifyIntegrity('tenant-uuid', 1000);

if (violations.length > 0) {
  console.error('Audit log tampered!', violations);
  // Example violation:
  // {
  //   seq_num: 42,
  //   id: 'record-uuid',
  //   violation_type: 'hash_mismatch',
  //   details: 'Entry hash mismatch: expected abc123, found def456'
  // }
}
```

### Detect Deleted Records

```typescript
const gaps = await auditLogger.detectGaps('tenant-uuid');

if (gaps.length > 0) {
  console.warn('Missing audit log records:', gaps);
  // Example gap:
  // {
  //   start_seq: 10,
  //   end_seq: 13,
  //   gap_size: 2  // records 11 and 12 are missing
  // }
}
```

---

## Compliance

### SOC2 (Security Trust Principle)
- **CC6.1**: Audit logs capture all security-relevant events (user actions, access attempts, failures)
- **CC6.2**: Audit logs are protected from unauthorized modification (immutability triggers)
- **CC6.3**: Audit logs are retained per retention policy (`retention_until` field)

### HIPAA (§164.312(b))
- **Audit Controls**: All access to PHI is logged with user ID, timestamp, and action result
- **Integrity**: Hash chaining detects unauthorized alterations (tamper-evident)

### GDPR (Article 32)
- **Security of Processing**: Audit logs track all data subject operations (read, update, delete)
- **Right to Access**: `exportUserActivity(tenantId, userId)` provides GDPR-compliant audit trail export

---

## Operational Notes

### Retention Policy
- Default retention: **7 years** (configurable via `retention_until` column)
- Cleanup: `cleanupExpiredLogs()` deletes expired records (requires elevated permissions to bypass immutability trigger)

### Superuser Override
- Database superusers CAN bypass triggers (this is a PostgreSQL limitation)
- **Mitigation**: Run integrity verification (`verifyIntegrity()`) on a schedule via cron
- **Detection**: Hash mismatches, chain breaks, or sequence gaps indicate tampering

### Performance
- **Write throughput**: Hash computation adds ~0.5ms per insert (negligible for <1000 logs/sec)
- **Chain verification**: Scales linearly with record count; recommend checking last 1000 records hourly
- **Gap detection**: Fast (single index scan on `seq_num`)

---

## Testing

Run audit logger tests:
```bash
npm test audit-logger.test.ts
```

Tests cover:
- Clean chain verification (no violations)
- Hash mismatch detection (tampered `entry_hash`)
- Chain break detection (tampered `prev_hash`)
- Sequence gap detection (deleted records)
- Immutability enforcement (blocked UPDATE/DELETE)

---

## Future Enhancements

1. **External audit log export** — periodic snapshots to S3 / external SIEM
2. **Blockchain anchoring** — publish Merkle root to immutable ledger for provable timestamping
3. **Per-tenant key rotation** — rotate hash signing keys with backward-compatible verification
4. **Real-time alerts** — trigger alerts on `verifyIntegrity()` violations

---

## Related Files

- `rembr-mcp/src/audit-logger.ts` — AuditLogger class
- `rembr-mcp/src/audit-logger.test.ts` — Unit tests
- `rembr-mcp/src/migrations/006-audit-tamper-resistance.sql` — Migration
- `deploy/k8s/01-enable-extensions.sql` — pgcrypto extension
- `deploy/k8s/06-create-triggers.sql` — Trigger definitions
