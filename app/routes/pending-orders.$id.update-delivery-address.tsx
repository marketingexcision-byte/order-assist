import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "../db.server";


function clean(v: FormDataEntryValue | null): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

export async function action({ params, request }: ActionFunctionArgs) {
  const id = params.id;
  if (!id) return json({ ok: false, error: "Missing id" }, { status: 400 });

  const form = await request.formData();
  const intent = clean(form.get("intent"));

  if (intent === "clear") {
    await prisma.pendingOrder.update({
      where: { id },
      data: { deliveryAddress: null, deliveryAddressSource: "MANUAL" },
    });
    return json({ ok: true });
  }

    const deliveryAddress = {
    firstName: clean(form.get("firstName")),
    lastName: clean(form.get("lastName")),

    attention: clean(form.get("attention")),
    company: clean(form.get("company")),

    line1: clean(form.get("line1")),
    line2: clean(form.get("line2")),

    suburb: clean(form.get("suburb")),
    state: clean(form.get("state")),
    postcode: clean(form.get("postcode")),
    country: clean(form.get("country")),

    phone: clean(form.get("phone")),
    instructions: clean(form.get("instructions")),
  };


  await prisma.pendingOrder.update({
    where: { id },
    data: { deliveryAddress, deliveryAddressSource: "MANUAL" },
  });

  return json({ ok: true });
}
