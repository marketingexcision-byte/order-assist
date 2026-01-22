import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --------------------
// Types
// --------------------

type ExtractInput = {
  from: string;
  to: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: any;
  attachmentText?: string;
};

export type LineItem = {
  // REQUIRED. Downstream depends on these.
  rawText: string; // this must be mapping-safe. Prefer code-only.
  quantity: number;

  // OPTIONAL. Keep fields separate so we don't mix code + description.
  description?: string;

  supplierItemCode?: string; // often what you want as rawText
  supplierCode?: string;
  itemCode?: string;
  partNo?: string;
  vendorPn?: string;
  barcode?: string;

  // IMPORTANT: customer reference only. Never use for Excisions/Shopify SKU matching.
  customerProductCode?: string;

  // Debugging aid
  _source?: "table" | "pattern" | "ai";
};

export type DeliveryAddress = {
  attention?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
  phone?: string | null;
  instructions?: string | null;
  raw?: string | null; // keep the original captured block for traceability
};

export type ExtractedPendingOrder = {
  poNumber: string | null;
  vendor: string | null;
  notes: string | null;
  deliveryAddress?: DeliveryAddress | null;
  deliveryAddressSource?: "HEURISTIC" | "AI" | "MANUAL" | null;
  lineItems: LineItem[];
};


// --------------------
// Config
// --------------------

const DEBUG = process.env.DEBUG_EXTRACT === "1";

// Don’t let garbage patterns create fake “line items”.
const ENABLE_PATTERN_PARSER = false;

// Clip for AI
const AI_MAX_CHARS = 12000;

const FREIGHT_LINE_RE = /\b(freight|shipping|postage|delivery|courier|transport|handling|carriage|fuel\s*(levy|surcharge)|surcharge)\b/i;

function isFreightOrShippingLine(rawText: string): boolean {
  const t = String(rawText || "").trim();
  if (!t) return false;

  // avoid dumb false positives
  if (/\bfreightliner\b/i.test(t)) return false;

  return FREIGHT_LINE_RE.test(t);
}


// --------------------
// Public API
// --------------------

export async function extractPendingOrderFromEmail(
  input: ExtractInput
): Promise<ExtractedPendingOrder> {
  const emailBody =
    input.textBody?.trim() || stripHtmlToText(input.htmlBody || "");
  const attachmentText = (input.attachmentText || "").trim();

  // Combine. Attachments often contain the PO table.
  const combined = [emailBody, attachmentText]
    .filter(Boolean)
    .join("\n\n--- ATTACHMENTS ---\n\n");

  if (!combined) throw new Error("No email body or attachment text to parse");

  const normalized = normalizeText(combined);

  if (DEBUG) {
    console.log("[emailExtract] normalized chars=", normalized.length);
    console.log(
      "[emailExtract] normalized preview=",
      normalized.slice(0, 900)
    );
  }

  // 1) Deterministic PO number
  const poNumber = extractPoNumber(normalized);

  // 1b) Deterministic delivery address (only when explicitly labelled)
  const detDelivery = extractDeliveryAddressHeuristic(normalized);
  const deliveryAddress =
    detDelivery.address && detDelivery.confidence >= 0.6 ? detDelivery.address : null;


  // 2) Deterministic line items (table-first)
  const detTable = heuristicParseTableLineItems(normalized);

  const detPattern = ENABLE_PATTERN_PARSER
    ? heuristicParseXPatterns(normalized)
    : [];

  const detLineItems = dedupeLineItems([...detTable, ...detPattern])
    .map(enforceMappingSafeRawText)
    .filter((li) => li.rawText && li.quantity > 0)
    .filter((li) => !isFreightOrShippingLine(li.rawText) && !isFreightOrShippingLine(li.description || ""));


  if (DEBUG) {
    console.log("[emailExtract] detLineItems count=", detLineItems.length);
    console.log(
      "[emailExtract] detLineItems preview=",
      detLineItems.slice(0, 6)
    );
  }

  if (detLineItems.length) {
    return {
      poNumber,
      vendor: null,
      notes: null,
      deliveryAddress,
      deliveryAddressSource: deliveryAddress ? "HEURISTIC" : null,
      lineItems: detLineItems,
    };
  }


  // 3) AI fallback
  const clipped =
    normalized.length > AI_MAX_CHARS
      ? normalized.slice(0, AI_MAX_CHARS)
      : normalized;

  const ai = await aiExtract(clipped, input);

  // Prefer deterministic delivery address over AI. AI is allowed only if explicitly labelled.
  const deliveryMarkersPresent =
    /(ship[-\s]*to(?:\s*address)?|ship\s*to|shipping\s*address|deliver\s*to\s*address|delivery\s*address|send\s*direct|drop\s*ship(?:ping)?|deliver\s*to\s*:|deliver\s*to|consignee|destination)\b/i.test(normalized);

  const mergedDeliveryAddress =
    deliveryAddress ||
    (deliveryMarkersPresent ? (ai as any).deliveryAddress ?? null : null);


  // Deterministic safety pass. Force rawText to be code-only if possible.
  const cleanedAi = (ai.lineItems || [])
    .map(enforceMappingSafeRawText)
    .filter((li) => li.rawText && li.quantity > 0)
    .filter((li) => !isFreightOrShippingLine(li.rawText) && !isFreightOrShippingLine(li.description || ""));


  // Fill PO number if AI missed it
  if (!ai.poNumber && poNumber) ai.poNumber = poNumber;

  return {
    poNumber: ai.poNumber ?? null,
    vendor: ai.vendor ?? null,
    notes: ai.notes ?? null,
    deliveryAddress: mergedDeliveryAddress,
    deliveryAddressSource: mergedDeliveryAddress
      ? (deliveryAddress ? "HEURISTIC" : "AI")
      : null,
    lineItems: cleanedAi.length
      ? cleanedAi.map((li) => ({ ...li, _source: "ai" }))
      : [],
  };
}

// --------------------
// AI extraction
// --------------------

async function aiExtract(clipped: string, input: ExtractInput): Promise<ExtractedPendingOrder> {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      poNumber: { type: ["string", "null"] },
      vendor: { type: ["string", "null"] },
      notes: { type: ["string", "null"] },
      deliveryAddress: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          attention: { type: ["string", "null"] },
          company: { type: ["string", "null"] },
          line1: { type: ["string", "null"] },
          line2: { type: ["string", "null"] },
          suburb: { type: ["string", "null"] },
          state: { type: ["string", "null"] },
          postcode: { type: ["string", "null"] },
          country: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          instructions: { type: ["string", "null"] },
          raw: { type: ["string", "null"] },
        },
        required: [
          "attention",
          "company",
          "line1",
          "line2",
          "suburb",
          "state",
          "postcode",
          "country",
          "phone",
          "instructions",
          "raw",
        ],
      },

      lineItems: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            rawText: { type: "string" },
            quantity: { type: "number" },

            // Keep separated fields
            description: { type: ["string", "null"] },

            supplierItemCode: { type: ["string", "null"] },
            supplierCode: { type: ["string", "null"] },
            itemCode: { type: ["string", "null"] },
            partNo: { type: ["string", "null"] },
            vendorPn: { type: ["string", "null"] },
            barcode: { type: ["string", "null"] },

            // Customer internal reference ONLY
            customerProductCode: { type: ["string", "null"] },
          },
          // IMPORTANT: strict schema requires required include EVERY key in properties
          required: [
            "rawText",
            "quantity",
            "description",
            "supplierItemCode",
            "supplierCode",
            "itemCode",
            "partNo",
            "vendorPn",
            "barcode",
            "customerProductCode",
          ],
        },
      },
    },
    required: ["poNumber", "vendor", "notes", "deliveryAddress", "lineItems"],

  } as const;

  const resp = await client.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "Extract purchase order line items from the email text. Output ONLY JSON matching the schema. " +
          "CRITICAL RULES:\n" +
          "1) Keep codes separate from descriptions.\n" +
          "2) rawText must be CODE-ONLY whenever any code exists on the line. Examples: '18405', '3502532200H'.\n" +
          "3) Put human text into description.\n" +
          "4) Quantity goes ONLY into quantity.\n" +
          "5) If code is missing, rawText may be a short description.\n" +
          "6) 'Our Product Code' or 'Product Code' is the CUSTOMER internal reference. Put it in customerProductCode. Never treat it as an Excisions/Shopify SKU.\n" +
          "7) Excisions SKUs/codes are mostly numeric. Prefer numeric-heavy tokens as the code when unsure.\n" +
          "8) deliveryAddress must be null unless the document explicitly labels a delivery address block using terms like 'Delivery Address', 'Deliver to', 'Deliver to address', 'Send Direct', or 'Drop Ship'.\n" +
          "9) If deliveryAddress is present, populate as many fields as possible, and set raw to the exact captured block text.\n" +
          "10) Do NOT include freight, shipping, delivery, postage, handling, or surcharge lines as lineItems. Those are charges, not products.\n"

      },
      {
        role: "user",
        content: [
          `From: ${input.from}`,
          `To: ${input.to}`,
          input.subject ? `Subject: ${input.subject}` : "",
          "",
          "EMAIL + ATTACHMENT TEXT:",
          clipped,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "pending_order_extract",
        strict: true,
        schema,
      },
    },
  });

  const out = resp.output_text;
  if (!out) throw new Error("Empty AI response");

  return JSON.parse(out) as ExtractedPendingOrder;
}

// --------------------
// Deterministic parsing
// --------------------

function extractDeliveryAddressHeuristic(text: string): { address: DeliveryAddress | null; confidence: number } {
  const t = (text || "").replace(/\r/g, "");

  // Hard gate. Only attempt if explicit delivery markers exist.
  const markerRe =
    /(ship[-\s]*to(?:\s*address)?|ship\s*to|shipping\s*address|deliver\s*to\s*address|delivery\s*address|deliver\s*to\s*:|deliver\s*to|send\s*direct|drop\s*ship(?:ping)?|consignee|destination)\b/i;

  if (!markerRe.test(t)) return { address: null, confidence: 0 };

  // Capture blocks after delivery headers. Stop at common section boundaries.
  const patterns: RegExp[] = [
    /Deliver to address\s*\n([\s\S]{1,600}?)(?:\n\s*(?:Purchase Order Number|Purchase Order date|Order Date|Delivery Instructions|Supplier Address|Billing Details|Subtotal|Total|GST|Page\s+\d+|Item Code|Line\b))/i,
    /Delivery Address:\s*\n([\s\S]{1,600}?)(?:\n\s*(?:Delivery Instructions:|Order Date:|Purchased By:|Billing Details:|Subtotal:|Tax:|AUD Total:|Supplier Details:|Line\b))/i,
    /DELIVER TO\s*:\s*\n([\s\S]{1,600}?)(?:\n\s*(?:ORDER NO\.|DATE|SHIP DATE|REFERENCE|PAGE|SUBTOTAL|GST|TOTAL|QTY\b))/i,
    // fallback: deliver to: <block> until blank line
    /Deliver\s*to\s*:\s*\n([\s\S]{1,600}?)(?:\n\s*\n)/i,
    /Ship[-\s]*to\s*address\s*:?\s*\n([\s\S]{1,600}?)(?:\n\s*(?:Purchase Order Number|Purchase Order date|Order Date|Delivery Instructions|Supplier Address|Billing Details|Subtotal|Total|GST|Page\s+\d+|Item Code|Line\b))/i,
    /Ship\s*To\s*:?\s*\n([\s\S]{1,600}?)(?:\n\s*(?:Purchase Order Number|Purchase Order date|Order Date|Delivery Instructions|Supplier Address|Billing Details|Subtotal|Total|GST|Page\s+\d+|Item Code|Line\b))/i,

  ];

  const candidates: string[] = [];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) candidates.push(m[1].trim());
  }

  if (candidates.length === 0) return { address: null, confidence: 0.2 };

  const raw = candidates.sort((a, b) => b.length - a.length)[0];

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const address: DeliveryAddress = { raw };

  // Phone
  const phoneMatch = raw.match(/(?:phone|ph|tel)\s*[:\-]?\s*([+()0-9][0-9()\s\-]{6,})/i);
  if (phoneMatch?.[1]) address.phone = phoneMatch[1].trim();

  // Instructions
  const instrMatch = raw.match(/(?:instructions|deliver(?:y)?\s*instructions)\s*[:\-]?\s*(.{10,240})/i);
  if (instrMatch?.[1]) address.instructions = instrMatch[1].trim();

  // AU State + postcode
  const stateRe = /\b(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b/i;
  for (const l of lines) {
    const st = l.match(stateRe);
    if (st) address.state = st[1].toUpperCase();
    const pc = l.match(/\b(\d{4})\b/);
    if (pc) address.postcode = pc[1];
  }
  if (address.state && !address.country) address.country = "Australia";

  // Structure
  if (lines[0]) address.company = lines[0];
  if (lines[1]) address.line1 = lines[1];

  // Prefer line2 only if it doesn't look like suburb/state/postcode
  if (lines[2]) {
    const l2 = lines[2];
    const looksLikeSuburbLine = stateRe.test(l2) || /\b\d{4}\b/.test(l2);
    if (!looksLikeSuburbLine) address.line2 = l2;
  }

  // suburb guess. first unused line with letters that is not company/line1/line2
  const used = new Set([address.company, address.line1, address.line2].filter(Boolean) as string[]);
  for (const l of lines) {
    if (used.has(l)) continue;
    if (stateRe.test(l) && l.length <= 12) continue;
    if (/[A-Za-z]/.test(l)) {
      address.suburb = l.replace(/,?\s*(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b.*$/i, "").trim();
      break;
    }
  }

  return { address, confidence: 0.7 };
}


function heuristicParseTableLineItems(text: string): LineItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, " ").trim())
    .filter(Boolean);

  // Identify a “table header” line. We look for classic PO columns.
  const headerIdx = findLikelyTableHeader(lines);
  if (headerIdx === null) return [];

  // Take the region after header. PDFs often jam lines together, so we just scan a chunk.
  const rows = lines.slice(headerIdx + 1, headerIdx + 1 + 200);

  const out: LineItem[] = [];

  let pendingCode: string | null = null;
  let pendingCodeAge = 0; // number of lines since we saw it


  for (const row of rows) {
    const lower = row.toLowerCase();

    // stop on obvious footer markers
    if (isFooterRow(lower)) break;

    // skip repeated headers
    if (looksLikeTableHeader(lower)) continue;

    // If the PDF splits the item code onto its own line, capture it and apply to the next parsed row.
    // Example in PO45305: "64534304-3660" appears alone, then the next line has description + qty. :contentReference[oaicite:1]{index=1}
    const standalone = looksStandaloneItemCodeLine(row);
    if (standalone) {
      pendingCode = standalone;
      pendingCodeAge = 0;
      continue;
    }

    // age out pending code if we drift too far without finding a parsable row
    if (pendingCode) {
      pendingCodeAge++;
      if (pendingCodeAge > 6) {
        pendingCode = null;
        pendingCodeAge = 0;
      }
    }


    const li = parsePurchaseOrderRow(row);
    if (!li) continue;

    // If we have a pending standalone code, force it as the supplierItemCode/rawText.
    if (pendingCode) {
      li.supplierItemCode = pendingCode;
      li.rawText = pendingCode;

      // If the description contains a misleading trailing number (like "3660"), keep it in description.
      // We do NOT delete it because it's part of the human description (blade length, etc).
      pendingCode = null;
      pendingCodeAge = 0;
    }

    out.push(li);

  }

  return out;
}

/**
 * Parse a row that looks like:
 *  "1.00 18405 EMB-35-DRILL-FABRICATORS KIT D850 9344195188749 1 790.00 790.00"
 *  "2.00 3502532200H 350X2.5X38 200Z HSS BLADE S161C 1 369.68 369.68"
 *
 * We do NOT rely on "description first vs code first". We compute the best code token
 * from what’s present and keep description separate.
 */
function parsePurchaseOrderRow(row: string): LineItem | null {
  // Normalize spaces
  const clean = row.replace(/\s+/g, " ").trim();
  if (!clean) return null;

  // Fast skip junk lines
  if (clean.length < 6) return null;
  if (/^(page:|purchase order|subtotal|total|tax|gst|billing|delivery|terms)/i.test(clean)) return null;

  const tokens = clean.split(" ").filter(Boolean);

  // Find quantity token (typically small integer) near the end, but avoid money.
  const qty = findQtyToken(tokens);
  if (!qty) return null;

  // Identify barcode-like token if present
  const barcode = tokens.find((t) => looksBarcode(t));

  // Identify best code token (this is what becomes rawText)
  const bestCode = pickBestCodeToken(tokens);

  // Description = everything except obvious numeric totals, barcode, and the best code + qty
  const desc = buildDescription(tokens, {
    qtyIndex: qty.index,
    barcode,
    bestCode,
  });

  // Customer product code (never used for mapping)
  const cpc = extractCustomerProductCode(clean);

  // Build line item
  const li: LineItem = {
    rawText: (bestCode || desc || "").trim(),
    quantity: qty.value,
    description: desc || undefined,
    barcode: barcode || undefined,
    customerProductCode: cpc || undefined,
    supplierItemCode: bestCode || undefined,
    _source: "table",
  };

  // If we failed to find a code and description is empty, bail.
  if (!li.rawText) return null;

  return li;
}

function findQtyToken(tokens: string[]): { value: number; index: number } | null {
  // Prefer an integer-ish token that is not money and not a line number like 1.00
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].replace(/,/g, "");
    if (!/^\d+(?:\.\d+)?$/.test(t)) continue;

    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) continue;

    // reject money-looking neighbors or money-looking self
    if (looksMoney(tokens[i])) continue;

    // reject things like "1.00" at start (line number)
    if (i <= 1 && /^\d+\.\d+$/.test(tokens[i])) continue;

    // qtys are usually integers. if decimal, allow only .00
    if (String(tokens[i]).includes(".") && !/\.0+$/.test(tokens[i])) continue;

    return { value: Math.max(1, Math.round(n)), index: i };
  }
  return null;
}

function pickBestCodeToken(tokens: string[]): string | null {
  // Score each token as a likely SKU/code.
  // You told me: Excisions codes are mostly numeric, sometimes with letters.
  let best: { token: string; score: number } | null = null;

  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) continue;

    if (looksMoney(t)) continue;
    if (looksDateLike(t)) continue;

    // drop obvious noise
    if (/^(po|p\/o|qty|quantity|order|price|total|tax|gst)$/i.test(t)) continue;
    if (/^page:?$/i.test(t)) continue;

    // must be “code-like”
    if (!looksCodeToken(t) && !looksBarcode(t)) continue;

    // never treat customer product code labels as codes
    if (/^attachment$/i.test(t)) continue;

    const score = scoreCodeToken(t);
    if (!best || score > best.score) best = { token: t, score };
  }

  return best?.token ?? null;
}

function scoreCodeToken(t: string): number {
  const upper = t.toUpperCase();

  let score = 0;

  // length
  if (upper.length >= 4 && upper.length <= 18) score += 2;
  if (upper.length >= 6 && upper.length <= 14) score += 2;

  // digits matter (mostly numeric codes)
  const digits = (upper.match(/\d/g) || []).length;
  const letters = (upper.match(/[A-Z]/g) || []).length;

  if (digits >= 3) score += 3;
  if (digits >= 5) score += 3;

  // numeric-heavy is a good sign
  if (digits > letters) score += 2;

  // allow trailing letter like 3502532200H
  if (/^\d+[A-Z]$/.test(upper)) score += 2;

  // penalize pure words
  if (/^[A-Z]+$/.test(upper)) score -= 4;

  // penalize obvious sizes like "350X2.5X38"
  if (/[X×]\d/.test(upper)) score -= 3;

  // barcode is valid but not always desired as primary
  if (looksBarcode(upper)) score += 1;

  return score;
}

function buildDescription(
  tokens: string[],
  opts: { qtyIndex: number; barcode?: string; bestCode?: string | null }
): string {
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (i === opts.qtyIndex) continue;
    if (opts.barcode && t === opts.barcode) continue;
    if (opts.bestCode && t === opts.bestCode) continue;

    // remove money-like totals
    if (looksMoney(t)) continue;

    // remove obvious line number at start like "1.00"
    if (i === 0 && /^\d+\.\d+$/.test(t)) continue;

    out.push(t);
  }

  const desc = out.join(" ").replace(/\s+/g, " ").trim();

  // Strip “Line Total / Unit Cost” style artifacts if they leak in
  return desc.replace(/\b(unit|cost|line|total)\b/gi, "").replace(/\s+/g, " ").trim();
}

function heuristicParseXPatterns(text: string): LineItem[] {
  // This parser is intentionally conservative. Use only if you explicitly re-enable it.
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: LineItem[] = [];

  for (const line of lines) {
    // "ABC-123 x 4" or "ABC-123 * 4" or "ABC-123 × 4"
    const m = line.match(/^(.+?)(?:\s*(?:x|\*|×)\s*(\d+))\s*$/i);
    if (m) {
      const raw = m[1].trim();
      const qty = Number(m[2]);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      if (!raw || raw.length < 3) continue;

      // Only keep if it looks like a code, not random words.
      const firstTok = raw.split(/\s+/)[0];
      if (!looksCodeToken(firstTok)) continue;

      out.push({
        rawText: firstTok,
        quantity: qty,
        supplierItemCode: firstTok,
        description: raw.slice(firstTok.length).trim() || undefined,
        _source: "pattern",
      });
    }
  }

  return out;
}

// --------------------
// RawText safety rules
// --------------------

function enforceMappingSafeRawText(li: LineItem): LineItem {
  const next: LineItem = { ...li };

  // 1) Never allow customerProductCode to drive mapping.
  if (
    next.customerProductCode &&
    next.rawText.trim() === next.customerProductCode.trim()
  ) {
    next.rawText = "";
  }

  // 2) If supplierItemCode exists, rawText must be that (code-only).
  const code =
    next.supplierItemCode ||
    next.itemCode ||
    next.partNo ||
    next.vendorPn ||
    next.barcode ||
    null;

  if (code && looksCodeToken(code)) {
    next.rawText = code.trim();
    return next;
  }

  // 3) If rawText contains a likely code token, split it and keep only the code.
  // Handles cases like: "18405 EMB-35-DRILL-FABRICATORS KIT D850"
  const raw = (next.rawText || "").replace(/\s+/g, " ").trim();
  if (!raw) return next;

  const toks = raw.split(" ").filter(Boolean);
  if (toks.length >= 2) {
    const bestCode = pickBestCodeToken(toks);
    if (bestCode) {
      next.supplierItemCode = next.supplierItemCode || bestCode;
      next.description = next.description || raw.replace(bestCode, "").trim() || undefined;
      next.rawText = bestCode;
      return next;
    }
  }

  // 4) Otherwise keep rawText as-is (description-only fallback)
  return next;
}

// --------------------
// Table header detection / helpers
// --------------------

function findLikelyTableHeader(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (looksLikeTableHeader(lower)) return i;
  }
  return null;
}

function looksLikeTableHeader(lower: string): boolean {
  // broad, because formats vary
  const markers = [
    "item description",
    "description",
    "supplier",
    "supplier item",
    "supplier code",
    "item code",
    "barcode",
    "qty",
    "quantity",
    "order quantity",
    "unit cost",
    "unit price",
    "line total",
  ];

  let hits = 0;
  for (const m of markers) if (lower.includes(m)) hits++;

  // Need multiple markers so we don’t match random text.
  return hits >= 2;
}

function isFooterRow(lower: string): boolean {
  return (
    lower.startsWith("subtotal") ||
    lower.startsWith("total") ||
    lower.startsWith("gst") ||
    lower.startsWith("tax") ||
    lower.startsWith("terms") ||
    /^delivery\s+(instructions|address)\b/i.test(lower) ||
    /^ship(?:ping)?\s+(address|to|via)\b/i.test(lower) ||
    /^freight\b/i.test(lower) ||
    lower.includes("order total") ||
    lower.includes("sub total")
  );
}

function looksMoney(token: string): boolean {
  return /^\$?\d{1,3}(?:,\d{3})*(?:\.\d{2,4})?$/.test(token);
}

function looksBarcode(token: string): boolean {
  return /^\d{8,14}$/.test(token);
}

function looksDateLike(token: string): boolean {
  // 20/1/2026, 20-01-2026, etc
  return /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(token);
}

function looksCodeToken(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (t.length < 3) return false;
  if (t.length > 30) return false;
  if (t.includes(" ")) return false;

  // must contain at least one digit for your world
  if (!/\d/.test(t)) return false;

  // allow letters/numbers and some separators
  if (!/^[A-Z0-9][A-Z0-9\-\/\.()]*$/i.test(t)) return false;

  return true;
}

function looksStandaloneItemCodeLine(line: string): string | null {
  const s = (line || "").trim();
  if (!s) return null;

  // normalize unicode hyphens to regular hyphen
  const norm = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-").trim();

  // Hard reject obvious labels
  if (/^(our#|our#:|subtotal|total|gst|tax|page|deliver|ship|phone|fax)\b/i.test(norm)) return null;

  // If the whole line is a code-like token, accept it.
  // Your codes can have hyphens. This pattern allows digits with optional hyphen chunks.
  if (/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/i.test(norm)) return norm;

  // Also allow pure digit codes (if you have them) but avoid tiny numbers like "10"
  if (/^\d{5,}$/.test(norm)) return norm;

  return null;
}


function extractCustomerProductCode(text: string): string | null {
  // Label-based capture, never used for mapping
  const m = text.match(
    /\b(?:Our\s+Product\s+Code|Customer\s+Product\s+Code|Product\s+Code)\b[:\s-]*([A-Z0-9\-\/\.()]{2,})\b/i
  );
  return m?.[1] ? m[1].trim() : null;
}

function dedupeLineItems(items: LineItem[]): LineItem[] {
  const seen = new Set<string>();
  const out: LineItem[] = [];

  for (const it of items) {
    const key = `${(it.rawText || "").trim().toLowerCase()}|${it.quantity}`;
    if (!it.rawText) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }

  return out;
}

// --------------------
// PO number extraction
// --------------------

function extractPoNumber(text: string): string | null {
  const patterns: RegExp[] = [
    /\bPURCHASE\s+ORDER[:\s#-]*([A-Z0-9-]{4,})\b/i,
    /\bPO[:\s#-]*([A-Z0-9-]{4,})\b/i,
    /\bP\/O[:\s#-]*([A-Z0-9-]{4,})\b/i,
    /\bORDER\s+(?:NO|NUMBER|#)[:\s#-]*([A-Z0-9-]{4,})\b/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }

  return null;
}

// --------------------
// Text helpers
// --------------------

function normalizeText(text: string) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cheap HTML to text. Good enough for v1.
function stripHtmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
