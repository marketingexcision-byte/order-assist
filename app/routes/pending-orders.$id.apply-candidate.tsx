import type { ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { prisma } from "../db.server";
import { autoMapPendingOrderLineItems } from "../autoMapPendingOrder.server";
import { requireAdmin } from "../services/requireAdmin.server";


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

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdmin(request);

  const form = await request.formData();

  const id = params.id || String(form.get("id") || "");
  const indexRaw = form.get("index");
  const variantId = String(form.get("variantId") || "");
  const index = Number(indexRaw);

  if (!id) return json({ error: "Missing id" }, { status: 400 });
  if (!Number.isFinite(index))
    return json({ error: "Missing or invalid index" }, { status: 400 });
  if (!variantId) return json({ error: "Missing variantId" }, { status: 400 });

  const order = await prisma.pendingOrder.findUnique({ where: { id } });
  if (!order) return json({ error: "Order not found" }, { status: 404 });

  const items = order.lineItems as unknown as LineItem[];
  const item = items[index];
  if (!item) return json({ error: "Line item not found" }, { status: 404 });

  items[index] = {
    ...item,
    match: {
      ...(item.match ?? { status: "UNMAPPED" }),
      status: "MAPPED",
      variantId,
    },
  };

  await prisma.pendingOrder.update({
    where: { id },
    data: { lineItems: items },
  });

  await autoMapPendingOrderLineItems(id);

  return json({ ok: true });

}
