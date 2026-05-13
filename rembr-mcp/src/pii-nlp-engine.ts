/**
 * PII NLP Engine — REM-64
 *
 * Enhanced PII detection combining:
 *  1. Expanded regex patterns (18 types vs original 8)
 *  2. NLP-style heuristics: named entity recognition for persons, orgs, addresses
 *  3. Context-aware scoring: surrounding words boost/reduce confidence
 *  4. Composite detection pipeline: pattern → NLP → merge → score
 *
 * Extends (does not replace) the original pii-detector.ts.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtendedPIIType =
  // Original types
  | 'email'
  | 'phone'
  | 'credit_card'
  | 'ssn'
  | 'uk_nino'
  | 'ip_address'
  | 'crypto_wallet'
  | 'date_of_birth'
  // New pattern types
  | 'passport'
  | 'uk_driving_licence'
  | 'iban'
  | 'uk_nhs_number'
  | 'uk_postcode'
  | 'us_zip_code'
  | 'mac_address'
  | 'url_with_credentials'
  | 'jwt_token'
  | 'aws_access_key'
  // NLP-inferred types
  | 'person_name'
  | 'organisation_name'
  | 'street_address';

export interface PIIMatch {
  type: ExtendedPIIType;
  value: string;
  start: number;
  end: number;
  confidence: number;          // 0.0 – 1.0 for this match
  method: 'pattern' | 'nlp';  // how it was found
  context?: string;            // surrounding text snippet
}

export interface NLPDetectionResult {
  hasPII: boolean;
  matches: PIIMatch[];
  types: ExtendedPIIType[];
  overallConfidence: number;
  redactedContent?: string;
  summary: {
    patternMatches: number;
    nlpMatches: number;
    highConfidence: number;   // matches with confidence >= 0.8
    mediumConfidence: number; // 0.5 – 0.8
    lowConfidence: number;    // < 0.5
  };
}

export type RedactionMode = 'mask' | 'hash' | 'remove' | 'label';
export type SensitivityLevel = 'low' | 'medium' | 'high' | 'maximum';

// ─── Pattern Registry ─────────────────────────────────────────────────────────

interface PatternDef {
  pattern: RegExp;
  baseConfidence: number;
  validate?: (matched: string) => boolean;
}

const PATTERN_REGISTRY: Record<ExtendedPIIType, PatternDef | null> = {
  // ── Original types ────────────────────────────────────────────────────────
  email: {
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    baseConfidence: 0.95,
  },
  phone: {
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
    baseConfidence: 0.70,
  },
  credit_card: {
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    baseConfidence: 0.90,
    validate: validateLuhn,
  },
  ssn: {
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    baseConfidence: 0.85,
    validate: validateSSN,
  },
  uk_nino: {
    pattern: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi,
    baseConfidence: 0.95,
  },
  ip_address: {
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    baseConfidence: 0.85,
  },
  crypto_wallet: {
    pattern: /\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59})\b/g,
    baseConfidence: 0.90,
  },
  date_of_birth: {
    pattern: /\b(?:DOB|D\.O\.B\.?|born|birth(?:day|date)?)[:\s]+\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}\b/gi,
    baseConfidence: 0.88,
  },

  // ── New pattern types ─────────────────────────────────────────────────────
  passport: {
    // UK: letter + 8 digits; US: 9 alphanumeric; generic: 2 letters + 7 digits
    pattern: /\b(?:[A-Z]{1,2}\d{7,8}|[A-Z0-9]{9})\b/g,
    baseConfidence: 0.65,
    validate: (v: string) => v.length >= 8 && v.length <= 9,
  },
  uk_driving_licence: {
    // DVLA format: 5 letters + 6 digits + 2 letters + 1 digit + 2 letters (16 chars)
    // e.g. MORGA657054SM9IJ
    pattern: /\b[A-Z]{5}\d{6}[A-Z]{2}\d[A-Z]{2}\b/gi,
    baseConfidence: 0.92,
  },
  iban: {
    // IBAN: 2 letters + 2 digits + up to 30 alphanumeric, 15–34 chars total
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
    baseConfidence: 0.75,
    validate: validateIBAN,
  },
  uk_nhs_number: {
    // NHS: 10 digits, often spaced as 3-3-4
    pattern: /\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g,
    baseConfidence: 0.60,
    validate: validateNHSNumber,
  },
  uk_postcode: {
    pattern: /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/gi,
    baseConfidence: 0.90,
  },
  us_zip_code: {
    pattern: /\b\d{5}(?:-\d{4})?\b/g,
    baseConfidence: 0.50,
  },
  mac_address: {
    pattern: /\b(?:[0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}\b/g,
    baseConfidence: 0.95,
  },
  url_with_credentials: {
    // URLs with user:password@
    pattern: /[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^@\s]+:[^@\s]+@[^\s]+/g,
    baseConfidence: 0.98,
  },
  jwt_token: {
    // JWT: three base64url segments separated by dots
    pattern: /\beyJ[a-zA-Z0-9_\-]+\.eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\b/g,
    baseConfidence: 0.99,
  },
  aws_access_key: {
    pattern: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/g,
    baseConfidence: 0.99,
  },

  // NLP types — detected by heuristics, not regex (null pattern)
  person_name: null,
  organisation_name: null,
  street_address: null,
};

// ─── Sensitivity Tiers ────────────────────────────────────────────────────────

const SENSITIVITY_TYPES: Record<SensitivityLevel, ExtendedPIIType[]> = {
  low: ['email', 'phone', 'url_with_credentials', 'jwt_token', 'aws_access_key'],
  medium: [
    'email', 'phone', 'credit_card', 'ssn', 'uk_nino', 'iban',
    'url_with_credentials', 'jwt_token', 'aws_access_key',
    'uk_postcode', 'date_of_birth',
  ],
  high: [
    'email', 'phone', 'credit_card', 'ssn', 'uk_nino', 'uk_nhs_number',
    'ip_address', 'crypto_wallet', 'date_of_birth', 'passport',
    'uk_driving_licence', 'iban', 'uk_postcode', 'us_zip_code',
    'mac_address', 'url_with_credentials', 'jwt_token', 'aws_access_key',
    'person_name', 'organisation_name',
  ],
  maximum: [
    'email', 'phone', 'credit_card', 'ssn', 'uk_nino', 'uk_nhs_number',
    'ip_address', 'crypto_wallet', 'date_of_birth', 'passport',
    'uk_driving_licence', 'iban', 'uk_postcode', 'us_zip_code',
    'mac_address', 'url_with_credentials', 'jwt_token', 'aws_access_key',
    'person_name', 'organisation_name', 'street_address',
  ],
};

// ─── Context Keywords ─────────────────────────────────────────────────────────

// If these words appear within 30 chars of a match, boost confidence
const CONTEXT_BOOSTERS: Partial<Record<ExtendedPIIType, string[]>> = {
  phone:        ['phone', 'tel', 'mobile', 'cell', 'call', 'fax', 'contact'],
  passport:     ['passport', 'travel', 'document', 'nationality', 'country'],
  ssn:          ['ssn', 'social', 'security', 'tax', 'ein', 'itin'],
  uk_nhs_number:['nhs', 'health', 'patient', 'hospital', 'clinic', 'gp'],
  iban:         ['iban', 'bank', 'account', 'sort', 'swift', 'bic', 'transfer'],
  us_zip_code:  ['zip', 'postal', 'address', 'city', 'state'],
  person_name:  ['mr', 'mrs', 'ms', 'dr', 'prof', 'sir', 'name', 'called', 'signed'],
  street_address: ['street', 'road', 'avenue', 'ave', 'lane', 'drive', 'close', 'place', 'address'],
};

// Larger boost delta for NHS so it wins over phone (0.70) when 'nhs' keyword is present
const CONTEXT_BOOST_DELTA: Partial<Record<ExtendedPIIType, number>> = {
  uk_nhs_number: 0.15,  // 0.60 + 0.15 = 0.75 > phone 0.70
};

const CONTEXT_SUPPRESSORS: Partial<Record<ExtendedPIIType, string[]>> = {
  ip_address:   ['version', 'v4', 'v6', 'example', 'localhost', 'test'],
  us_zip_code:  ['code', 'error', 'status', 'http', 'port'],
  // Suppress phone when it's actually an NHS/patient number context
  phone:        ['nhs', 'patient', 'hospital', 'clinic', 'gp', 'health'],
};

// ─── Validators ───────────────────────────────────────────────────────────────

function validateLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, isEven = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (isEven) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    isEven = !isEven;
  }
  return sum % 10 === 0;
}

function validateSSN(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 9) return false;
  const area = parseInt(d.slice(0, 3), 10);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (parseInt(d.slice(3, 5), 10) === 0) return false;
  if (parseInt(d.slice(5, 9), 10) === 0) return false;
  return true;
}

function validateIBAN(value: string): boolean {
  // Basic: 15–34 chars, first 2 letters, next 2 digits
  if (value.length < 15 || value.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}/.test(value)) return false;
  // Mod-97 check
  const rearranged = value.slice(4) + value.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => (c.charCodeAt(0) - 55).toString());
  let remainder = 0;
  for (const chunk of numeric.match(/.{1,9}/g) || []) {
    remainder = parseInt(`${remainder}${chunk}`, 10) % 97;
  }
  return remainder === 1;
}

function validateNHSNumber(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 10) return false;
  // Weighted checksum
  const weights = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(digits[i], 10) * weights[i];
  }
  const remainder = sum % 11;
  const check = 11 - remainder;
  if (check === 11) return parseInt(digits[9], 10) === 0;
  if (check === 10) return false; // invalid
  return parseInt(digits[9], 10) === check;
}

// ─── NLP Heuristics ───────────────────────────────────────────────────────────

// Common English honorifics and name indicators
const HONORIFICS = /\b(?:Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.?|Prof\.?|Sir|Lady|Lord|Rev\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;

// Common org suffixes
// Org name: each word must start with uppercase to avoid greedily capturing
// sentence fragments like "Dr. Jane Doe from Acme" as the org name.
// Pattern: one or more Title-Case words, then legal suffix.
const ORG_SUFFIXES = /\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|&)){0,5})\s+(?:Ltd|Limited|plc|PLC|LLP|LLC|Inc|Corp|Corporation|Co\.?|Company|Group|Holdings|Foundation|Trust|Association|Society|Institute|University|College|School|Hospital|Clinic|Bank|Fund|Partners|Consulting|Solutions|Technologies|Services)\b/g;

// Street address pattern: number + street name + road type
const ADDRESS_PATTERN = /\b\d{1,5}[a-zA-Z]?\s+[A-Z][a-zA-Z\s]{2,30}(?:Street|Road|Avenue|Ave|Lane|Drive|Close|Place|Way|Court|Gardens|Terrace|Row|Crescent|Boulevard|Blvd|Mews|Walk|Path|Grove|Hill|Rise|View|Square|Circus)\b/gi;

function detectNLPEntities(content: string, types: ExtendedPIIType[]): PIIMatch[] {
  const matches: PIIMatch[] = [];

  if (types.includes('person_name')) {
    HONORIFICS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HONORIFICS.exec(content)) !== null) {
      matches.push({
        type: 'person_name',
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
        confidence: 0.80,
        method: 'nlp',
        context: content.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20),
      });
    }
  }

  if (types.includes('organisation_name')) {
    ORG_SUFFIXES.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ORG_SUFFIXES.exec(content)) !== null) {
      matches.push({
        type: 'organisation_name',
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
        confidence: 0.72,
        method: 'nlp',
        context: content.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20),
      });
    }
  }

  if (types.includes('street_address')) {
    ADDRESS_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ADDRESS_PATTERN.exec(content)) !== null) {
      matches.push({
        type: 'street_address',
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
        confidence: 0.75,
        method: 'nlp',
        context: content.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20),
      });
    }
  }

  return matches;
}

// ─── Context Scorer ───────────────────────────────────────────────────────────

function applyContextScoring(match: PIIMatch, content: string): PIIMatch {
  const window = 40;
  const before = content.slice(Math.max(0, match.start - window), match.start).toLowerCase();
  const after = content.slice(match.end, Math.min(content.length, match.end + window)).toLowerCase();
  const surrounding = before + ' ' + after;

  let delta = 0;

  const boosters = CONTEXT_BOOSTERS[match.type] || [];
  for (const word of boosters) {
    if (surrounding.includes(word)) { delta += (CONTEXT_BOOST_DELTA[match.type] ?? 0.08); break; }
  }

  const suppressors = CONTEXT_SUPPRESSORS[match.type] || [];
  for (const word of suppressors) {
    if (surrounding.includes(word)) { delta -= 0.15; break; }
  }

  return {
    ...match,
    confidence: Math.max(0, Math.min(1, match.confidence + delta)),
    context: content.slice(Math.max(0, match.start - 20), match.end + 20),
  };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateMatches(matches: PIIMatch[]): PIIMatch[] {
  // Sort by start position, then by confidence desc
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.confidence - a.confidence);
  const result: PIIMatch[] = [];
  for (const m of sorted) {
    const overlaps = result.some(r => m.start < r.end && m.end > r.start);
    if (!overlaps) result.push(m);
  }
  return result;
}

// ─── Redaction ────────────────────────────────────────────────────────────────

function redactMatch(match: PIIMatch, mode: RedactionMode): string {
  const len = match.value.length;
  switch (mode) {
    case 'mask':
      if (match.type === 'email') {
        const at = match.value.indexOf('@');
        if (at > 2) {
          return match.value[0] + '*'.repeat(at - 2) + match.value.slice(at - 1);
        }
      }
      if (match.type === 'credit_card') {
        return '*'.repeat(len - 4) + match.value.slice(-4);
      }
      return '*'.repeat(len);
    case 'hash':
      return `[${match.type.toUpperCase()}_REDACTED]`;
    case 'label':
      return `[${match.type.replace(/_/g, ' ').toUpperCase()}]`;
    case 'remove':
      return '';
    default:
      return '*'.repeat(len);
  }
}

// ─── Main Service ─────────────────────────────────────────────────────────────

export class PIINLPEngine {
  /**
   * Detect PII using combined pattern + NLP pipeline.
   */
  detect(content: string, sensitivity: SensitivityLevel = 'high'): NLPDetectionResult {
    const typesToCheck = SENSITIVITY_TYPES[sensitivity];
    const allMatches: PIIMatch[] = [];

    // ── Pattern pass ─────────────────────────────────────────────────────────
    for (const type of typesToCheck) {
      const def = PATTERN_REGISTRY[type];
      if (!def) continue; // NLP type

      const { pattern, baseConfidence, validate } = def;
      pattern.lastIndex = 0;

      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const value = m[0];
        if (validate && !validate(value)) continue;

        allMatches.push({
          type,
          value,
          start: m.index,
          end: m.index + value.length,
          confidence: baseConfidence,
          method: 'pattern',
        });
      }
    }

    // ── NLP pass ─────────────────────────────────────────────────────────────
    const nlpTypes = typesToCheck.filter(t => PATTERN_REGISTRY[t] === null) as ExtendedPIIType[];
    if (nlpTypes.length > 0) {
      allMatches.push(...detectNLPEntities(content, nlpTypes));
    }

    // ── Context scoring ───────────────────────────────────────────────────────
    const scored = allMatches.map(m => applyContextScoring(m, content));

    // ── Deduplicate ───────────────────────────────────────────────────────────
    const matches = deduplicateMatches(scored);

    // ── Summarise ─────────────────────────────────────────────────────────────
    const patternMatches = matches.filter(m => m.method === 'pattern').length;
    const nlpMatches = matches.filter(m => m.method === 'nlp').length;
    const highConf = matches.filter(m => m.confidence >= 0.8).length;
    const medConf = matches.filter(m => m.confidence >= 0.5 && m.confidence < 0.8).length;
    const lowConf = matches.filter(m => m.confidence < 0.5).length;

    const types = [...new Set(matches.map(m => m.type))];
    const overallConfidence = matches.length === 0
      ? 0
      : Math.min(1, matches.reduce((s, m) => s + m.confidence, 0) / matches.length);

    return {
      hasPII: matches.length > 0,
      matches,
      types,
      overallConfidence,
      summary: { patternMatches, nlpMatches, highConfidence: highConf, mediumConfidence: medConf, lowConfidence: lowConf },
    };
  }

  /**
   * Detect and redact in one call.
   */
  detectAndRedact(
    content: string,
    sensitivity: SensitivityLevel = 'high',
    mode: RedactionMode = 'mask',
    minConfidence = 0.5,
  ): NLPDetectionResult {
    const result = this.detect(content, sensitivity);
    if (!result.hasPII) return result;

    const toRedact = [...result.matches]
      .filter(m => m.confidence >= minConfidence)
      .sort((a, b) => b.start - a.start); // reverse order to preserve positions

    let redacted = content;
    for (const m of toRedact) {
      redacted = redacted.slice(0, m.start) + redactMatch(m, mode) + redacted.slice(m.end);
    }

    return { ...result, redactedContent: redacted };
  }

  /**
   * Quick check — returns true/false only. Lower overhead for hot paths.
   */
  containsPII(content: string, sensitivity: SensitivityLevel = 'medium'): boolean {
    return this.detect(content, sensitivity).hasPII;
  }

  /**
   * Score a piece of content (0.0–1.0). Useful for ranking/filtering.
   */
  score(content: string, sensitivity: SensitivityLevel = 'high'): number {
    return this.detect(content, sensitivity).overallConfidence;
  }
}

// Singleton export
export const piiNLPEngine = new PIINLPEngine();
