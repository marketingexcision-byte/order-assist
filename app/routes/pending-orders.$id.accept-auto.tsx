import type { ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { prisma } from "../db.server";

type MatchStatus = "UNMAPPED" | "AUTO_MAPPED" | "NEEDS_REVIEW" | "MAPPED";

type LineItem = {
  rawText: string;
  quantity: number;
  match?: {
    status: MatchStatus;
    confidence?: number;
    variantId?: string;
    sku?: string;
    displayTitle?: string;
    candidates?: Array<{
      variantId: string;
      sku?: string;
      displayTitle?: string;
      score: number;
    }>;
  };
};

export async function action({ request, params }: ActionFunctionArgs) {
  const id = params.id;
  if (!id) return json({ error: "Missing id" }, { status: 400 });

  const form = await request.formData();
  const indexStr = String(form.get("index") || "");
  const index = Number(indexStr);

  if (!Number.isFinite(index) || index < 0) {
    return json({ error: "Bad index" }, { status: 400 });
  }

  const order = await prisma.pendingOrder.findUnique({ where: { id } });
  if (!order) return json({ error: "Order not found" }, { status: 404 });

  const items = order.lineItems as unknown as LineItem[];
  const li = items[index];
  if (!li) return json({ error: "Line item not found" }, { status: 404 });

  if (!li.match?.variantId) {
    return json({ error: "No variantId to accept" }, { status: 400 });
  }

  // Only accept if it was auto-mapped or needs-review (human is explicitly approving it)
  if (li.match.status !== "AUTO_MAPPED" && li.match.status !== "NEEDS_REVIEW") {
    return json({ error: "This line is not in a state that can be accepted" }, { status: 400 });
  }

  items[index] = {
    ...li,
    match: {
      ...li.match,
      status: "MAPPED",
      // optional cleanup
      candidates: undefined,
      confidence: undefined,
    },
  };

  await prisma.pendingOrder.update({
    where: { id },
    data: { lineItems: items },
  });

  return redirect("/pending-orders");
}
