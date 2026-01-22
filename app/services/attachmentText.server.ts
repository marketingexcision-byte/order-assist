import { createWorker } from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import Papa from "papaparse";
import * as XLSX from "xlsx";



export type NormalizedAttachment = {
  filename: string;
  contentType: string;
  data: Buffer;
};

/**
 * Hard limits to prevent attachment bombs and downstream failures
 */
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_COMBINED_TEXT_CHARS = 200_000;

const MIN_PDF_TEXT_CHARS = 300;
const MIN_PDF_NONWS_CHARS = 120;

// OCR fallback caps (these matter a lot)
const PDF_OCR_MAX_PAGES = 3;
const PDF_OCR_DPI = 170; // 150-200 is a sane band
const PDF_OCR_MAX_TOTAL_RENDERED_BYTES = 12 * 1024 * 1024; // across all rendered pages

// Spreadsheet caps. These prevent “wide/huge sheet” drowning and XLSX decompression surprises.
const MAX_CSV_CHARS = 120_000;

const MAX_XLSX_BYTES = 3 * 1024 * 1024; // stricter than MAX_ATTACHMENT_BYTES due to zip expansion risk
const MAX_XLSX_SHEETS = 2;
const MAX_XLSX_ROWS = 250;
const MAX_XLSX_COLS = 40;
const MAX_XLSX_CHARS = 120_000;


function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[[TRUNCATED: ${text.length - maxChars} chars]]`;
}

function isProbablyScannedPdf(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < MIN_PDF_TEXT_CHARS) return true;

  const nonWs = trimmed.replace(/\s+/g, "");
  if (nonWs.length < MIN_PDF_NONWS_CHARS) return true;

  return false;
}


/**
 * Render the first N pages of a PDF into PNG buffers.
 * This is the core of "scanned PDF support".
 */

async function extractPdfTextWithPdfjs(pdfData: Buffer, maxPages = 10): Promise<string> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfData) });

  const doc = await loadingTask.promise;

  const pageCount = doc.numPages;
  const pagesToRead = Math.min(pageCount, Math.max(1, maxPages));

  const chunks: string[] = [];

  for (let pageNum = 1; pageNum <= pagesToRead; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const pageText = (content.items as any[])
      .map((it) => (typeof it?.str === "string" ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (pageText) chunks.push(pageText);
  }

  return chunks.join("\n\n").trim();
}

async function renderPdfToPngBuffers(
  pdfData: Buffer,
  opts: { maxPages: number; dpi: number; maxTotalBytes: number }
): Promise<{ pngBuffers: Buffer[]; pagesRendered: number }> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfData) });

  const doc = await loadingTask.promise;

  const pageCount = doc.numPages;
  const pagesToRender = Math.min(pageCount, Math.max(1, opts.maxPages));

  const scale = opts.dpi / 72; // PDF points are 72 DPI
  const pngBuffers: Buffer[] = [];
  let totalBytes = 0;

  for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx as any, viewport }).promise;

    const png = canvas.toBuffer("image/png");
    totalBytes += png.byteLength;

    if (totalBytes > opts.maxTotalBytes) {
      break;
    }

    pngBuffers.push(png);
  }

  return { pngBuffers, pagesRendered: pngBuffers.length };
}

function decodeUtf8BestEffort(buf: Buffer) {
  // Handle UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  // Best effort. If someone sends latin1, this won’t be perfect, but it’s acceptable for PO extraction.
  return buf.toString("utf8");
}

function sanitizeCell(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v).replace(/\s+/g, " ").trim();
}

async function extractCsvTextBestEffort(data: Buffer): Promise<string> {
  const raw = decodeUtf8BestEffort(data);

  // If it’s absurdly large text-wise, truncate early.
  const clipped = raw.length > MAX_CSV_CHARS ? raw.slice(0, MAX_CSV_CHARS) : raw;

  // Try a few common delimiters and pick the one that yields the most “structured” rows.
  const delimiters = [",", ";", "\t", "|"];
  let best: { delim: string; rows: string[][]; score: number } | null = null;

  for (const d of delimiters) {
    const parsed = Papa.parse<string[]>(clipped, {
      delimiter: d,
      skipEmptyLines: "greedy",
      quoteChar: '"',
      escapeChar: '"',
    });

    const rows = (parsed.data as any[])
      .filter((r) => Array.isArray(r))
      .map((r) => (r as any[]).map((c) => sanitizeCell(c)));

    // Score: prefer more rows and a stable column count.
    const rowCount = rows.length;
    const colCounts = rows.slice(0, 50).map((r) => r.length);
    const avgCols =
      colCounts.length ? colCounts.reduce((a, b) => a + b, 0) / colCounts.length : 0;
    const variance =
      colCounts.length
        ? colCounts.reduce((a, c) => a + Math.pow(c - avgCols, 2), 0) / colCounts.length
        : 9999;

    const score = rowCount * 10 + Math.max(0, avgCols * 2) - variance;

    if (!best || score > best.score) best = { delim: d, rows, score };
  }

  const chosen = best?.rows ?? [];
  const delim = best?.delim ?? ",";

  if (!chosen.length) {
    return `[[CSV_PARSE_EMPTY delim=${delim}]]\n` + clipped.trim();
  }

  // Render as TSV-ish text table for downstream heuristics.
  const maxRows = Math.min(chosen.length, 300);
  const maxCols = Math.min(
    Math.max(...chosen.slice(0, maxRows).map((r) => r.length)),
    50
  );

  const lines: string[] = [];
  lines.push(`[[CSV_PARSED delim=${JSON.stringify(delim)} rows=${chosen.length} cols~=${maxCols}]]`);

  for (let i = 0; i < maxRows; i++) {
    const row = chosen[i] ?? [];
    const cells = row.slice(0, maxCols).map((c) => c);
    lines.push(cells.join("\t").trimEnd());
  }

  const out = lines.join("\n").trim();
  return out.length > MAX_CSV_CHARS ? truncate(out, MAX_CSV_CHARS) : out;
}

async function extractExcelTextWithXlsx(data: Buffer, filename: string): Promise<string> {
  // Extra safety for zip expansion and memory pressure.
  if (data.byteLength > MAX_XLSX_BYTES) {
    return `[[SKIPPED_TOO_LARGE_XLSX: bytes=${data.byteLength} max=${MAX_XLSX_BYTES}]]`;
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, {
      type: "buffer",
      cellText: false,
      cellDates: false,
      cellNF: false,
      cellStyles: false,
    });
  } catch (e: any) {
    return `[[XLSX_READ_FAILED: ${String(e?.message || e)}]]`;
  }

  const sheetNames = (wb.SheetNames || []).slice(0, MAX_XLSX_SHEETS);
  if (!sheetNames.length) return "[[XLSX_NO_SHEETS]]";

  const chunks: string[] = [];
  chunks.push(`[[XLSX_PARSED sheets=${wb.SheetNames?.length ?? 0} using=${sheetNames.length}]]`);

  for (const name of sheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;

    // Convert to 2D array with capped rows/cols.
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false,
    }) as any[][];

    const cappedRows = rows.slice(0, MAX_XLSX_ROWS).map((r) => (r || []).slice(0, MAX_XLSX_COLS));

    chunks.push(`--- SHEET: ${name} ---`);
    for (const r of cappedRows) {
      const line = (r || []).map(sanitizeCell).join("\t").trimEnd();
      if (line) chunks.push(line);
    }
  }

  const out = chunks.join("\n").trim();
  return out.length > MAX_XLSX_CHARS ? truncate(out, MAX_XLSX_CHARS) : out;
}


export async function extractAttachmentText(
  attachments: NormalizedAttachment[]
): Promise<{
  combinedText: string;
  perFile: { filename: string; text: string }[];
}> {
  const perFile: { filename: string; text: string }[] = [];

  // One OCR worker per invocation. Reused across all images + PDF fallback images.
  let ocrWorker: any | null = null;

  async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    ocrWorker = await createWorker("eng");
    return ocrWorker;
  }

  try {
    for (const att of attachments) {
      const filename = att.filename || "unknown";
      const contentType = (att.contentType || "").toLowerCase();

      if (perFile.length >= MAX_ATTACHMENTS) {
        perFile.push({
          filename,
          text: `[[SKIPPED_TOO_MANY_ATTACHMENTS: max=${MAX_ATTACHMENTS}]]`,
        });
        continue;
      }

      if (!att.data || att.data.byteLength > MAX_ATTACHMENT_BYTES) {
        perFile.push({
          filename,
          text: `[[SKIPPED_TOO_LARGE: bytes=${att.data?.byteLength ?? 0} max=${MAX_ATTACHMENT_BYTES}]]`,
        });
        continue;
      }

      /**
       * PDF handling
       */
      if (contentType.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
        let parsedText = "";
try {
  parsedText = (await extractPdfTextWithPdfjs(att.data, 10)).trim();
  console.log(`[attachmentText] PDF parsedText chars=${parsedText.length} file=${filename}`);
  console.log(`[attachmentText] PDF scanned? ${isProbablyScannedPdf(parsedText)} file=${filename}`);
} catch (e: any) {
  perFile.push({
    filename,
    text: `[[PDF_TEXT_EXTRACT_FAILED: ${String(e?.message || e)}]]`,
  });
  continue;
}


        // If we got solid text, use it.
        if (parsedText && !isProbablyScannedPdf(parsedText)) {
          perFile.push({ filename, text: parsedText });
          continue;
        }

        // Otherwise, attempt OCR fallback.
        try {
          const { pngBuffers, pagesRendered } = await renderPdfToPngBuffers(att.data, {
            maxPages: PDF_OCR_MAX_PAGES,
            dpi: PDF_OCR_DPI,
            maxTotalBytes: PDF_OCR_MAX_TOTAL_RENDERED_BYTES,
          });

          if (!pngBuffers.length) {
            perFile.push({
              filename,
              text: parsedText
                ? `${parsedText}\n\n[[PDF_LOW_TEXT: possibly scanned]]\n[[PDF_OCR_FALLBACK_EMPTY_RENDER]]`
                : `[[PDF_EMPTY_TEXT: possibly scanned]]\n[[PDF_OCR_FALLBACK_EMPTY_RENDER]]`,
            });
            continue;
          }

          const worker = await getOcrWorker();
          const ocrChunks: string[] = [];

          for (let i = 0; i < pngBuffers.length; i++) {
            const { data } = await worker.recognize(pngBuffers[i]);
            const pageText = (data?.text || "").trim();
            ocrChunks.push(
              `--- PDF_OCR_PAGE ${i + 1} ---\n${pageText || "[[OCR_EMPTY_TEXT]]"}`
            );
          }

          const ocrText = ocrChunks.join("\n\n").trim();

          const headerMarkers = [
            parsedText ? "[[PDF_LOW_TEXT: possibly scanned]]" : "[[PDF_EMPTY_TEXT: possibly scanned]]",
            `[[PDF_OCR_FALLBACK_USED pages=${pagesRendered} dpi=${PDF_OCR_DPI}]]`,
          ].join("\n");

          // Keep any small amount of parsed text, but prioritize OCR as the real payload.
          const merged = parsedText
            ? `${parsedText}\n\n${headerMarkers}\n\n${ocrText}`
            : `${headerMarkers}\n\n${ocrText}`;

            console.log(`[attachmentText] PDF OCR fallback USED pages=${pagesRendered} file=${filename}`);

          perFile.push({ filename, text: merged });
        } catch (e: any) {
  console.log(`[attachmentText] PDF OCR fallback FAILED file=${filename}`, String(e?.message || e));
  perFile.push({
    filename,
    text: parsedText
      ? `${parsedText}\n\n[[PDF_LOW_TEXT: possibly scanned]]\n[[PDF_OCR_FALLBACK_FAILED: ${String(
          e?.message || e
        )}]]`
      : `[[PDF_EMPTY_TEXT: possibly scanned]]\n[[PDF_OCR_FALLBACK_FAILED: ${String(
          e?.message || e
        )}]]`,
  });
}

        continue;
      }

            /**
       * CSV / Excel handling
       */
      const lowerName = filename.toLowerCase();

      const isCsv =
        contentType.includes("text/csv") ||
        contentType.includes("application/csv") ||
        lowerName.endsWith(".csv");

      const isXlsx =
        contentType.includes("spreadsheetml.sheet") ||
        lowerName.endsWith(".xlsx");

      const isXls =
        contentType.includes("application/vnd.ms-excel") ||
        lowerName.endsWith(".xls");

      if (isCsv) {
        try {
          const text = await extractCsvTextBestEffort(att.data);
          perFile.push({ filename, text: text || "[[CSV_EMPTY_TEXT]]" });
        } catch (e: any) {
          perFile.push({ filename, text: `[[CSV_PARSE_FAILED: ${String(e?.message || e)}]]` });
        }
        continue;
      }

      // Treat .xls and .xlsx both via xlsx. It can read both, but .xls parsing is less reliable.
      if (isXlsx || isXls) {
        const text = await extractExcelTextWithXlsx(att.data, filename);
        perFile.push({ filename, text: text || "[[XLSX_EMPTY_TEXT]]" });
        continue;
      }


      /**
       * Image OCR
       */
      if (contentType.startsWith("image/")) {
        try {
          const worker = await getOcrWorker();
          const { data } = await worker.recognize(att.data);
          const text = (data?.text || "").trim();

          perFile.push({
            filename,
            text: text || "[[OCR_EMPTY_TEXT]]",
          });
        } catch (e: any) {
          perFile.push({
            filename,
            text: `[[OCR_FAILED: ${String(e?.message || e)}]]`,
          });
        }
        continue;
      }

      /**
       * Unsupported attachment
       */
      perFile.push({
        filename,
        text: `[[UNSUPPORTED_ATTACHMENT: ${contentType || "unknown"}]]`,
      });
    }
  } finally {
    if (ocrWorker) {
      try {
        await ocrWorker.terminate();
      } catch {
        // swallow
      }
    }
  }

  const combinedRaw = perFile
    .map((f) => `--- ATTACHMENT: ${f.filename} ---\n${f.text}`)
    .join("\n\n");

  const combinedText = truncate(combinedRaw, MAX_COMBINED_TEXT_CHARS);

  return { combinedText, perFile };
}
