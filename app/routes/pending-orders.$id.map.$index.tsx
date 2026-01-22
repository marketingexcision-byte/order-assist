import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { prisma } from "../db.server";

import { searchVariantsByText, getVariantById } from "../shopify/adminCatalog.server";

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



export async function loader({ params, request }: LoaderFunctionArgs) {
  const id = params.id;
  const indexStr = params.index;

  if (!id || indexStr == null) throw new Response("Missing params", { status: 400 });

  const index = Number(indexStr);
  if (!Number.isFinite(index) || index < 0) throw new Response("Bad index", { status: 400 });

  const order = await prisma.pendingOrder.findUnique({ where: { id } });
  if (!order) throw new Response("Not found", { status: 404 });

  const items = order.lineItems as unknown as LineItem[];
  const item = items[index];
  if (!item) throw new Response("Line item not found", { status: 404 });

  const url = new URL(request.url);
  const qParam = (url.searchParams.get("q") || "").trim();

  let q = qParam || item.rawText;
  let hits = [] as Awaited<ReturnType<typeof searchVariantsByText>>;

  if (qParam) {
    // User explicitly searched. Always honor it.
    hits = await searchVariantsByText(qParam);
  } else if (item.match?.status === "NEEDS_REVIEW" && item.match.candidates?.length) {
    // Auto-map already computed candidates. Use them.
    hits = item.match.candidates.map((c) => {
      const display = c.displayTitle ?? "Unknown";
      const [productTitlePart, rest] = display.split(" · ");
      const skuMatch = display.match(/\(SKU:\s*([^)]+)\)/i);

      return {
        id: c.variantId,
        productTitle: productTitlePart || "Unknown product",
        title: rest?.replace(/\s*\(SKU:.*\)\s*$/, "") || "Unknown variant",
        sku: c.sku ?? (skuMatch ? skuMatch[1] : undefined),
      };
    });
  } else {
    // Default fallback
    hits = await searchVariantsByText(item.rawText);
  }



  console.log("[map] rawText:", item.rawText, "hits:", hits.length);


  return json({
    id,
    index,
    rawText: item.rawText,
    quantity: item.quantity,
    hits,
    q,
  });

}

export async function action({ request, params }: ActionFunctionArgs) {
  const id = params.id;
  const indexStr = params.index;

  if (!id || indexStr == null) throw new Response("Missing params", { status: 400 });

  const index = Number(indexStr);
  if (!Number.isFinite(index) || index < 0) throw new Response("Bad index", { status: 400 });

  const form = await request.formData();
  const variantId = String(form.get("variantId") || "");
  if (!variantId) return json({ error: "Pick a variant" }, { status: 400 });

  const v = await getVariantById(variantId);
  if (!v) return json({ error: "Variant not found" }, { status: 400 });

  const niceTitle = `${v.productTitle} · ${v.title}${v.sku ? ` (SKU: ${v.sku})` : ""}`;

  const order = await prisma.pendingOrder.findUnique({ where: { id } });
  if (!order) throw new Response("Not found", { status: 404 });

  const items = order.lineItems as unknown as LineItem[];
  if (!items[index]) throw new Response("Line item not found", { status: 404 });

  items[index] = {
    ...items[index],
    match: {
      status: "MAPPED",
      variantId: v.id,
      sku: v.sku ?? undefined,
      displayTitle: niceTitle,
    },
  };

  await prisma.pendingOrder.update({
    where: { id },
    data: { lineItems: items },
  });

const returnTo = String(form.get("returnTo") || "/pending-orders");
return redirect(returnTo);

}

export default function MapLineItemPage() {
  const { id, index, rawText, quantity, hits: initialHits, q: initialQ } =
    useLoaderData<typeof loader>();

  const [query, setQuery] = useState(initialQ || "");
  const [hits, setHits] = useState(initialHits || []);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>("");

  const trimmed = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    let alive = true;

    if (trimmed.length < 2) {
      setHits([]);
      setOpen(false);
      return;
    }

    const t = setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(`/variants/search?q=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        if (!alive) return;
        setHits(Array.isArray(data?.hits) ? data.hits : []);
        setOpen(true);
      } finally {
        if (alive) setLoading(false);
      }
    }, 200);

    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [trimmed]);

  return (
    <div className="section section--blue-page">
      <div className="container">
        <div className="on-blue">
          <header className="section__header section__header--blue">
            <h1 className="section__title">Map line item</h1>
            <p className="section__subtitle">
              Pick the correct Shopify variant. Search by SKU or keywords.
            </p>
          </header>
        </div>

        <div className="sidebar-layout">
          <aside className="card">
            <div className="card__header">
              <h2 className="card__title">Actions</h2>
              <div className="text-ps text-iron">Return to the queue when done.</div>
            </div>

            <div className="card__body">
              <Link to="/pending-orders?status=READY_FOR_REVIEW" className="btn btn-outline">
                ← Back to Pending Orders
              </Link>

              <div className="mt-4 text-ps text-iron">
                <div className="mb-2">
                  <span className="font-bold">Raw text</span>
                  <div>{rawText}</div>
                </div>
                <div>
                  <span className="font-bold">Qty</span>. {quantity}
                </div>
              </div>
            </div>
          </aside>

          <main>
            <div className="card">
              <div className="card__header">
                <h2 className="card__title">Search catalogue</h2>
                <div className="text-ps text-iron">
                  Start typing. Results update automatically. Minimum 2 characters.
                </div>
              </div>

              <div className="card__body">
                <div className="grid" style={{ gap: "var(--space-3)" }}>
                  <div className="grid" style={{ gap: "var(--space-2)" }}>
                    <input
                      className="form-input"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onFocus={() => {
                        if (hits.length) setOpen(true);
                      }}
                      placeholder="Search SKU or product name"
                    />

                    <div className="text-ps text-iron">
                      {loading ? "Searching…" : trimmed.length >= 2 ? `${hits.length} results` : " "}
                    </div>
                  </div>

                  {open && hits.length ? (
                    <div
                      className="card"
                      style={{
                        border: "1px solid var(--border)",
                        maxHeight: 360,
                        overflow: "auto",
                      }}
                    >
                      <div className="card__body">
                        <div className="grid" style={{ gap: 10 }}>
                          {hits.map((h: any) => {
                            const niceTitle = `${h.productTitle} · ${h.title}${
                              h.sku ? ` (SKU: ${h.sku})` : ""
                            }`;

                            const isActive = selected === h.id;

                            return (
                              <button
                                key={h.id}
                                type="button"
                                className={`btn btn--clear`}
                                style={{
                                  textAlign: "left",
                                  padding: 12,
                                  borderRadius: 12,
                                  border: "1px solid var(--border)",
                                  background: isActive ? "rgba(0,0,0,0.04)" : "transparent",
                                }}
                                onClick={() => setSelected(h.id)}
                              >
                                <div className="font-bold">{niceTitle}</div>
                                <div className="text-ps text-iron">
                                  Variant ID. {h.id.slice(0, 18)}…
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {trimmed.length >= 2 && !loading && hits.length === 0 ? (
                    <div className="alert alert--warning">
                      <div className="font-bold mb-1">No results</div>
                      <div className="text-p1">
                        Try SKU, a shorter keyword, or remove punctuation.
                      </div>
                    </div>
                  ) : null}



                  <Form method="post">

                    <input type="hidden" name="returnTo" value="/pending-orders?status=READY_FOR_REVIEW" />

                    <input type="hidden" name="variantId" value={selected} />
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={!selected}
                      title={!selected ? "Select a variant first" : undefined}
                    >
                      Save mapping
                    </button>
                  </Form>

                  {initialHits?.length ? (
                    <details className="mt-2">
                      <summary className="btn btn--clear">
                        <span className="font-bold">Show suggested matches</span>
                      </summary>

                      <div className="mt-3">
                        <div className="grid" style={{ gap: 10 }}>
                          {initialHits.map((h: any) => {
                            const niceTitle = `${h.productTitle} · ${h.title}${
                              h.sku ? ` (SKU: ${h.sku})` : ""
                            }`;

                            return (
                              <button
                                key={h.id}
                                type="button"
                                className="btn btn--clear"
                                style={{
                                  textAlign: "left",
                                  padding: 12,
                                  borderRadius: 12,
                                  border: "1px solid var(--border)",
                                }}
                                onClick={() => setSelected(h.id)}
                              >
                                <div className="font-bold">{niceTitle}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="card card--compact mt-4">
              <div className="card__header">
                <h2 className="card__title">Tip</h2>
              </div>
              <div className="card__body">
                <div className="text-p1">
                  If two options are close. Prefer the exact SKU match. If the customer code is in the line,
                  search that plus a keyword.
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

