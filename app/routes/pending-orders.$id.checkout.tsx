import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function storefront(query: string, variables: any) {
  const res = await fetch(env("SHOPIFY_STOREFRONT_URL"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": env("SHOPIFY_STOREFRONT_TOKEN"),
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error(json);
    throw new Error("Storefront API error");
  }
  return json.data;
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new Response("Missing id", { status: 400 });

  const order = await prisma.pendingOrder.findUnique({ where: { id } });
  if (!order || order.status !== "APPROVED") {
    throw new Response("Order not approved", { status: 400 });
  }

  const items = order.lineItems as any[];

  // HARD BLOCK: never generate checkout unless everything is mapped
  for (const [i, li] of items.entries()) {
    if (
      !li.match?.variantId ||
      (li.match.status !== "MAPPED" && li.match.status !== "AUTO_MAPPED")
    ) {
      throw new Error(`Line item ${i} not mapped`);
    }
  }

  const delivery = (order as any).deliveryAddress ?? null;

  const CART_CREATE = `
    mutation CartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          checkoutUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const cartInput: any = {
    lines: items.map((li) => ({
      merchandiseId: li.match.variantId,
      quantity: Math.max(1, Number(li.quantity || 1)),
    })),
  };

  if (delivery?.line1 && delivery?.postcode) {
    cartInput.buyerIdentity = {
      countryCode: "AU",
      deliveryAddressPreferences: [
        {
          oneTimeUse: true,
          deliveryAddress: {
            firstName: delivery.firstName ?? undefined,
            lastName: delivery.lastName ?? undefined,
            company: delivery.company ?? undefined,
            phone: delivery.phone ?? undefined,
            address1: delivery.line1,
            address2: delivery.line2 ?? undefined,
            city: delivery.suburb ?? undefined,
            province: delivery.state ?? undefined,
            country: "AU",
            zip: delivery.postcode,
          },
        },
      ],
    };
  }

  const data = await storefront(CART_CREATE, { input: cartInput });

  const errs = data?.cartCreate?.userErrors || [];
  if (errs.length) {
    throw new Error(errs.map((e: any) => e.message).join("; "));
  }

  const checkoutUrl = data?.cartCreate?.cart?.checkoutUrl;
  if (!checkoutUrl) throw new Error("Missing checkoutUrl");

  // THIS is the entire point of the route
  return redirect(checkoutUrl);
}

// No default export.
// No JSX.
// No page.
// This route is a redirect-only endpoint.
