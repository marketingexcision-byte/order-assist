const PO_PATTERNS: RegExp[] = [
  /\b(?:P\/O|PO|PURCHASE\s*ORDER)\s*(?:NUMBER|NO|#|NUM)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i,
  /\b(?:ORDER\s*(?:NUMBER|NO|#)|O\/N)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i,
];

export function extractPoNumber(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ");
  for (const re of PO_PATTERNS) {
    const m = cleaned.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}
