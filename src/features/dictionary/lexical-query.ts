const EDGE_NOISE = "[.,;:!?'\"`()\\[\\]{}<>«»“”‘’。，、；：！？（）【】《》「」『』—–…~·\\s]+";
const LEADING_EDGE_RE = new RegExp(`^${EDGE_NOISE}`, "u");
const TRAILING_EDGE_RE = new RegExp(`${EDGE_NOISE}$`, "u");
const SENTENCE_CLAUSE_PUNCTUATION_RE = /[.,;:!?。，、；：！？…]/;
const SENTENCE_TERMINATOR_RE = /[.!?。！？…]/;
const LETTER_RE = /\p{L}/u;
const URL_RE = /^(?:https?:\/\/|www\.)/i;
const CJK_KANA_HANGUL_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const MAX_INLINE_WORDS = 3;
const MAX_INLINE_LATIN_CHARS = 48;
const MAX_INLINE_CJK_CHARS = 6;
const MAX_INLINE_CJK_TOTAL_CHARS = 12;

const MAX_SELECTION_WORDS = 5;
const MAX_SELECTION_LATIN_CHARS = 48;
const MAX_SELECTION_CJK_CHARS = 12;
const MAX_SELECTION_CJK_SPACES = 3;

const MAX_CONTEXT_SENTENCE_CHARS = 240;

export interface ContextSentenceInput {
  fullText: string;
  start?: number;
  end?: number;
  term?: string;
}

interface LexicalLimits {
  allowOuterEdgeNoise: boolean;
  maxWords: number;
  maxLatinChars: number;
  maxCjkNonSpaceChars: number;
  maxCjkSpaces: number;
}

const INLINE_LIMITS: LexicalLimits = {
  allowOuterEdgeNoise: false,
  maxWords: MAX_INLINE_WORDS,
  maxLatinChars: MAX_INLINE_LATIN_CHARS,
  maxCjkNonSpaceChars: MAX_INLINE_CJK_CHARS,
  maxCjkSpaces: 2,
};

const SELECTION_LIMITS: LexicalLimits = {
  allowOuterEdgeNoise: true,
  maxWords: MAX_SELECTION_WORDS,
  maxLatinChars: MAX_SELECTION_LATIN_CHARS,
  maxCjkNonSpaceChars: MAX_SELECTION_CJK_CHARS,
  maxCjkSpaces: MAX_SELECTION_CJK_SPACES,
};

/** Strips outer punctuation/quotes and collapses internal whitespace into single spaces. */
export function normalizeLookupTerm(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const stripped = collapsed.replace(LEADING_EDGE_RE, "").replace(TRAILING_EDGE_RE, "");
  return stripped.replace(/\s+/g, " ").trim();
}

function matchesLexicalLimits(raw: string, limits: LexicalLimits): boolean {
  if (!raw || /[\r\n]/.test(raw)) return false;
  const trimmed = raw.trim();
  if (!trimmed || URL_RE.test(trimmed) || !LETTER_RE.test(trimmed)) return false;
  if (!limits.allowOuterEdgeNoise && SENTENCE_CLAUSE_PUNCTUATION_RE.test(trimmed)) return false;

  const normalized = normalizeLookupTerm(trimmed);
  if (!normalized || URL_RE.test(normalized) || !LETTER_RE.test(normalized)) return false;
  if (SENTENCE_CLAUSE_PUNCTUATION_RE.test(normalized)) return false;

  if (CJK_KANA_HANGUL_RE.test(normalized)) {
    const nonSpaceLength = normalized.replace(/\s+/g, "").length;
    const spaceCount = (normalized.match(/\s+/g) ?? []).length;
    const limit = limits.allowOuterEdgeNoise
      ? limits.maxCjkNonSpaceChars
      : Math.min(limits.maxCjkNonSpaceChars, MAX_INLINE_CJK_TOTAL_CHARS);
    return nonSpaceLength <= limit && spaceCount <= limits.maxCjkSpaces;
  }

  const words = normalized.split(/\s+/);
  return words.length <= limits.maxWords && normalized.length <= limits.maxLatinChars;
}

/** Returns true when whole source input represents a single word or compact phrase for inline dictionary lookup. */
export function isInlineLexicalQuery(raw: string): boolean {
  return matchesLexicalLimits(raw, INLINE_LIMITS);
}

/** Returns true when selected text looks like a word or short phrase worth offering a dictionary lookup pill for. */
export function isSelectionLookupCandidate(raw: string): boolean {
  return matchesLexicalLimits(raw, SELECTION_LIMITS);
}

function isSentenceBoundaryAt(text: string, index: number): boolean {
  const ch = text[index];
  if (!ch) return false;
  if (ch === "\n" || ch === "\r") return true;
  if (!SENTENCE_TERMINATOR_RE.test(ch)) return false;
  if (ch === ".") {
    const prev = index > 0 ? text[index - 1] : "";
    const next = index + 1 < text.length ? text[index + 1] : "";
    if (/\d/.test(prev) && /\d/.test(next)) return false;
  }
  return true;
}

function resolveAnchorRange(input: ContextSentenceInput): { start: number; end: number } | null {
  const { fullText } = input;
  if (typeof input.start === "number" && typeof input.end === "number") {
    const low = Math.max(0, Math.min(input.start, input.end));
    const high = Math.min(fullText.length, Math.max(input.start, input.end));
    return { start: low, end: high };
  }
  if (!input.term) return null;

  const candidates = [input.term, normalizeLookupTerm(input.term)].filter(Boolean);
  const lowerFull = fullText.toLowerCase();
  for (const candidate of candidates) {
    const idx = lowerFull.indexOf(candidate.toLowerCase());
    if (idx !== -1) {
      return { start: idx, end: idx + candidate.length };
    }
  }
  return null;
}

/** Extracts the sentence surrounding a selected span or lookup term, returning undefined when no broader context exists. */
export function extractContextSentence(input: ContextSentenceInput): string | undefined {
  if (!input.fullText.trim()) return undefined;
  const anchor = resolveAnchorRange(input);
  if (!anchor) return undefined;

  let sentenceStart = 0;
  for (let i = anchor.start - 1; i >= 0; i--) {
    if (isSentenceBoundaryAt(input.fullText, i)) {
      sentenceStart = i + 1;
      break;
    }
  }

  let sentenceEnd = input.fullText.length;
  for (let i = anchor.end; i < input.fullText.length; i++) {
    const ch = input.fullText[i];
    if (ch === "\n" || ch === "\r") {
      sentenceEnd = i;
      break;
    }
    if (isSentenceBoundaryAt(input.fullText, i)) {
      sentenceEnd = i + 1;
      break;
    }
  }

  const rawSentence = input.fullText.slice(sentenceStart, sentenceEnd);
  const sentence = rawSentence.replace(/\s+/g, " ").trim();
  if (!sentence) return undefined;

  const selectedText = input.term ?? input.fullText.slice(anchor.start, anchor.end);
  if (
    normalizeLookupTerm(sentence).toLowerCase() === normalizeLookupTerm(selectedText).toLowerCase()
  ) {
    return undefined;
  }

  if (sentence.length > MAX_CONTEXT_SENTENCE_CHARS) {
    return `${sentence.slice(0, MAX_CONTEXT_SENTENCE_CHARS - 1).trimEnd()}…`;
  }
  return sentence;
}
