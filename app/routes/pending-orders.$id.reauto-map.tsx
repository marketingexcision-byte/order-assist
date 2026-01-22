import type { ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { prisma } from "../db.server";
import { autoMapPendingOrderLineItems } from "../autoMapPendingOrder.server";

type LineItem = {
  rawText: string;
  quantity: number;
  match?: {
    status: "UNMAPPED" | "AUTO_MAPPED" | "NEEDS_REVIEW" | "MAPPED";
    variantId?: string;
    sku?: string;
    displayTitle?: string;
  };
};

export async function action({ params }: ActionFunctionArgs) {
  const id = params.id;
  if (!id) return json({ error: "Missing id" }, { status: 400 });

  const order = await prisma.pendingOrder.findUnique({ where: { id } });
  if (!order) return json({ error: "Order not found" }, { status: 404 });

  const items = order.lineItems as unknown as LineItem[];

  // Reset only lines that are NOT manual-mapped
  const reset = items.map((li) => {
    const status = li.match?.status;

    // Keep manual mapping sacred
    if (status === "MAPPED") return li;

    // Anything else is eligible for re-auto-map
    return {
      ...li,
      match: { status: "UNMAPPED" as const },
    };
  });

  await prisma.pendingOrder.update({
    where: { id },
    data: { lineItems: reset },
  });

  // Deterministically re-run auto-map
  await autoMapPendingOrderLineItems(id);

  return redirect("/pending-orders");
}
