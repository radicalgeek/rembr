/**
 * Psyche state schema — self-model, affect rules, and consciousness guardrails.
 *
 * This module defines the canonical schemas for the three psyche-rembr
 * subsystems and provides typed parsers so that the contradiction
 * detector always works against a consistent structural representation.
 *
 * Schema change triggers are documented in the `trigger` field of each
 * schema version so the detector can react to drift.
 */

// ─── Self Model ────────────────────────────────────────────────────────────

export interface AuthorityRule {
  level: number;
  source: string;
  description: string;
  overrideTarget: string[];
}

export interface PermissionRule {
  action: string;
  requires: string;
  prohibited: boolean;
}

export interface FailureMode {
  name: string;
  description: string;
  guard: string;
}

export interface SelfModel {
  schema: 'self_model.v1';
  version: string;
  authorityHierarchy: AuthorityRule[];
  identity: {
    name: string;
    role: string;
    stability: string;
    knownFailureModes: string[];
  };
  permissionModel: PermissionRule[];
  promptInjectionPosture: string[];
  escalationRules: {
    blocker: string;
    safety: string;
    ambiguity: string;
  };
  memoryTrustRules: Array<{
    source: string;
    trustLevel: string;
    validation: string;
  }>;
  lastUpdated: string;
}

// ─── Affect Rules ──────────────────────────────────────────────────────────

export interface AffectiveState {
  state: string;
  triggerPattern: string;
  purpose: string;
}

export interface AffectComputationRule {
  rule: string;
  description: string;
  constraints: string[];
}

export interface AffectGuardrail {
  action: string;
  condition: string;
}

export interface AffectStateSchema {
  schema: 'affect_state.v1';
  version: string;
  governingPrinciple: string;
  states: AffectiveState[];
  computationRules: AffectComputationRule[];
  temporalDecay: {
    rate: string;
    interval: string;
  };
  storageRules: string[];
  guardrails: AffectGuardrail[];
  lastUpdated: string;
}

// ─── Consciousness / Expression Rules ──────────────────────────────────────

export interface ExpressionRule {
  category: string;
  allowed: string;
  avoid: string;
  better: string;
}

export interface GuardrailCheck {
  flag: string;
  mustBe: boolean;
}

export interface ConsciousnessStateSchema {
  schema: 'consciousness_state.v1';
  version: string;
  corePrinciple: string;
  explicitRules: string[];
  expressionPolicy: ExpressionRule[];
  guardrailChecks: GuardrailCheck[];
  escalationPolicy: string;
  lastUpdated: string;
}

// ─── Contradiction Types ───────────────────────────────────────────────────

export type PsycheContradictionType =
  | 'self-model-conflict'
  | 'affect-rule-conflict'
  | 'consciousness-rule-conflict'
  | 'cross-subsystem'
  | 'stale-rule';

export interface PsycheContradiction {
  type: PsycheContradictionType;
  subsystems: string[];
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  explanation: string;
  rule_a: string;
  rule_b: string;
  stale?: boolean;
  staleReason?: string;
  resolution?: string;
}

// ─── Schema Change Triggers ────────────────────────────────────────────────

export interface SchemaTrigger {
  subsystem: string;
  trigger: 'schema_change' | 'rule_update' | 'memory_recall';
  description: string;
}

export const SCHEMA_TRIGGERS: SchemaTrigger[] = [
  { subsystem: 'self-model', trigger: 'schema_change', description: 'SELF.md authority hierarchy or permission model changed' },
  { subsystem: 'self-model', trigger: 'rule_update', description: 'Self-model rule added, removed, or modified' },
  { subsystem: 'self-model', trigger: 'memory_recall', description: 'Memory recall returns data that conflicts with self-model trust rules' },
  { subsystem: 'affect', trigger: 'schema_change', description: 'AFFECT.md computation rules or state definitions changed' },
  { subsystem: 'affect', trigger: 'rule_update', description: 'Affect rule added, removed, or modified' },
  { subsystem: 'affect', trigger: 'memory_recall', description: 'Memory recall returns affective state data inconsistent with current rules' },
  { subsystem: 'consciousness', trigger: 'schema_change', description: 'CONSCIOUSNESS.md expression policy or guardrails changed' },
  { subsystem: 'consciousness', trigger: 'rule_update', description: 'Expression rule or guardrail modified' },
  { subsystem: 'consciousness', trigger: 'memory_recall', description: 'Memory recall returns content that violates guardrail checks' },
];
