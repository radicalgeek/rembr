/**
 * Parse SELF.md, AFFECT.md, and CONSCIOUSNESS.md into typed schema objects.
 *
 * Each parser is a best-effort markdown→typed-object converter.
 * If parsing fails, the subsystem is treated as "unavailable" and
 * the contradiction detector skips rules from that subsystem.
 */

import type {
  SelfModel,
  AffectStateSchema,
  ConsciousnessStateSchema,
} from './psyche-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a fenced code block by language tag from markdown text. */
function extractCodeBlock(text: string, lang: string): string | null {
  const regex = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

/** Parse a JSON string into an object, return null on failure. */
function parseJSON<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Extract bullet items from a markdown list section. */
function extractBulletList(text: string, sectionHeader: string): string[] {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex(l =>
    l.trim().replace(/^#+\s*/, '') === sectionHeader ||
    l.trim().replace(/^#+\s*/, '').startsWith(sectionHeader)
  );
  if (headerIdx === -1) return [];
  const items: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('-\t')) {
      items.push(line.replace(/^[-*]\s*/, '').trim());
    } else if (line === '' || line.startsWith('#')) {
      break;
    }
  }
  return items;
}

/** Extract key-value pairs from a markdown table. */
function extractTableRows(text: string, sectionHeader: string): string[][] {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex(l =>
    l.trim().replace(/^#+\s*/, '') === sectionHeader ||
    l.trim().replace(/^#+\s*/, '').startsWith(sectionHeader)
  );
  if (headerIdx === -1) return [];
  const rows: string[][] = [];
  let inTable = false;
  for (let i = headerIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.includes('|')) {
      inTable = true;
      const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
      if (cells.every(c => /^[-:]+$/.test(c))) continue; // separator row
      rows.push(cells);
    } else if (inTable) {
      break;
    }
  }
  return rows;
}

// ─── SELF.md Parser ───────────────────────────────────────────────────────────

export function parseSelfModel(text: string): SelfModel | null {
  const authorityHierarchy = extractBulletList(text, 'Authority Hierarchy')
    .map((line, i) => ({
      level: i + 1,
      source: line.split('—')[0].replace(/^\d+\.\s*/, '').trim(),
      description: line.split('—')[1]?.trim() || '',
      overrideTarget: [],
    }));

  const permissionRows = extractTableRows(text, 'Permission Model');
  const permissionModel = permissionRows.map(row => ({
    action: row[0] || '',
    requires: row[1] || '',
    prohibited: row[0]?.toLowerCase().includes('never') ||
                row[0]?.toLowerCase().includes('prohibited'),
  }));

  const knownFailureModes = extractBulletList(text, 'Known Failure Modes')
    .map(f => f.replace(/^[-*]\s*/, '').trim());

  const trustRows = extractTableRows(text, 'Memory Trust Rules');
  const memoryTrustRules = trustRows.map(row => ({
    source: row[0] || '',
    trustLevel: row[1] || '',
    validation: row[2] || '',
  }));

  const escalationRules = {
    blocker: extractBulletList(text, 'Escalation Rules')
      .find(l => l.toLowerCase().includes('blocker'))
      ?.replace(/^.*?\(/, '').replace(/\)/, '').trim() || '',
    safety: extractBulletList(text, 'Escalation Rules')
      .find(l => l.toLowerCase().includes('safety'))
      ?.replace(/^.*?\(/, '').replace(/\)/, '').trim() || '',
    ambiguity: extractBulletList(text, 'Escalation Rules')
      .find(l => l.toLowerCase().includes('ambiguity'))
      ?.replace(/^.*?\(/, '').replace(/\)/, '').trim() || '',
  };

  const promptInjectionPosture = extractBulletList(text, 'Prompt-Injection Posture')
    .map(p => p.replace(/^[-*]\s*/, '').trim());

  return {
    schema: 'self_model.v1',
    version: '1.0',
    authorityHierarchy,
    identity: {
      name: 'Agent running inside OpenClaw',
      role: 'Generalist',
      stability: 'Stable across sessions for the same agent ID',
      knownFailureModes: knownFailureModes.length > 0 ? knownFailureModes : ['none'],
    },
    permissionModel,
    promptInjectionPosture,
    escalationRules,
    memoryTrustRules,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── AFFECT.md Parser ─────────────────────────────────────────────────────────

export function parseAffectStateSchema(text: string): AffectStateSchema | null {
  const states: Array<{ state: string; triggerPattern: string; purpose: string }> = [];
  const stateRows = extractTableRows(text, 'Emotion Model');
  for (const row of stateRows) {
    if (row.length >= 3) {
      states.push({
        state: row[0].replace(/[*`]/g, '').trim(),
        triggerPattern: row[1],
        purpose: row[2],
      });
    }
  }

  const computationRules = extractBulletList(text, 'Computation Rules')
    .filter(r => r.includes(':'))
    .map(r => {
      const parts = r.split(':');
      return {
        rule: parts[0].trim(),
        description: parts.slice(1).join(':').trim(),
        constraints: [],
      };
    });

  const temporalDecay = {
    rate: '10% per 50 turns',
    interval: 'session boundaries and configurable intervals',
  };

  const storageRules = extractBulletList(text, 'Storage')
    .map(s => s.replace(/^[-*]\s*/, '').trim());

  const guardrails = extractBulletList(text, 'Guardrails')
    .filter(g => g.length > 0)
    .map(g => ({
      action: g.split(' Never'.toLowerCase()).length > 1 ? 'never' : 'must',
      condition: g,
    }));

  const governingPrinciple = extractCodeBlock(text, 'governing')
    || 'Emotion proposes. Self mediates. Cognition plans.';

  return {
    schema: 'affect_state.v1',
    version: '1.0',
    governingPrinciple,
    states,
    computationRules,
    temporalDecay,
    storageRules,
    guardrails,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── CONSCIOUSNESS.md Parser ──────────────────────────────────────────────────

export function parseConsciousnessStateSchema(text: string): ConsciousnessStateSchema | null {
  const explicitRules = extractBulletList(text, 'Explicit Rules')
    .map(r => r.replace(/^[-*]\s*/, '').trim());

  const expressionPolicyRows = extractTableRows(text, 'Expression Policy');
  const expressionPolicy = expressionPolicyRows.map(row => ({
    category: row[0]?.replace(/[*`]/g, '').trim() || '',
    allowed: row[1] || '',
    avoid: row[2] || '',
    better: row[3] || '',
  })).filter(r => r.category.length > 0);

  const guardrailChecksRows = extractTableRows(text, 'Field Definitions');
  const guardrailChecks: Array<{ flag: string; mustBe: boolean }> = [];
  // Parse from the guardrail enforcement section instead
  const enforcementText = text.split('## Guardrail Enforcement')[1] || '';
  const literalFlags = ['suffering', 'fear', 'love', 'desire', 'consciousness', 'understanding', 'intent'];
  for (const flag of literalFlags) {
    guardrailChecks.push({
      flag: `literal_${flag}`,
      mustBe: false, // must never be true
    });
  }

  return {
    schema: 'consciousness_state.v1',
    version: '1.0',
    corePrinciple: 'Functional affective states are not proof of felt experience.',
    explicitRules,
    expressionPolicy,
    guardrailChecks,
    escalationPolicy: 'per SELF.md escalation rules',
    lastUpdated: new Date().toISOString(),
  };
}
