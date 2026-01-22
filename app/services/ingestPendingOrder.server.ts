import { prisma } from "../db.server";
import { extractAttachmentText } from "./attachmentText.server";
import type { NormalizedAttachment } from "./attachmentText.server";
import { extractPendingOrderFromEmail } from "./emailExtract.server";
import { autoMapPendingOrderLineItems } from "../autoMapPendingOrder.server";
import { extractPoNumber } from "../utils/extractPoNumber";

export type IngestSource = "EMAIL" | "UPLOAD" | "PASTE";

export type IngestRequest = {
  source: IngestSource;
  from: string;
  to: string; // mailbox address
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  messageId?: string | null; // for email dedupe, optional for upload
  receivedAt?: Date | null;

  // raw attachments payload for inboundEmail record if you want it
  rawAttachments?: any | null;

  // normalized bytes for extraction
  attachments: NormalizedAttachment[];
};

export async function ingestPendingOrder(req: IngestRequest) {
  const reqId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  console.log(`[PIPELINE ${reqId}] start source=${req.source}`);

  const toNorm = req.to.trim().toLowerCase();
  const mailbox = await prisma.customerMailbox.findUnique({
    where: { emailAddress: toNorm },
  });

  if (!mailbox || !mailbox.isActive) {
    return {
      ok: false as const,
      reqId,
      error: "Unknown or inactive recipient mailbox",
      status: 400,
    };
  }

  // Dedupe only if messageId exists
  let reuseInboundEmailId: string | undefined;
  if (req.messageId) {
    const existing = await prisma.inboundEmail.findUnique({
      where: { messageId: req.messageId },
      select: { id: true, pendingOrderId: true },
    });

    if (existing?.pendingOrderId) {
      return {
        ok: true as const,
        reqId,
        duplicate: true,
        inboundEmailId: existing.id,
        pendingOrderId: existing.pendingOrderId,
      };
    }
    if (existing?.id) reuseInboundEmailId = existing.id;
  }

  // Extract attachment text
  const attachmentTextResult = await extractAttachmentText(req.attachments);
  const attachmentText = attachmentTextResult.combinedText;

  console.log(`[PIPELINE ${reqId}] attachments`, attachmentTextResult.perFile.map(f => ({
    filename: f.filename, chars: f.text.length
  })));

  // Store/reuse inboundEmail row for audit trail. For UPLOAD/PASTE, we still store as inboundEmail.
  const inbound = reuseInboundEmailId
    ? await prisma.inboundEmail.findUniqueOrThrow({ where: { id: reuseInboundEmailId } })
    : await prisma.inboundEmail.create({
      data: {
        messageId: req.messageId ?? null,
        from: req.from,
        to: toNorm,
        subject: req.subject ?? null,
        textBody: req.textBody ?? null,
        htmlBody: req.htmlBody ?? null,
        attachments: req.rawAttachments ?? null,
        receivedAt: req.receivedAt ?? null,
        customerMailboxId: mailbox.id,
      },
    });

  // Extraction (heuristics first, AI second) happens inside emailExtract.server.ts
  let extracted: any;
  try {
    extracted = await extractPendingOrderFromEmail({
      from: req.from,
      to: toNorm,
      subject: req.subject ?? undefined,
      textBody: req.textBody ?? undefined,
      htmlBody: req.htmlBody ?? undefined,
      attachments: req.rawAttachments ?? undefined,
      attachmentText,
    });

    await prisma.inboundEmail.update({
      where: { id: inbound.id },
      data: { aiExtracted: extracted },
    });
  } catch (err: any) {
    await prisma.inboundEmail.update({
      where: { id: inbound.id },
      data: { aiError: String(err?.message || err) },
    });
    throw err;
  }

  const combinedText = [
    req.subject ?? "",
    req.textBody ?? "",
    req.htmlBody ?? "",
    attachmentText ?? "",
  ].join("\n\n");

  const aiPo = extracted?.poNumber ? String(extracted.poNumber).trim() : null;
  const fallbackPo = extractPoNumber(combinedText);
  const poNumber = aiPo || fallbackPo;

  const pending = await prisma.pendingOrder.create({
    data: {
      status: "READY_FOR_REVIEW",
      poNumber,
      deliveryAddress: extracted.deliveryAddress ?? null,
      deliveryAddressSource: extracted.deliveryAddressSource ?? null,
      lineItems: extracted.lineItems,
      shopifyCustomerId: mailbox.shopifyCustomerId,
    },
    select: { id: true },
  });

  await prisma.inboundEmail.update({
    where: { id: inbound.id },
    data: { pendingOrderId: pending.id },
  });

  await autoMapPendingOrderLineItems(pending.id);

  console.log(`[PIPELINE ${reqId}] success pendingOrderId=${pending.id} inboundEmailId=${inbound.id}`);

  return {
    ok: true as const,
    reqId,
    pendingOrderId: pending.id,
    inboundEmailId: inbound.id,
  };
}
