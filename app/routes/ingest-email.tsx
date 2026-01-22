import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "../db.server";
import type { NormalizedAttachment } from "../services/attachmentText.server";
import { ingestPendingOrder } from "../services/ingestPendingOrder.server";

// DEBUG: remove once stable
function assertPrismaModels() {
  const anyPrisma = prisma as any;
  if (!anyPrisma?.pendingOrder) throw new Error("Prisma client missing model: pendingOrder");
  if (!anyPrisma?.inboundEmail) throw new Error("Prisma client missing model: inboundEmail");
  if (!anyPrisma?.customerMailbox) throw new Error("Prisma client missing model: customerMailbox");
  if (!anyPrisma?.ingestJob) throw new Error("Prisma client missing model: ingestJob");
}


function normalizeEmail(addr: string) {
  return addr.trim().toLowerCase();
}

function requireSharedSecret(request: Request) {
  const url = new URL(request.url);

  const got =
    request.headers.get("x-ingest-secret") ||
    url.searchParams.get("secret") ||
    "";

  const expected = process.env.INGEST_SECRET || "";

  if (!expected || got !== expected) {
    throw new Response("Unauthorized", { status: 401 });
  }
}

async function normalizeAttachments(raw: any): Promise<NormalizedAttachment[]> {
  if (!raw) return [];

  let list: any[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }

  const out: NormalizedAttachment[] = [];

  for (const a of list) {
    const filename = String(a.filename || a.name || "attachment");
    const contentType = String(a.contentType || a.type || "");

    // Case 1: base64 inline
    if (a.contentBase64 || a.base64 || a.data) {
      const b64 = String(a.contentBase64 || a.base64 || a.data);
      out.push({
        filename,
        contentType,
        data: Buffer.from(b64, "base64"),
      });
      continue;
    }

    // Case 2: remote URL
    if (a.url) {
      const res = await fetch(String(a.url));
      if (!res.ok) continue;

      const buf = Buffer.from(await res.arrayBuffer());
      out.push({
        filename,
        contentType: contentType || String(res.headers.get("content-type") || ""),
        data: buf,
      });
      continue;
    }
  }

  return out;
}

async function normalizeAttachmentsFromFormData(form: FormData): Promise<NormalizedAttachment[]> {
  const out: NormalizedAttachment[] = [];

  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      if (!value.size) continue;
      const buf = Buffer.from(await value.arrayBuffer());
      out.push({
        filename: value.name || String(key) || "attachment",
        contentType: value.type || "",
        data: buf,
      });
    }
  }

  return out;
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Optional auth here. Leaving open is fine, action enforces secret.
  return json({ ok: true });
}

export async function action({ request }: ActionFunctionArgs) {
  const reqId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  console.log(
    `[INGEST ${reqId}] start ${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`
  );

  let ingestJobId: string | null = null;


  try {
    requireSharedSecret(request);
    assertPrismaModels();

    const contentType = request.headers.get("content-type") || "";

    let payload: any;

    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      payload = Object.fromEntries(form.entries());
    } else if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();

      payload = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") payload[k] = v;
      }

      (payload as any).__formData = form;
    } else {
      return json({ ok: false, reqId, error: "Unsupported content type" }, { status: 415 });
    }

    const from = String(payload.from || payload.sender || "").trim();
    const to = String(payload.to || payload.recipient || "").trim();
    const subject = payload.subject ? String(payload.subject) : null;

    const messageId = payload.messageId
      ? String(payload.messageId)
      : payload["Message-Id"]
        ? String(payload["Message-Id"])
        : null;

    const textBody = payload.textBody
      ? String(payload.textBody)
      : payload["body-plain"]
        ? String(payload["body-plain"])
        : null;

    const htmlBody = payload.htmlBody
      ? String(payload.htmlBody)
      : payload["body-html"]
        ? String(payload["body-html"])
        : null;

    // Normalize attachments from json + multipart
    console.log(`[INGEST ${reqId}] normalizing attachments...`);
    const fromJsonField = await normalizeAttachments(payload.attachments);

    const fromMultipart =
      (payload as any).__formData
        ? await normalizeAttachmentsFromFormData((payload as any).__formData as FormData)
        : [];

    const normalizedAttachments = [...fromMultipart, ...fromJsonField];

    console.log(
      `[INGEST ${reqId}] attachments normalized`,
      normalizedAttachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        bytes: a.data?.byteLength ?? 0,
      }))
    );

    const hasAnyAttachments = normalizedAttachments.length > 0;

    if (!from || !to || (!textBody && !htmlBody && !hasAnyAttachments)) {
      return json(
        { ok: false, reqId, error: "Missing from/to/body/attachments" },
        { status: 400 }
      );
    }

    const toNorm = normalizeEmail(to);

 const ingestJob = await prisma.ingestJob.create({
  data: {
    status: "RUNNING",
    source: "EMAIL",
    startedAt: new Date(),
    requestId: reqId,
    to: toNorm,
  },
});

ingestJobId = ingestJob.id;



    const result = await ingestPendingOrder({
      source: "EMAIL",
      from,
      to: toNorm,
      subject,
      textBody,
      htmlBody,
      messageId,
      receivedAt: payload.timestamp ? new Date(Number(payload.timestamp) * 1000) : null,
      rawAttachments: payload.attachments ?? null,
      attachments: normalizedAttachments,
    });

await prisma.ingestJob.update({
  where: { id: ingestJob.id },
  data: {
    status: result.ok ? "DONE" : "FAILED",
    finishedAt: new Date(),
    pendingOrderId: (result as any).pendingOrderId ?? null,
    error: result.ok ? null : String((result as any).error ?? "Unknown ingest error"),
  },
});


    return json(result, { status: result.ok ? 200 : (result as any).status ?? 500 });
  } catch (err: any) {
    console.error(`[INGEST ${reqId}] FAILED`, err?.stack || err);

if (ingestJobId) {
  try {
    await prisma.ingestJob.update({
      where: { id: ingestJobId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: String(err?.message || err),
      },
    });
  } catch (e) {
    console.error(`[INGEST ${reqId}] FAILED to update ingestJob`, e);
  }
}


    throw new Response(
      JSON.stringify({
        ok: false,
        reqId,
        error: String(err?.message || err),
        stack: err?.stack || null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
