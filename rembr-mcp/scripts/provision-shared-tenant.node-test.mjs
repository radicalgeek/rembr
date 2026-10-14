import assert from "node:assert/strict"
import test from "node:test"
import { buildSharedTenantProvisioning } from "./provision-shared-tenant.mjs"

const config = {
  tenant: { name: "Fixture Workspace", email: "workspace@example.test", plan: "team" },
  projects: [
    { name: "Group One", description: "First fixture workstream" },
    { name: "Group Two", description: "Second fixture workstream" },
  ],
  users: [
    { name: "Fixture User One", email: "user.one@example.test", role: "admin", projects: ["Group One"], keyName: "fixture-one" },
    { name: "Fixture User Two", email: "user.two@example.test", projects: ["Group One"], keyName: "fixture-two" },
    { name: "Fixture User Three", email: "user.three@example.test", projects: ["Group Two"], keyName: "fixture-three" },
  ],
}

const suppliedKeys = [
  `mb_live_${"A".repeat(64)}`,
  `mb_live_${"B".repeat(64)}`,
  `mb_live_${"C".repeat(64)}`,
]

test("creates one active tenant with distinct user-bound HMAC credentials and project memberships", () => {
  const result = buildSharedTenantProvisioning(config, {
    apiKeySecret: "fixture-secret-that-is-long-enough-for-hmac",
    suppliedKeys,
  })

  assert.equal(result.users.length, 3)
  assert.equal(result.projects.length, 2)
  assert.match(result.sql, /status, claimed_at, created_by_agent/)
  assert.match(result.sql, /'active', NOW\(\), FALSE/)
  assert.equal((result.sql.match(/INSERT INTO project_members/g) || []).length, 3)
  assert.equal((result.sql.match(/, TRUE, '[0-9a-f-]+'\);/g) || []).length, 2)
  assert.ok(!result.sql.includes(", FALSE, NULL);"))
  assert.equal((result.sql.match(/INSERT INTO api_keys/g) || []).length, 3)
  assert.equal((result.sql.match(/INSERT INTO api_keys \(tenant_id, project_id, user_id/g) || []).length, 3)
  assert.equal((result.sql.match(/VALUES \('[^']+', NULL, '[^']+'/g) || []).length, 3)
  assert.equal((result.sql.match(/'hmac-sha256'/g) || []).length, 3)
  for (const key of suppliedKeys) {
    assert.ok(!result.sql.includes(key))
    assert.ok(result.sql.includes(key.slice(0, 20)))
  }
})

test("fails closed for unknown projects, duplicate users, and a missing HMAC secret", () => {
  assert.throws(() => buildSharedTenantProvisioning(config), /API_KEY_SECRET/)
  assert.throws(() => buildSharedTenantProvisioning({
    ...config,
    users: [{ ...config.users[0], projects: ["Missing Group"] }],
  }, { apiKeySecret: "fixture-secret-that-is-long-enough-for-hmac" }), /unknown project/)
  assert.throws(() => buildSharedTenantProvisioning({
    ...config,
    users: [config.users[0], { ...config.users[1], email: config.users[0].email }],
  }, { apiKeySecret: "fixture-secret-that-is-long-enough-for-hmac" }), /duplicate user email/)
})

test("fails closed when a configured project has no members", () => {
  assert.throws(() => buildSharedTenantProvisioning({
    ...config,
    users: config.users.map(user => ({ ...user, projects: ["Group One"] })),
  }, { apiKeySecret: "fixture-secret-that-is-long-enough-for-hmac" }), /project has no members/)
})

test("defaults each key name to a neutral per-user label", () => {
  const result = buildSharedTenantProvisioning({
    ...config,
    users: config.users.map(({ keyName, ...user }) => user),
  }, { apiKeySecret: "fixture-secret-that-is-long-enough-for-hmac", suppliedKeys })

  for (const label of ["user-1", "user-2", "user-3"]) {
    assert.ok(result.sql.includes(Buffer.from(label, "utf8").toString("base64")))
  }
  assert.ok(!result.sql.includes(Buffer.from("fixture-one", "utf8").toString("base64")))
})
