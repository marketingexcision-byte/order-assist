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

export async function action({ params, request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const id = String(params.id || "");
  if (!id) return json({ error: "Missing id" }, { status: 400 });

  const order = await prisma.pendingOrder.findUnique({
    where: { id },
    select: { id: true, lineItems: true },
  });

  if (!order) return json({ error: "Order not found" }, { status: 404 });

  const items = (order.lineItems as unknown as LineItem[]) ?? [];

  let changed = false;

  const nextItems = items.map((li) => {
    const status = li.match?.status;

    // Only AUTO_MAPPED -> MAPPED. Everything else is untouched.
    if (status !== "AUTO_MAPPED") return li;

    changed = true;

    return {
      ...li,
      match: {
        ...(li.match ?? { status: "AUTO_MAPPED" }),
        status: "MAPPED",
      },
    };
  });

  if (changed) {
    await prisma.pendingOrder.update({
      where: { id },
      data: { lineItems: nextItems as any },
    });
  }

  return redirect("/pending-orders");
}
