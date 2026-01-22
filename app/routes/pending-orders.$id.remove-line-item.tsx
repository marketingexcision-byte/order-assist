import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect, json } from "@remix-run/node";
import { prisma } from "../db.server";
import { autoMapPendingOrderLineItems } from "../autoMapPendingOrder.server";

type LineItem = {
  rawText: string;
  quantity: number;
  match?: any;
};

export async function action({ request, params }: ActionFunctionArgs) {
  const id = String(params.id || "");
  if (!id) return json({ error: "Missing order id" }, { status: 400 });

  const form = await request.formData();
  const index = Number(form.get("index"));
  const returnTo = String(form.get("returnTo") || "/pending-orders?status=READY_FOR_REVIEW");

  if (!Number.isFinite(index) || index < 0) {
    return json({ error: "Invalid index" }, { status: 400 });
  }

  const order = await prisma.pendingOrder.findUnique({ where: { id } });
  if (!order) return json({ error: "Order not found" }, { status: 404 });

  const items = order.lineItems as unknown as LineItem[];
  if (items.length <= 1) {
    return json({ error: "Order must have at least one item" }, { status: 400 });
  }

  if (index >= items.length) {
    return json({ error: "Index out of range" }, { status: 400 });
  }

  const cleaned = items.filter((_, i) => i !== index);

  await prisma.pendingOrder.update({
    where: { id },
    data: { lineItems: cleaned },
  });

  await autoMapPendingOrderLineItems(id);

  return redirect(returnTo);
}
