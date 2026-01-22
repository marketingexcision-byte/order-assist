// app/routes/admin.revert-default-addresses.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "../db.server";
import { deleteCustomerAddress, getCustomerDefaultAddressId, setCustomerDefaultAddress } from "../shopify/adminCustomers.server";

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function action({ request }: ActionFunctionArgs) {
  const secret = env("INGEST_SECRET"); // reuse, or create a new CRON_SECRET
  const got = request.headers.get("x-revert-secret");
  if (got !== secret) return new Response("Unauthorized", { status: 401 });

  const now = new Date();

  const due = await prisma.pendingOrder.findMany({
    where: {
      defaultAddressRevertAt: { lte: now },
      defaultAddressRevertedAt: null,
      shopifyCustomerId: { not: null },
      prevDefaultAddressId: { not: null },
      tempDefaultAddressId: { not: null },
    } as any,
    take: 50,
  });

  let reverted = 0;
  let skipped = 0;

  for (const po of due) {
    const customerId = (po as any).shopifyCustomerId as string;
    const prevId = (po as any).prevDefaultAddressId as string;
    const tempId = (po as any).tempDefaultAddressId as string;

    // Safety check: only revert if default is STILL the temp address we set.
    const currentDefault = await getCustomerDefaultAddressId(customerId);
    if (currentDefault !== tempId) {
      skipped++;
      await prisma.pendingOrder.update({
        where: { id: po.id },
        data: { defaultAddressRevertedAt: now } as any, // mark done so we don't hammer forever
      });
      continue;
    }

    await setCustomerDefaultAddress(customerId, prevId);

    // Optional: delete temp address so you don't litter their account
    await deleteCustomerAddress(tempId);

    await prisma.pendingOrder.update({
      where: { id: po.id },
      data: { defaultAddressRevertedAt: now } as any,
    });

    reverted++;
  }

  return json({ reverted, skipped, checked: due.length });
}
