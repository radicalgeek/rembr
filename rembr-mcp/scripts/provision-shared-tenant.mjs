#!/usr/bin/env node

import crypto from "node:crypto"
import fs from "node:fs"
import { pathToFileURL } from "node:url"

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const PLANS = {
  free: { memory: 1000, search: 10000, project: 5 },
  pro: { memory: 25000, search: 250000, project: 25 },
  team: { memory: 250000, search: 2500000, project: 999 },
  business: { memory: 1000000, search: 10000000, project: 999 },
  enterprise: { memory: 2147483647, search: 2147483647, project: 2147483647 },
}

function randomAlphanumeric(length) {
  let out = ""
  const unbiasedLimit = 256 - (256 % ALPHANUMERIC.length)
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length - out.length)) {
      if (byte < unbiasedLimit) out += ALPHANUMERIC[byte % ALPHANUMERIC.length]
    }
  }
  return out
}

function bounded(value, label, max = 255) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const result = value.trim()
  if (!result || result.length > max || /[\0\r\n]/.test(result)) {
    throw new Error(`${label} must contain 1-${max} printable characters`)
  }
  return result
}

function email(value, label) {
  const result = bounded(value, label).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+$/.test(result)) throw new Error(`${label} must be a valid email`)
  return result
}

const encoded = value => Buffer.from(value, "utf8").toString("base64")
const decodedSql = value => `convert_from(decode('${encoded(value)}', 'base64'), 'UTF8')`

export function buildSharedTenantProvisioning(config, options = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("configuration must be an object")
  }
  const secret = options.apiKeySecret
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("API_KEY_SECRET must contain at least 32 characters")
  }

  const tenantName = bounded(config.tenant?.name, "tenant.name")
  const tenantEmail = email(config.tenant?.email, "tenant.email")
  const plan = bounded(config.tenant?.plan || "team", "tenant.plan", 32).toLowerCase()
  if (!Object.hasOwn(PLANS, plan)) throw new Error(`tenant.plan must be one of: ${Object.keys(PLANS).join(", ")}`)

  if (!Array.isArray(config.users) || config.users.length < 1 || config.users.length > 50) {
    throw new Error("users must contain 1-50 entries")
  }
  if (!Array.isArray(config.projects) || config.projects.length > 50) {
    throw new Error("projects must contain at most 50 entries")
  }

  const projectNames = new Set()
  const projects = config.projects.map((project, index) => {
    const name = bounded(project?.name, `projects[${index}].name`)
    const key = name.toLowerCase()
    if (projectNames.has(key)) throw new Error(`duplicate project name: ${name}`)
    projectNames.add(key)
    return {
      id: crypto.randomUUID(),
      name,
      description: bounded(project?.description || `${name} workstream`, `projects[${index}].description`, 1000),
    }
  })

  const userEmails = new Set()
  const suppliedKeys = options.suppliedKeys || []
  if (suppliedKeys.length > 0 && suppliedKeys.length !== config.users.length) {
    throw new Error("suppliedKeys must match the number of users")
  }
  const users = config.users.map((user, index) => {
    const userEmail = email(user?.email, `users[${index}].email`)
    if (userEmails.has(userEmail)) throw new Error(`duplicate user email: ${userEmail}`)
    userEmails.add(userEmail)
    const role = bounded(user?.role || "member", `users[${index}].role`, 32).toLowerCase()
    if (!new Set(["admin", "member"]).has(role)) throw new Error(`users[${index}].role must be admin or member`)
    const memberships = Array.isArray(user?.projects) ? user.projects.map(name => bounded(name, `users[${index}].projects`)) : []
    for (const projectName of memberships) {
      if (!projectNames.has(projectName.toLowerCase())) throw new Error(`unknown project for ${userEmail}: ${projectName}`)
    }
    const apiKey = suppliedKeys[index] || `mb_live_${randomAlphanumeric(64)}`
    if (!/^mb_live_[A-Za-z0-9]{64}$/.test(apiKey)) throw new Error(`users[${index}] API key has an invalid format`)
    return {
      id: crypto.randomUUID(),
      name: bounded(user?.name, `users[${index}].name`),
      email: userEmail,
      role,
      memberships,
      keyName: bounded(user?.keyName || `user-${index + 1}`, `users[${index}].keyName`),
      apiKey,
      keyHash: crypto.createHmac("sha256", secret).update(apiKey).digest("hex"),
      keyPrefix: apiKey.slice(0, 20),
    }
  })

  for (const project of projects) {
    if (!users.some(user => user.memberships.some(name => name.toLowerCase() === project.name.toLowerCase()))) {
      throw new Error(`project has no members: ${project.name}`)
    }
  }

  const tenantId = crypto.randomUUID()
  const limits = PLANS[plan]
  const statements = [
    "BEGIN;",
    `SELECT pg_advisory_xact_lock(hashtextextended('rembr-shared-tenant:' || ${decodedSql(tenantEmail)}, 0));`,
    `DO $guard$ BEGIN IF EXISTS (SELECT 1 FROM tenants WHERE lower(email) = lower(${decodedSql(tenantEmail)})) THEN RAISE EXCEPTION 'shared tenant email already exists'; END IF; END $guard$;`,
    `INSERT INTO tenants (id, name, email, plan, status, claimed_at, created_by_agent) VALUES ('${tenantId}', ${decodedSql(tenantName)}, ${decodedSql(tenantEmail)}, '${plan}', 'active', NOW(), FALSE);`,
    `INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit) VALUES ('${tenantId}', '${plan}', ${limits.memory}, ${limits.search}, ${limits.project});`,
  ]

  for (const user of users) {
    statements.push(
      `INSERT INTO users (id, tenant_id, email, name, role, platform_role, status) VALUES ('${user.id}', '${tenantId}', ${decodedSql(user.email)}, ${decodedSql(user.name)}, '${user.role}', 'user', 'active');`,
    )
  }
  for (const project of projects) {
    const creator = users.find(user => user.memberships.some(name => name.toLowerCase() === project.name.toLowerCase()))
    statements.push(
      `INSERT INTO projects (id, tenant_id, name, description, created_by, is_personal, owner_id) VALUES ('${project.id}', '${tenantId}', ${decodedSql(project.name)}, ${decodedSql(project.description)}, '${creator.id}', TRUE, '${creator.id}');`,
    )
    for (const user of users.filter(candidate => candidate.memberships.some(name => name.toLowerCase() === project.name.toLowerCase()))) {
      statements.push(
        `INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ('${project.id}', '${user.id}', 'member', '${creator.id}');`,
      )
    }
  }
  for (const user of users) {
    statements.push(
      `INSERT INTO api_keys (tenant_id, project_id, user_id, key_hash, key_prefix, hash_algorithm, name, expires_at, purpose, capabilities) VALUES ('${tenantId}', NULL, '${user.id}', '${user.keyHash}', '${user.keyPrefix}', 'hmac-sha256', ${decodedSql(user.keyName)}, NULL, 'standard', ARRAY['memory:read','memory:write','context:manage','snapshot:manage']::TEXT[]);`,
    )
  }
  statements.push("COMMIT;")

  return {
    sql: `${statements.join("\n")}\n`,
    tenantId,
    users: users.map(user => ({ id: user.id, name: user.name, email: user.email, apiKey: user.apiKey })),
    projects: projects.map(project => ({ id: project.id, name: project.name })),
  }
}

function loadConfiguration(environment) {
  if (environment.SHARED_TENANT_CONFIG) return JSON.parse(environment.SHARED_TENANT_CONFIG)
  if (environment.SHARED_TENANT_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(environment.SHARED_TENANT_CONFIG_PATH, "utf8"))
  }
  throw new Error("SHARED_TENANT_CONFIG or SHARED_TENANT_CONFIG_PATH is required")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = buildSharedTenantProvisioning(loadConfiguration(process.env), {
      apiKeySecret: process.env.API_KEY_SECRET,
    })
    process.stdout.write(result.sql)
    process.stderr.write(`${JSON.stringify({
      tenant_id: result.tenantId,
      users: result.users,
      projects: result.projects,
    })}\n`)
  } catch (error) {
    process.stderr.write(`Shared tenant provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
