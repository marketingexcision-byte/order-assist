import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect, json } from "@remix-run/node";
import { autoMapPendingOrderLineItems } from "../autoMapPendingOrder.server";

export async function action({ params }: ActionFunctionArgs) {
  console.log("AUTO-MAP ACTION HIT");

  const id = params.id;
  if (!id) return json({ error: "Missing id" }, { status: 400 });

  await autoMapPendingOrderLineItems(id);

  return redirect("/pending-orders");
}


import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

export async function loader({}: LoaderFunctionArgs) {
  return json({ error: "Use POST" }, { status: 405 });
}
