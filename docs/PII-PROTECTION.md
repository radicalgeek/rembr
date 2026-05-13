# PII Protection

**Rembr PII Protection System**  
**Last Updated**: February 2026

Rembr provides two complementary layers of PII protection: a **rule-based engine** for known patterns and a **NLP engine** for natural-language context-aware detection.

---

## Overview

| Layer | Tool | Detection Method | Coverage |
|-------|------|-----------------|----------|
| Rule-based | `pii` | Regex + pattern rules | Structured PII (NI, credit cards, emails) |
| NLP engine | `pii_nlp_detect` / `pii_nlp_redact` / `pii_nlp_score` | Context-aware NLP + regex | Structured + natural-language PII |

Both layers are **plan-gated** — daily scan limits apply per tier (see Plan Limits below).

---

## NLP Engine

The NLP engine (`PIINLPEngine`) detects **21 PII types** organised into 4 sensitivity tiers.

### Sensitivity Tiers

| Tier | Level | Types |
|------|-------|-------|
| **4** | Critical | NI number, passport, UK driving licence, credit card, bank account + sort code |
| **3** | High | Email address, phone number, IP address, date of birth |
| **2** | Medium | Person name, organisation name, street address, postcode, NHS number |
| **1** | Low | Date, time, age, currency amount, URL, generic ID |

### Detection Modes

The engine uses three detection strategies:

1. **Pattern matching** — compiled regex for structured PII (cards, NI, passport, etc.)
2. **NLP heuristics** — context window analysis for names, orgs, addresses
3. **Context scoring** — boosts confidence when context words are present (e.g. "my name is", "works at")

### Confidence Scoring

Each detection has a confidence score (0–1). Context clues improve confidence:

| Context Signal | Confidence Boost |
|----------------|-----------------|
| "my name is" / "I'm" | +0.2 |
| "works at" / "employed by" | +0.2 |
| "address is" / "lives at" | +0.2 |
| "born on" / "DOB" | +0.15 |
| Title prefix (Mr/Dr/Prof) | +0.1 |

### Deduplication

When two detections share the same start position, only the highest-confidence match survives. This prevents overlapping captures (e.g. a title-qualified person name and an organisation name starting at the same offset).

### UK-Specific Patterns

The engine is tuned for UK data formats:
- **NI**: `AB123456C` format
- **Driving licence**: 16-char DVLA format (`MORGA657054SM9IJ`)
- **Postcode**: `SW1A 2AA` format
- **Phone**: UK landline and mobile with +44 / 07xxx formats
- **NHS number**: 10-digit format with Luhn-like validation

---

## Usage

### Detect PII in text

```json
{
  "tool": "pii_nlp_detect",
  "arguments": {
    "text": "Contact Dr. Jane Smith at jane.smith@example.com or call 07700 900123.",
    "min_confidence": 0.5
  }
}
```

**Response:**
```json
{
  "detections": [
    { "type": "person_name", "value": "Jane Smith", "start": 11, "end": 21, "confidence": 0.8, "sensitivity_tier": 2 },
    { "type": "email_address", "value": "jane.smith@example.com", "start": 25, "end": 47, "confidence": 0.95, "sensitivity_tier": 3 },
    { "type": "phone_number", "value": "07700 900123", "start": 58, "end": 70, "confidence": 0.9, "sensitivity_tier": 3 }
  ],
  "summary": { "total": 3, "by_tier": { "2": 1, "3": 2 }, "highest_tier": 3 }
}
```

### Redact PII

```json
{
  "tool": "pii_nlp_redact",
  "arguments": {
    "text": "Send the invoice to John Doe at john@acme.com",
    "mode": "mask"
  }
}
```

**Response:**
```json
{
  "redacted_text": "Send the invoice to [PERSON_NAME] at [EMAIL_ADDRESS]",
  "redaction_count": 2,
  "detections": [...]
}
```

### Score text for PII risk

```json
{
  "tool": "pii_nlp_score",
  "arguments": {
    "text": "My NI number is AB123456C and my card is 4532 1234 5678 9012"
  }
}
```

**Response:**
```json
{
  "score": 87,
  "tier": 4,
  "detection_count": 2,
  "type_breakdown": { "ni_number": 1, "credit_card": 1 }
}
```

---

## Rule-Based Engine (`pii` tool)

The `pii` tool provides faster, lower-overhead detection for well-structured PII using pure regex matching.

| Operation | Description |
|-----------|-------------|
| `detect` | Find PII in text |
| `redact` | Replace PII with placeholders |
| `analyze` | Detailed analysis with confidence |
| `scan_memory` | Scan a stored memory by ID |
| `report` | Tenant-wide PII report |

Use the **rule-based engine** when:
- You need fast scanning at high volume
- Input is well-structured (forms, database exports)
- You're scanning for specific known patterns

Use the **NLP engine** when:
- Input is free-form natural language
- You need name/org/address extraction
- You need sensitivity scoring for content policies

---

## Plan Limits

| Plan | PII Scans/day | NLP Detections/day |
|------|--------------|-------------------|
| Dev (Free) | 100 | 100 |
| Pro | 10,000 | 10,000 |
| Team | 100,000 | 100,000 |
| Enterprise | Unlimited | Unlimited |

Exceeding limits returns `PLAN_LIMIT_EXCEEDED`.

---

## Analytics

Use `get_pii_analytics` to track:
- Detection rate over time
- Type distribution (which PII types appear most)
- Redaction coverage
- Tier distribution (how sensitive your data is)

---

## Compliance Notes

- PII scans are logged in the audit trail (tamper-resistant, hash-chained)
- Redacted text is never stored — only the redaction metadata
- All PII operations are tenant-isolated via RLS
- For GDPR "right to erasure": combine `pii scan_memory` + `memory delete` to identify and remove sensitive memories
