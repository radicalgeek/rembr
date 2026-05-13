/**
 * Smart Compression Service (REM-99 / RAD-84)
 *
 * Hierarchical content compression that preserves critical information
 * (decisions, user requests) while aggressively compressing filler
 * and acknowledgments.
 *
 * Key insight: Agent outputs should be compressed 1.5× more aggressively
 * than user inputs because agents tend to be more verbose.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ContentImportance =
  | 'decision'
  | 'user_request'
  | 'technical_detail'
  | 'acknowledgment'
  | 'filler';

export type ContentSource = 'user' | 'agent';

export interface CompressionRatios {
  decision?: number;          // Default 0.0 — preserve verbatim
  user_request?: number;      // Default 0.2 — 20% compression
  technical_detail?: number;  // Default 0.6 — 60% compression
  acknowledgment?: number;    // Default 0.9 — 90% compression
  filler?: number;            // Default 1.0 — remove entirely
}

export interface CompressionOptions {
  compression_ratios?: CompressionRatios;
  agent_compression_multiplier?: number; // Default 1.5
  target_ratio?: number;                 // Target overall compression ratio (0–1)
}

export interface ContentBlock {
  content: string;
  importance: ContentImportance;
  source: ContentSource;
  tokens: number;
  compression_ratio: number;
  will_be_compressed: boolean;
  compressed_content?: string;
}

export interface CompressionResult {
  original_tokens: number;
  compressed_tokens: number;
  compression_ratio: number;
  compressed_content: string;
  blocks_compressed: number;
  blocks_preserved: number;
  preserved_decisions: string[];
}

export interface PreviewResult {
  original_tokens: number;
  estimated_compressed_tokens: number;
  estimated_savings: number;
  blocks: ContentBlock[];
}

// ─── Default ratios ───────────────────────────────────────────────────────────

const DEFAULT_RATIOS: Required<CompressionRatios> = {
  decision: 0.0,
  user_request: 0.2,
  technical_detail: 0.6,
  acknowledgment: 0.9,
  filler: 1.0,
};

const DEFAULT_AGENT_MULTIPLIER = 1.5;

export const DEFAULT_COMPRESSION_CONFIG = {
  target_ratio: 0.5,
  compression_ratios: DEFAULT_RATIOS,
  agent_compression_multiplier: DEFAULT_AGENT_MULTIPLIER,
  preserve_decision_chains: true,
  store_compressed_content: true,
};

// ─── Importance classification ────────────────────────────────────────────────

const DECISION_PATTERNS = [
  /\b(decided?|decision|will use|going with|chose|chosen|approach is|strategy is|plan is)\b/i,
  // Consequential statements: "Therefore, we will implement..."
  /\b(therefore|thus|hence|consequently|accordingly)\b/i,
  // "The strategy: ...", "The approach: ..."
  /\b(strategy|architecture|approach|solution|pattern):\s/i,
  /\b(MUST|SHALL|CRITICAL|IMPORTANT|KEY|agreed)\b/,
  /^(Note:|Important:|Decision:|Agreed:|Conclusion:)/im,
];

const USER_REQUEST_PATTERNS = [
  /^(Please|Can you|Could you|I need|I want|I'd like|Help me|Make|Create|Fix|Update|Add)\b/i,
  /\?$/m,
];

const ACKNOWLEDGMENT_PATTERNS = [
  // Standalone acknowledgments, optionally followed by a short phrase
  /^(Okay,?|OK,?|Got it|Sure|Understood|Will do|Sounds good|Great|Perfect|Excellent|Absolutely|Of course|Certainly|Noted)(,?\s[\w\s,.]+)?[.,!]?\s*$/im,
  /^(Yes,?|No,?|Alright,?|Right,?)[.,!]?\s*$/im,
  // Common multi-word acknowledgment phrases
  /^(Thanks\b|Thank you\b)/i,
  /^I understand\b/i,
];

const FILLER_PATTERNS = [
  // Filler openers — match even when followed by more words (the block IS filler)
  /^(Um+[,.]?|Uh+[,.]?|Hmm+[,.]?)(\s|$)/i,
  // Well, So, Actually etc. — short filler phrases (full block)
  /^(Well,?|So,?|Actually,?|Basically,?)[.,!]?\s*(\w[\w\s.,]*)?[.,!]?\s*$/im,
  // "Just a second / moment"
  /\bjust a (second|moment)\b/i,
  /^(Let me|I'll go ahead|I'm going to|Allow me)\b.{0,30}$/im,
  // Very short standalone greetings/interjections with no informational content
  /^(hi|hey|hello|yo)[.,!]?\s*$/i,
];

export function estimateTokens(text: string): number {
  // ~4 characters per token (GPT-4 approximation)
  return Math.ceil(text.length / 4);
}

/** @internal */
function classifyImportance(text: string): ContentImportance {
  const trimmed = text.trim();

  for (const pattern of DECISION_PATTERNS) {
    if (pattern.test(trimmed)) return 'decision';
  }

  for (const pattern of USER_REQUEST_PATTERNS) {
    if (pattern.test(trimmed)) return 'user_request';
  }

  for (const pattern of ACKNOWLEDGMENT_PATTERNS) {
    if (pattern.test(trimmed)) return 'acknowledgment';
  }

  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(trimmed)) return 'filler';
  }

  return 'technical_detail';
}

/**
 * Classify text by content importance. The source param is accepted for API
 * symmetry but does not affect classification (source affects compression ratio,
 * not the importance label).
 */
export function classifyContentImportance(
  text: string,
  _source?: ContentSource,
): ContentImportance {
  return classifyImportance(text);
}

function compressText(text: string, ratio: number): string {
  if (ratio <= 0) return text;
  if (ratio >= 1) return '';

  // Try sentence-level compression first
  const sentences = text.split(/(?<=[.!?])\s+/);
  const keepCount = Math.max(1, Math.round(sentences.length * (1 - ratio)));

  if (sentences.length > 1 && keepCount < sentences.length) {
    // Keep first and last sentences, compress middle
    const kept: string[] = [];
    const half = Math.floor(keepCount / 2);

    kept.push(...sentences.slice(0, half));
    if (keepCount > half) {
      kept.push(...sentences.slice(sentences.length - (keepCount - half)));
    }

    const result = kept.join(' ');
    return result + (result.endsWith('.') ? '..' : '...');
  }

  // Fallback: truncate by character count for single-sentence or unstructured blocks
  const keepChars = Math.max(1, Math.round(text.length * (1 - ratio)));
  if (keepChars >= text.length) return text;
  return text.slice(0, keepChars) + '...';
}

/**
 * Split content into classified ContentBlock objects.
 */
export function splitIntoBlocks(
  content: string,
  source: ContentSource,
  options: CompressionOptions = {},
): ContentBlock[] {
  const ratios: Required<CompressionRatios> = {
    ...DEFAULT_RATIOS,
    ...options.compression_ratios,
  };
  const agentMultiplier = options.agent_compression_multiplier ?? DEFAULT_AGENT_MULTIPLIER;

  // Split on paragraph breaks or list items; fall back to single newlines for
  // short content (≤3 lines) so tests with \n-only content get multiple blocks.
  const rawBlocks = content.includes('\n\n')
    ? content.split(/\n{2,}|\n(?=[-*•]\s)/)
    : content.split('\n');

  return rawBlocks
    .map(b => b.trim())
    .filter(b => b.length > 0)
    .map(b => {
      const importance = classifyImportance(b);
      const tokens = estimateTokens(b);
      let baseRatio = ratios[importance];
      if (source === 'agent') {
        baseRatio = Math.min(1, baseRatio * agentMultiplier);
      }
      return {
        content: b,
        importance,
        source,
        tokens,
        compression_ratio: baseRatio,
        will_be_compressed: baseRatio > 0,
      } satisfies ContentBlock;
    });
}

/** @internal — raw string split without classification */
function _splitRaw(content: string): string[] {
  return content
    .split(/\n{2,}|\n(?=[-*•]\s)/)
    .map(b => b.trim())
    .filter(b => b.length > 0);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compress content using hierarchical summarization.
 */
export async function compressContent(
  content: string,
  source: ContentSource,
  options: CompressionOptions = {},
): Promise<CompressionResult> {
  const blocks = splitIntoBlocks(content, source, options);
  const processedBlocks: ContentBlock[] = [];
  const preservedDecisions: string[] = [];

  let compressedCount = 0;
  let preservedCount = 0;

  for (const block of blocks) {
    const compressed = compressText(block.content, block.compression_ratio);

    processedBlocks.push({
      ...block,
      compressed_content: compressed,
    });

    if (block.importance === 'decision') {
      preservedDecisions.push(block.content);
    }

    if (block.will_be_compressed) {
      compressedCount++;
    } else {
      preservedCount++;
    }
  }

  // Assemble compressed output
  const compressedParts = processedBlocks
    .map(b => b.compressed_content ?? b.content)
    .filter(t => t.length > 0);

  const compressedContent = compressedParts.join('\n\n');
  const originalTokens = estimateTokens(content);
  const compressedTokens = estimateTokens(compressedContent);

  return {
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    compression_ratio: originalTokens > 0 ? 1 - compressedTokens / originalTokens : 0,
    compressed_content: compressedContent,
    blocks_compressed: compressedCount,
    blocks_preserved: preservedCount,
    preserved_decisions: preservedDecisions,
  };
}

/**
 * Preview what compression would do without applying it.
 */
export async function previewCompression(
  content: string,
  source: ContentSource,
  options: CompressionOptions = {},
): Promise<PreviewResult> {
  const processedBlocks = splitIntoBlocks(content, source, options);

  const originalTokens = processedBlocks.reduce((sum, b) => sum + b.tokens, 0);
  const estimatedCompressedTokens = processedBlocks.reduce(
    (sum, b) => sum + Math.round(b.tokens * (1 - b.compression_ratio)),
    0,
  );

  return {
    original_tokens: originalTokens,
    estimated_compressed_tokens: estimatedCompressedTokens,
    estimated_savings: originalTokens > 0 ? 1 - estimatedCompressedTokens / originalTokens : 0,
    blocks: processedBlocks,
  };
}
