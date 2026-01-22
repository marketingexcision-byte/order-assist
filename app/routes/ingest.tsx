import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";

import { prisma } from "../db.server";
import { ingestPendingOrder } from "../services/ingestPendingOrder.server";
import type { NormalizedAttachment } from "../services/attachmentText.server";

export async function loader(_: LoaderFunctionArgs) {
  const mailboxes = await prisma.customerMailbox.findMany({
    where: { isActive: true },
    select: { emailAddress: true },
    orderBy: { emailAddress: "asc" },
  });

  return json({ mailboxes });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();

  const to = String(form.get("to") || "").trim();
  const from = String(form.get("from") || "upload@local").trim();
  const subject = String(form.get("subject") || "Uploaded order").trim();
  const textBody = String(form.get("text") || "").trim() || null;

  const attachments: NormalizedAttachment[] = [];
  for (const [, value] of form.entries()) {
    if (value instanceof File) {
      if (!value.size) continue;
      const buf = Buffer.from(await value.arrayBuffer());
      attachments.push({
        filename: value.name || "attachment",
        contentType: value.type || "",
        data: buf,
      });
    }
  }

  if (!to) {
    return json({ ok: false, error: "Missing mailbox (to)" }, { status: 400 });
  }

  if (!textBody && attachments.length === 0) {
    return json({ ok: false, error: "Provide text or at least one file" }, { status: 400 });
  }

  const result = await ingestPendingOrder({
    source: attachments.length ? "UPLOAD" : "PASTE",
    from,
    to,
    subject,
    textBody,
    htmlBody: null,
    messageId: null,
    receivedAt: new Date(),
    rawAttachments: attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.data.byteLength,
    })),
    attachments,
  });

  if (!result.ok) {
    return json(result, { status: (result as any).status ?? 500 });
  }

  return redirect("/pending-orders");
}

export default function IngestPage() {
  const { mailboxes } = useLoaderData<typeof loader>();

  return (
    <div className="section section--blue-page">
      <div className="container">
        <div className="on-blue">
          <header className="section__header section__header--blue">
            <h1 className="section__title">Upload Order</h1>
            <p className="section__subtitle">
              Upload a PDF, image, CSV, or XLSX. Or paste text. It will land in Pending Orders for review.
            </p>
          </header>
        </div>

        <div className="sidebar-layout">
          <aside className="card card--compact">
            <div className="card__header">
              <h2 className="card__title">Navigation</h2>
              <div className="text-ps text-iron">Jump back to queues and review.</div>
            </div>

            <nav className="sidebar-tabs">
              <Link to="/pending-orders?status=READY_FOR_REVIEW" className="sidebar-tab">
                <span>Ready for review</span>
                <span className="sidebar-tab__count">→</span>
              </Link>

              <Link to="/pending-orders?status=APPROVED" className="sidebar-tab">
                <span>Approved</span>
                <span className="sidebar-tab__count">→</span>
              </Link>

              <Link to="/pending-orders?status=REJECTED" className="sidebar-tab">
                <span>Rejected</span>
                <span className="sidebar-tab__count">→</span>
              </Link>
            </nav>

            <div className="card__body">
              <div className="text-ps text-iron">
                Tip. If you upload a sheet export, keep the first rows as item lines. Noise kills extraction.
              </div>
            </div>
          </aside>

          <main>
            <div className="card">
              <div className="card__header">
                <h2 className="card__title">Create a Pending Order</h2>
                <div className="text-ps text-iron">
                  Choose the customer mailbox so we can attach the correct Shopify customer.
                </div>
              </div>

              <div className="card__body">
                <Form method="post" encType="multipart/form-data">
                  <div className="grid" style={{ gap: "var(--space-4)" }}>
                    <div className="grid" style={{ gap: "var(--space-2)" }}>
                      <label className="text-ps text-iron">Mailbox (customer)</label>
                      <select name="to" required className="form-input">
                        <option value="">Select mailbox...</option>
                        {mailboxes.map((m) => (
                          <option key={m.emailAddress} value={m.emailAddress}>
                            {m.emailAddress}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
                      <div className="grid" style={{ gap: "var(--space-2)" }}>
                        <label className="text-ps text-iron">From (optional)</label>
                        <input name="from" placeholder="upload@local" className="form-input" />
                      </div>

                      <div className="grid" style={{ gap: "var(--space-2)" }}>
                        <label className="text-ps text-iron">Subject (optional)</label>
                        <input name="subject" placeholder="Uploaded order" className="form-input" />
                      </div>
                    </div>

                    <div className="grid" style={{ gap: "var(--space-2)" }}>
                      <label className="text-ps text-iron">Upload file(s)</label>
                      <input name="file" type="file" multiple className="form-input" />
                      <div className="text-ps text-iron">
                        Supported. PDF, images, CSV, XLSX. Upload-only works. No body required.
                      </div>
                    </div>

                    <div className="grid" style={{ gap: "var(--space-2)" }}>
                      <label className="text-ps text-iron">Or paste text</label>
                      <textarea
                        name="text"
                        rows={10}
                        className="form-input"
                        style={{ fontFamily: "monospace" }}
                        placeholder={`Example:\n0500014 x 2\n0500016 x 1\n\nYou can paste raw email text too.`}
                      />
                    </div>

                    <div className="flex" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button type="submit" className="btn btn--primary">
                        Create Pending Order
                      </button>
                      <Link to="/pending-orders?status=READY_FOR_REVIEW" className="btn btn-outline">
                        Back to Pending Orders
                      </Link>
                    </div>
                  </div>
                </Form>
              </div>
            </div>

            <div className="card card--compact mt-4">
              <div className="card__header">
                <h2 className="card__title">What happens next</h2>
              </div>
              <div className="card__body">
                <ul className="text-p1" style={{ margin: 0, paddingLeft: 18 }}>
                  <li>We extract text from the upload or pasted content.</li>
                  <li>We create a Pending Order in READY_FOR_REVIEW.</li>
                  <li>We auto-map items to Shopify variants. You review and approve.</li>
                </ul>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

