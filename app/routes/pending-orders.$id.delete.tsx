import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect, json } from "@remix-run/node";
import { prisma } from "../db.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const id = String(params.id || "");
  if (!id) return json({ error: "Missing order id" }, { status: 400 });

  const form = await request.formData();
  const returnTo = String(form.get("returnTo") || "/pending-orders?status=READY_FOR_REVIEW");

  await prisma.inboundEmail.updateMany({
    where: { pendingOrderId: id },
    data: { pendingOrderId: null },
  });

  await prisma.pendingOrder.delete({ where: { id } });

  return redirect(returnTo);
}
