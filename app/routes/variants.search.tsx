import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { searchVariantsByText } from "../shopify/adminCatalog.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ hits: [] });

  const hits = await searchVariantsByText(q);
  return json({ hits });
}
