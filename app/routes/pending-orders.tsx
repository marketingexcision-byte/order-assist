import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, Outlet, useActionData, useFetcher, useLoaderData, useLocation, useMatches, useNavigation, useRevalidator } from "@remix-run/react";
import { prisma } from "../db.server";
import { autoMapPendingOrderLineItems } from "../autoMapPendingOrder.server";
import { getVariantById, getVariantStockByIds } from "../shopify/adminCatalog.server";
import { computeStockBadge } from "../services/stockStatus";
import { useEffect, useMemo, useRef, useState } from "react";
import { requireAdmin } from "../services/requireAdmin.server";

type MatchStatus = "UNMAPPED" | "AUTO_MAPPED" | "MAPPED";

type LineItem = {
  rawText: string;
  quantity: number;
  match?: {
    status: MatchStatus;
    confidence?: number;
    variantId?: string;
    sku?: string;
    displayTitle?: string;
  };
};

type TabKey = "READY_FOR_REVIEW" | "APPROVED" | "REJECTED";

const AI_UNGROUNDED_PLACEHOLDER = "[[AI_UNGROUNDED_LINE_ITEM_REJECTED]]";

function humanizeEnum(s: string) {
  return s
    .trim()
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function orderStatusLabel(status: string) {
  // Explicit control for anything you care about
  if (status === "READY_FOR_REVIEW") return "Ready for review";
  if (status === "APPROVED") return "Approved";
  if (status === "REJECTED") return "Rejected";
  return humanizeEnum(status);
}

function matchStatusLabel(status: MatchStatus | undefined) {
  if (status === "AUTO_MAPPED") return "Auto";
  if (status === "MAPPED") return "Manual";
  if (status === "UNMAPPED") return "Unmapped";
  return "Unmapped";
}

function formatDeliveryAddressOneLine(addr: any): string {
  if (!addr) return "";
  const parts: string[] = [];
  if (addr.company) parts.push(String(addr.company));
  if (addr.line1) parts.push(String(addr.line1));
  const suburbLine = [addr.suburb, addr.state, addr.postcode]
    .filter(Boolean)
    .map(String)
    .join(" ");
  if (suburbLine) parts.push(suburbLine);
  if (addr.country) parts.push(String(addr.country));
  return parts.join(", ");
}

function parseMoney(n: unknown): number | null {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function formatMoney(n: number | null): string {
  if (n == null) return "–";
  // You can swap to Intl.NumberFormat later if you want currency formatting.
  return `$${n.toFixed(2)}`;
}




function extractSkuCandidate(rawText: string): string | null {
  const t = rawText.trim();
  if (!t) return null;

  // Common case: user pastes just the SKU
  if (/^[A-Za-z0-9._-]{5,}$/.test(t)) return t;

  // Pull first “SKU-like” token. Prefer long numeric SKUs first.
  const num = t.match(/\b\d{5,}\b/);
  if (num?.[0]) return num[0];

  const alpha = t.match(/\b[A-Za-z0-9._-]{5,}\b/);
  if (alpha?.[0]) return alpha[0];

  return null;
}



function getActiveTab(requestUrl: string): TabKey {
  const url = new URL(requestUrl);
  const raw = (url.searchParams.get("status") || "").toUpperCase();
  if (raw === "APPROVED") return "APPROVED";
  if (raw === "REJECTED") return "REJECTED";
  return "READY_FOR_REVIEW";
}

function OrderStatusBadge({ status }: { status: string }) {
  const cls =
    status === "READY_FOR_REVIEW"
      ? "badge badge--accent"
      : status === "APPROVED"
        ? "badge badge--primary"
        : status === "REJECTED"
          ? "badge badge--grey"
          : "badge badge--outline";

  return <span className={cls}>{orderStatusLabel(status)}</span>;

}

function LineItemBadge({ status }: { status: MatchStatus | undefined }) {
  const text = matchStatusLabel(status);

  const cls =
    status === "AUTO_MAPPED"
      ? "badge badge--primary"
      : status === "MAPPED"
        ? "badge badge--outline"
        : "badge badge--grey";

  return <span className={cls}>{text}</span>;
}


function formatItemLabel(item: LineItem) {
  return item.match?.displayTitle || item.rawText;
}

function isItemMapped(item: LineItem) {
  const status = item.match?.status;
  return (
    (status === "MAPPED" || status === "AUTO_MAPPED") && !!item.match?.variantId
  );
}

function findDuplicateVariantGroups(items: LineItem[]) {
  const groups = new Map<string, number[]>(); // variantId -> indices
  items.forEach((li, idx) => {
    const vid = li.match?.variantId;
    const status = li.match?.status;
    const mapped = !!vid && (status === "MAPPED" || status === "AUTO_MAPPED");
    if (!mapped) return;

    const arr = groups.get(vid!) ?? [];
    arr.push(idx);
    groups.set(vid!, arr);
  });

  return Array.from(groups.entries())
    .filter(([, idxs]) => idxs.length > 1)
    .map(([variantId, indices]) => ({ variantId, indices }));
}

function mergeDuplicatesByVariantId(items: LineItem[]): { merged: LineItem[]; changed: boolean } {
  const dupes = findDuplicateVariantGroups(items);
  if (dupes.length === 0) return { merged: items, changed: false };

  const toRemove = new Set<number>();
  const next = items.map((x) => ({ ...x })) as LineItem[];

  for (const g of dupes) {
    const [keep, ...rest] = g.indices;
    const sumQty = g.indices.reduce((acc, i) => acc + Number(next[i]?.quantity ?? 0), 0);

    next[keep] = {
      ...next[keep],
      quantity: Math.max(1, sumQty),
    };

    for (const i of rest) toRemove.add(i);
  }

  const merged = next.filter((_, idx) => !toRemove.has(idx));
  return { merged, changed: true };
}


export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const origin = process.env.APP_URL ?? new URL(request.url).origin;

  const activeTab = getActiveTab(request.url);

  let orders = await prisma.pendingOrder.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // Sort priority (only really matters for READY_FOR_REVIEW tab)
  orders = orders.sort((a, b) => {
    const aItems = a.lineItems as LineItem[];
    const bItems = b.lineItems as LineItem[];

    const aReady = a.status === "READY_FOR_REVIEW";
    const bReady = b.status === "READY_FOR_REVIEW";

    if (aReady !== bReady) {
      return Number(bReady) - Number(aReady);
    }

    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const mapped = orders.map((o) => ({
    id: o.id,
    poNumber: (o as any).poNumber ?? null,
    status: o.status as TabKey | string,
    deliveryAddress: (o as any).deliveryAddress ?? null,
    deliveryAddressSource: (o as any).deliveryAddressSource ?? null,
    lineItems: o.lineItems as unknown as LineItem[],
    createdAt: o.createdAt,
  }));



  const counts = {
    READY_FOR_REVIEW: mapped.filter((o) => o.status === "READY_FOR_REVIEW").length,
    APPROVED: mapped.filter((o) => o.status === "APPROVED").length,
    REJECTED: mapped.filter((o) => o.status === "REJECTED").length,
  };

  const visible = mapped.filter((o) => o.status === activeTab);

  // Batch stock lookup for visible orders only (keeps it fast)
  const variantIds: string[] = [];
  for (const o of visible) {
    for (const li of o.lineItems) {
      const vid = li.match?.variantId;
      if (vid && (li.match?.status === "MAPPED" || li.match?.status === "AUTO_MAPPED")) {
        variantIds.push(vid);
      }
    }
  }

  let variantStockById: Record<
    string,
    {
      id: string;
      inventoryQuantity: number | null;
      productTags: string[];
      restockDate: string | null;

      // pricing
      price: string | null; // Shopify returns strings for money
      compareAtPrice: string | null;
    }
  > = {};

  try {
    variantStockById = await getVariantStockByIds(variantIds);
    console.log("[stock] requested:", variantIds.length, "returned:", Object.keys(variantStockById).length);


    console.log("[stock] requested variantIds", variantIds.length);
    console.log("[stock] returned keys", Object.keys(variantStockById).length);

    const sample = variantIds[0];
    if (sample) {
      console.log("[stock] sample id", sample);
      console.log("[stock] sample value", variantStockById[sample]);
    }

  } catch (e) {
    // Never break review UI because Shopify hiccuped
    variantStockById = {};
  }


  return json({
    origin,
    activeTab,
    counts,
    orders: visible,
    variantStockById,
  });
}

export async function action({ request }: ActionFunctionArgs) {
    await requireAdmin(request);

  const form = await request.formData();

  const intent = String(form.get("intent") || "");
  const id = String(form.get("id") || "");
  const returnTo = String(form.get("returnTo") || "/pending-orders");

  if (!id) return json({ error: "Missing id" }, { status: 400 });

  if (intent === "set_variant") {
    const order = await prisma.pendingOrder.findUnique({ where: { id } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const index = Number(form.get("index"));
    const variantId = String(form.get("variantId") || "").trim();

    if (!variantId) return json({ error: "Missing variantId" }, { status: 400 });
    if (!Number.isFinite(index) || index < 0) return json({ error: "Bad index" }, { status: 400 });

    const items = order.lineItems as unknown as LineItem[];
    // If user didn't select a variant from the dropdown, we can still detect duplicates
    // by extracting an SKU candidate from the entered text.


    if (!items[index]) return json({ error: "Line item not found" }, { status: 404 });

    const v = await getVariantById(variantId);
    if (!v) return json({ error: "Variant not found" }, { status: 404 });

    const niceTitle = `${v.productTitle} · ${v.title}${v.sku ? ` (SKU: ${v.sku})` : ""}`;

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

    return json({ ok: true });

  }


  if (intent === "approve") {
    const order = await prisma.pendingOrder.findUnique({ where: { id } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const items = order.lineItems as unknown as LineItem[];

    const hasUnmapped = items.some((li) => {
      if (!li.match?.variantId) return true;
      return li.match.status !== "MAPPED" && li.match.status !== "AUTO_MAPPED";
    });

    if (hasUnmapped) {
      return json(
        {
          error:
            "Cannot approve. One or more items are not mapped to a variant yet.",
        },
        { status: 400 }
      );
    }

    const updated = await prisma.pendingOrder.update({
      where: { id },
      data: { status: "APPROVED" },
    });

    const setDefaultAddress = String(form.get("setDefaultAddress") || "") === "1";

    const checkoutUrl = setDefaultAddress
      ? `/pending-orders/${updated.id}/checkout?setDefaultAddress=1`
      : `/pending-orders/${updated.id}/checkout`;

    return redirect(checkoutUrl);


  }

  if (intent === "reject") {
    await prisma.pendingOrder.update({
      where: { id },
      data: { status: "REJECTED" },
    });
    return redirect(returnTo);
  }

  if (intent === "update_one_line_item") {
    const order = await prisma.pendingOrder.findUnique({ where: { id } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const index = Number(form.get("index"));
    const rawText = String(form.get("rawText") || "").trim();
    const rawQty = String(form.get("quantity") || "").trim();
    const parsedQty = Number(rawQty);
    const quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;


    if (!Number.isFinite(index) || index < 0) {
      return json({ error: "Bad index" }, { status: 400 });
    }

    const items = order.lineItems as unknown as LineItem[];
    if (!items[index]) return json({ error: "Line item not found" }, { status: 404 });
    if (!rawText) return json({ error: "Item text cannot be empty" }, { status: 400 });

    const prevRaw = items[index].rawText;

    items[index] = {
      ...items[index],
      rawText,
      quantity,
      match:
        prevRaw !== rawText
          ? { status: "UNMAPPED" }
          : (items[index].match ?? { status: "UNMAPPED" }),
    };

    await prisma.pendingOrder.update({
      where: { id },
      data: { lineItems: items },
    });

    await autoMapPendingOrderLineItems(id);

    return json({ ok: true });
  }

  if (intent === "add_line_item") {
    const order = await prisma.pendingOrder.findUnique({ where: { id } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const rawText = String(form.get("rawText") || "").trim();
    const rawQty = String(form.get("quantity") || "").trim();
    const parsedQty = Number(rawQty);
    const quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;

    const variantId = String(form.get("variantId") || "").trim() || null;
    const forceSeparate = String(form.get("forceSeparate") || "") === "1";

    if (!rawText) return json({ error: "Item text cannot be empty" }, { status: 400 });
    if (rawText === AI_UNGROUNDED_PLACEHOLDER) {
      return json({ error: "Invalid item text" }, { status: 400 });
    }

    const items = order.lineItems as unknown as LineItem[];

    // If user selected a variant, we can do a strong duplicate check.
    if (variantId && !forceSeparate) {
      const existingIndex = items.findIndex((li) => li.match?.variantId === variantId);
      if (existingIndex >= 0) {
        return json({
          mergeSuggested: true,
          existingIndex,
          addedQty: quantity,
          variantId,
        });
      }
    }

    // Create the new line item.
    let nextItem: LineItem = {
      rawText,
      quantity,
      match: { status: "UNMAPPED" },
    };

    // If variantId provided, store it as manually mapped immediately.
    if (variantId) {
      const v = await getVariantById(variantId);
      if (!v) return json({ error: "Variant not found" }, { status: 404 });

      const niceTitle = `${v.productTitle} · ${v.title}${v.sku ? ` (SKU: ${v.sku})` : ""}`;

      nextItem = {
        rawText,
        quantity,
        match: {
          status: "MAPPED",
          variantId: v.id,
          sku: v.sku ?? undefined,
          displayTitle: niceTitle,
        },
      };
    }

    const nextItems: LineItem[] = [...items, nextItem];

    await prisma.pendingOrder.update({
      where: { id },
      data: { lineItems: nextItems },
    });

    // Only automap if the user didn't explicitly select a variant.
    if (!variantId) {
      await autoMapPendingOrderLineItems(id);
    }

    return json({ ok: true });
  }

  if (intent === "merge_line_item") {
    const order = await prisma.pendingOrder.findUnique({ where: { id } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const existingIndex = Number(form.get("existingIndex"));
    const rawQty = String(form.get("addedQty") || "").trim();
    const parsedQty = Number(rawQty);
    const addedQty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;

    if (!Number.isFinite(existingIndex) || existingIndex < 0) {
      return json({ error: "Bad index" }, { status: 400 });
    }

    const items = order.lineItems as unknown as LineItem[];
    if (!items[existingIndex]) return json({ error: "Line item not found" }, { status: 404 });

    items[existingIndex] = {
      ...items[existingIndex],
      quantity: Math.max(1, Number(items[existingIndex].quantity ?? 1) + addedQty),
    };

    await prisma.pendingOrder.update({
      where: { id },
      data: { lineItems: items },
    });

    return json({ ok: true, merged: true });
  }

  if (intent === "merge_duplicates") {
    const order = await prisma.pendingOrder.findUnique({ where: { id } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const items = order.lineItems as unknown as LineItem[];
    const { merged, changed } = mergeDuplicatesByVariantId(items);

    if (!changed) return json({ ok: true, merged: false });

    await prisma.pendingOrder.update({
      where: { id },
      data: { lineItems: merged },
    });

    return json({ ok: true, merged: true });
  }




  if (intent === "update_line_items") {
    const order = await prisma.pendingOrder.findUnique({ where: { id } });
    if (!order) return json({ error: "Order not found" }, { status: 404 });

    const existing = order.lineItems as unknown as LineItem[];
    const items: (LineItem | null)[] = [];

    for (const [key, value] of form.entries()) {
      const match = key.match(/^items\[(\d+)\]\[(rawText|quantity|remove)\]$/);
      if (!match) continue;

      const index = Number(match[1]);
      const field = match[2];

      if (!items[index]) {
        items[index] = {
          rawText: existing[index]?.rawText ?? "",
          quantity: existing[index]?.quantity ?? 1,
          match: existing[index]?.match ?? { status: "UNMAPPED" },
        };
      }

      if (field === "rawText") {
        const next = String(value);
        const prev = existing[index]?.rawText;

        (items[index] as LineItem).rawText = next;

        if (prev !== next) {
          (items[index] as LineItem).match = { status: "UNMAPPED" };
        } else {
          (items[index] as LineItem).match =
            existing[index]?.match ?? { status: "UNMAPPED" };
        }
      }

      if (field === "quantity") {
        (items[index] as LineItem).quantity = Math.max(1, Number(value));
      }

      if (field === "remove") {
        items[index] = null;
      }
    }

    const cleaned = items.filter(Boolean) as LineItem[];
    if (cleaned.length === 0) {
      return json({ error: "Order must have at least one item" }, { status: 400 });
    }

    await prisma.pendingOrder.update({
      where: { id },
      data: { lineItems: cleaned },
    });

    await autoMapPendingOrderLineItems(id);

    return redirect(returnTo);
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

function InlineEditableQty(props: {
  orderId: string;
  index: number;
  item: LineItem;
  returnTo: string;
}) {
  const { orderId, index, item, returnTo } = props;
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);
  const [qtyText, setQtyText] = useState<string>(String(item.quantity));

  useEffect(() => {
    if (!editing) setQtyText(String(item.quantity));
  }, [item.quantity, editing]);


  function submit(nextQty: number) {
    const fd = new FormData();
    fd.set("intent", "update_one_line_item");
    fd.set("id", orderId);
    fd.set("returnTo", returnTo);
    fd.set("index", String(index));
    fd.set("rawText", item.rawText);
    fd.set("quantity", String(Math.max(1, nextQty)));
    fetcher.submit(fd, { method: "post", preventScrollReset: true });
  }

  if (!editing) {
    return (
      <div
        className="editable"
        onClick={() => {
          setEditing(true);
          setQtyText(String(item.quantity));
        }}
        title="Click to edit quantity"
        style={{ cursor: "text" }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
            setQtyText(String(item.quantity));
          }
        }}
      >
        {item.quantity}
      </div>
    );
  }

  return (
    <input
      className="form-input"
      type="number"
      min={1}
      value={qtyText}
      autoFocus
      onChange={(e) => setQtyText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setEditing(false);
          submit(Number(qtyText));
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
          setQtyText(String(item.quantity));
        }
      }}
      onBlur={() => {
        setEditing(false);
        if (Number(qtyText) !== item.quantity) submit(Number(qtyText));
        else setQtyText(String(item.quantity));
      }}
      style={{ width: 90 }}
    />
  );
}



function InlineEditableLineItem(props: {
  orderId: string;
  index: number;
  item: LineItem;
  returnTo: string;
}) {
  const { orderId, index, item, returnTo } = props;

  const fetcher = useFetcher();

  const [editingText, setEditingText] = useState(false);
  const [raw, setRaw] = useState(item.rawText);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const [hits, setHits] = useState<
    Array<{ id: string; productTitle: string; title: string; sku: string | null }>
  >([]);
  const [loading, setLoading] = useState(false);

  const searchTerm = useMemo(() => raw.trim(), [raw]);

  useEffect(() => {
    if (!editingText) return;

    if (searchTerm.length < 2) {
      setHits([]);
      setOpen(false);
      return;
    }

    let alive = true;
    const t = setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(`/variants/search?q=${encodeURIComponent(searchTerm)}`);
        const data = await res.json();
        if (!alive) return;

        const nextHits = Array.isArray(data?.hits) ? data.hits : [];
        setHits(nextHits);
        setOpen(true);
        setActive(0);
      } finally {
        if (alive) setLoading(false);
      }
    }, 200);

    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [editingText, searchTerm]);

  function submitUpdate(nextRaw: string) {
    const fd = new FormData();
    fd.set("intent", "update_one_line_item");
    fd.set("id", orderId);
    fd.set("returnTo", returnTo);
    fd.set("index", String(index));
    fd.set("rawText", nextRaw);
    fd.set("quantity", String(Math.max(1, item.quantity)));
    fetcher.submit(fd, { method: "post", preventScrollReset: true });
  }

  function submitSetVariant(variantId: string) {
    const fd = new FormData();
    fd.set("intent", "set_variant");
    fd.set("id", orderId);
    fd.set("returnTo", returnTo);
    fd.set("index", String(index));
    fd.set("variantId", variantId);
    fetcher.submit(fd, { method: "post", preventScrollReset: true });
  }

  const label = formatItemLabel(item);

  return (
    <div>
      {!editingText ? (
        <div
          className="font-bold mb-1 editable"
          onClick={() => {
            setEditingText(true);
            setRaw(item.rawText);
            setOpen(true);
          }}
          title="Click to change"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setEditingText(true);
              setRaw(item.rawText);
              setOpen(true);
            }
          }}
        >
          {label}

        </div>

      ) : (
        <div className="grid" style={{ gap: 8 }}>
          <div style={{ position: "relative" }}>
            <input
              className="form-input"
              value={raw}
              autoFocus
              onChange={(e) => setRaw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                  setEditingText(false);
                  setRaw(item.rawText);
                  return;
                }

                if (e.key === "ArrowDown" && hits.length) {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, hits.length - 1));
                  return;
                }

                if (e.key === "ArrowUp" && hits.length) {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                  return;
                }

                if (e.key === "Enter") {
                  if (open && hits.length) {
                    e.preventDefault();
                    const h = hits[active];
                    submitSetVariant(h.id);
                    setOpen(false);
                    setEditingText(false);
                    return;
                  }

                  e.preventDefault();
                  setOpen(false);
                  setEditingText(false);

                  const next = raw.trim();
                  if (next) submitUpdate(next);
                  else setRaw(item.rawText);
                }

              }}
              onBlur={() => {
                setTimeout(() => {
                  setOpen(false);
                  setEditingText(false);

                  const next = raw.trim();
                  if (next) submitUpdate(next);
                  else setRaw(item.rawText);
                }, 150);
              }}
            />

            {open ? (
              <div className="typeahead">
                {loading ? (
                  <div className="typeahead__item typeahead__muted">Searching…</div>
                ) : null}

                {!loading && hits.length === 0 ? (
                  <div className="typeahead__item typeahead__muted">No results</div>
                ) : null}

                {!loading &&
                  hits.slice(0, 100).map((h, idx) => {
                    const niceTitle = `${h.productTitle} · ${h.title}${h.sku ? ` (SKU: ${h.sku})` : ""}`;
                    return (
                      <button
                        key={h.id}
                        type="button"
                        className={`typeahead__item ${idx === active ? "is-active" : ""}`}
                        onMouseEnter={() => setActive(idx)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          submitSetVariant(h.id);
                          setOpen(false);
                          setEditingText(false);
                        }}
                      >
                        <div className="typeahead__title">{niceTitle}</div>
                        <div className="typeahead__meta">Select</div>
                      </button>
                    );
                  })}
              </div>
            ) : null}
          </div>


        </div>
      )}

      {!editingText && item.match?.displayTitle ? (
        <div className="text-ps text-iron" style={{ paddingLeft: 8 }}>
          Original: {item.rawText}
        </div>
      ) : null}
    </div>
  );
}

function ConfirmModal(props: {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: "primary" | "accent" | "outline";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const {
    open,
    title,
    message,
    confirmText = "Confirm",
    cancelText = "Cancel",
    confirmVariant = "primary",
    onConfirm,
    onCancel,
  } = props;

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const confirmClass =
    confirmVariant === "accent"
      ? "btn btn--accent"
      : confirmVariant === "outline"
        ? "btn btn-outline"
        : "btn btn--primary";

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // click outside closes
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal-card" style={{ position: "relative" }}>
        <button
          type="button"
          className="icon-btn--close modal-card__close"
          aria-label="Close"
          title="Close"
          onClick={onCancel}
        />


        <div className="modal-card__header">
          <h3 className="modal-card__title">{title}</h3>
        </div>

        <div className="modal-card__body">
          <div className="text-p1">{message}</div>
        </div>

        <div className="modal-card__footer">
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            {cancelText}
          </button>
          <button type="button" className={confirmClass} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}


function AddLineItemRow(props: { orderId: string; returnTo: string }) {
  const { orderId, returnTo } = props;
  const fetcher = useFetcher();
  const rawInputRef = useRef<HTMLInputElement | null>(null);
  const qtyInputRef = useRef<HTMLInputElement | null>(null);
  const handledOkRef = useRef(false);



  const [rawText, setRawText] = useState("");
  const [qty, setQty] = useState("1");

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<Array<{ id: string; productTitle: string; title: string; sku?: string }>>([]);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<{ id: string; niceTitle: string } | null>(null);

  const revalidator = useRevalidator();

  const [mergePrompt, setMergePrompt] = useState<null | {
    existingIndex: number;
    addedQty: number;
  }>(null);


  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "submitting" || fetcher.state === "loading") {
      handledOkRef.current = false;
    }
  }, [fetcher.state]);

  const searchTerm = useMemo(() => rawText.trim(), [rawText]);
  const canSubmit = !!selected?.id || searchTerm.length > 0;


  // Variant search dropdown (same endpoint as InlineEditableLineItem)
  useEffect(() => {
    if (selected) return; // if selected, stop searching
    if (searchTerm.length < 2) {
      setHits([]);
      setOpen(false);
      return;
    }

    let alive = true;
    const t = setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(`/variants/search?q=${encodeURIComponent(searchTerm)}`);
        const data = await res.json();
        if (!alive) return;

        const nextHits = Array.isArray(data?.hits) ? data.hits : [];
        setHits(nextHits);
        setOpen(true);
        setActive(0);
      } finally {
        if (alive) setLoading(false);
      }
    }, 200);

    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [searchTerm, selected]);

  // Handle server responses: merge suggestion, success clear
  useEffect(() => {
    const d: any = fetcher.data;
    if (!d) return;

    if (d.mergeSuggested) {
      setMergePrompt({
        existingIndex: Number(d.existingIndex),
        addedQty: Number(d.addedQty),
      });
      return;
    }

    // Important: only handle success once per submission
    if (d.ok && fetcher.state === "idle" && !handledOkRef.current) {
      handledOkRef.current = true;

      setMergePrompt(null);
      setRawText("");
      setQty("1");
      setSelected(null);
      setHits([]);
      setOpen(false);
      setActive(0);

      // Refresh loader data once
      revalidator.revalidate();

      // Put cursor back in the raw text input
      setTimeout(() => rawInputRef.current?.focus(), 0);
    }
  }, [fetcher.data, fetcher.state, revalidator]);


  function submitMerge(existingIndex: number, addedQty: number) {
    const fd = new FormData();
    fd.set("intent", "merge_line_item");
    fd.set("id", orderId);
    fd.set("returnTo", returnTo);
    fd.set("existingIndex", String(existingIndex));
    fd.set("addedQty", String(Math.max(1, addedQty)));
    fetcher.submit(fd, { method: "post", preventScrollReset: true });
  }

  function submitForceSeparate() {
    const fd = new FormData();
    fd.set("intent", "add_line_item");
    fd.set("id", orderId);
    fd.set("returnTo", returnTo);
    fd.set("rawText", rawText.trim());
    fd.set("quantity", qty);
    if (selected?.id) fd.set("variantId", selected.id);
    fd.set("forceSeparate", "1");
    fetcher.submit(fd, { method: "post", preventScrollReset: true });
  }



  function submit() {
    const fd = new FormData();
    fd.set("intent", "add_line_item");
    fd.set("id", orderId);
    fd.set("returnTo", returnTo);
    fd.set("rawText", rawText.trim());
    fd.set("quantity", qty);
    if (selected?.id) fd.set("variantId", selected.id);
    fetcher.submit(fd, { method: "post", preventScrollReset: true });
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {mergePrompt ? (
        <div className="alert alert--warning">
          <div className="font-bold mb-1">Duplicate item found</div>
          <div className="text-p1">
            This product is already on this order. Do you want to add the quantities together?
          </div>

          <div className="flex" style={{ gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn--primary btn--small"
              onClick={() => {
                const p = mergePrompt;
                setMergePrompt(null);
                submitMerge(p.existingIndex, p.addedQty);
              }}
            >
              Combine
            </button>

            <button
              type="button"
              className="btn btn-outline btn--small"
              onClick={() => {
                setMergePrompt(null);
                submitForceSeparate();
              }}
            >
              Keep separate
            </button>

            <button
              type="button"
              className="btn btn-outline btn--small"
              onClick={() => setMergePrompt(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>

        <div style={{ position: "relative", flex: 1, minWidth: 260 }}>
          {selected ? (
            <div className="form-input" style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selected.niceTitle}
              </span>
              <button
                type="button"
                className="icon-btn--close"
                aria-label="Clear selection"
                title="Clear selection"
                onClick={() => {
                  setSelected(null);
                  setOpen(false);
                  setHits([]);
                  setTimeout(() => rawInputRef.current?.focus(), 0);
                }}
              />

            </div>
          ) : (
            <input
              ref={rawInputRef}
              className="form-input"
              placeholder="Add an item. Type to search or paste an item code…"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              onFocus={() => {
                if (hits.length) setOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                  return;
                }
                if (e.key === "ArrowDown" && hits.length) {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, hits.length - 1));
                  return;
                }
                if (e.key === "ArrowUp" && hits.length) {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (open && hits.length) {
                    const h = hits[active];
                    const niceTitle = `${h.productTitle} · ${h.title}${h.sku ? ` (SKU: ${h.sku})` : ""}`;
                    setSelected({ id: h.id, niceTitle });
                    setOpen(false);
                    return;
                  }
                  if (rawText.trim()) submit();
                }
              }}
              onBlur={() => {
                setTimeout(() => setOpen(false), 150);
              }}
            />
          )}

          {open && !selected ? (
            <div className="typeahead">
              {loading ? <div className="typeahead__item typeahead__muted">Searching…</div> : null}
              {!loading && hits.length === 0 ? (
                <div className="typeahead__item typeahead__muted">No results</div>
              ) : null}

              {!loading &&
                hits.slice(0, 50).map((h, idx) => {
                  const niceTitle = `${h.productTitle} · ${h.title}${h.sku ? ` (SKU: ${h.sku})` : ""}`;
                  return (
                    <button
                      key={h.id}
                      type="button"
                      className={`typeahead__item ${idx === active ? "is-active" : ""}`}
                      onMouseEnter={() => setActive(idx)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelected({ id: h.id, niceTitle });
                        setRawText(h.sku ?? niceTitle);
                        setOpen(false);
                      }}

                    >
                      <div className="typeahead__title">{niceTitle}</div>
                      <div className="typeahead__meta">Select</div>
                    </button>
                  );
                })}
            </div>
          ) : null}
        </div>

        <input
          ref={qtyInputRef}
          className="form-input"
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          style={{ width: 90 }}
        />

        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={busy || !canSubmit}
          onClick={submit}
        >
          Add
        </button>

        {(fetcher.data as any)?.error ? (
          <div className="text-ps text-accent" style={{ marginLeft: 8 }}>
            {String((fetcher.data as any).error)}
          </div>
        ) : null}
      </div>
    </div>
  );
}



export default function PendingOrdersPage() {
  const { orders, origin, activeTab, counts, variantStockById } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const actionData = useActionData<typeof action>();

  const navigation = useNavigation();

  // “Soft loading” states.
  // navigation.state covers tab changes + route transitions.
  // revalidator.state covers your manual polling + revalidate() calls.
  const isPageBusy = navigation.state !== "idle" || revalidator.state !== "idle";


  const matches = useMatches();
  const isCheckoutRoute = matches.some((m) => m.id === "routes/pending-orders.$id.checkout");

  const [incomingJob, setIncomingJob] = useState<null | { id: string; startedAt: string }>(null);
  const showIncomingCard = activeTab === "READY_FOR_REVIEW" && !!incomingJob;

  const incomingMessages = [
    "Detected a new order. Reading document",
    "Extracting line items",
    "Matching products to catalog",
  ];

  const [incomingMsgIndex, setIncomingMsgIndex] = useState(0);

  useEffect(() => {
    if (!showIncomingCard) return;

    const id = window.setInterval(() => {
      setIncomingMsgIndex((i) => (i + 1) % incomingMessages.length);
    }, 900);

    return () => window.clearInterval(id);
  }, [showIncomingCard]);


  useEffect(() => {
    if (activeTab !== "READY_FOR_REVIEW") {
      setIncomingJob(null);
      return;
    }

    let alive = true;
    let wasIncoming = false;

    async function tick() {
      try {
        const res = await fetch(`/ingest/status`);
        const data = await res.json();
        if (!alive) return;

        const isIncoming = !!data?.incoming && !!data?.job?.id;

        // If we just transitioned from incoming -> not incoming, force a refresh to pull the new order.
        if (wasIncoming && !isIncoming) {
          if (revalidator.state === "idle") revalidator.revalidate();
        }

        wasIncoming = isIncoming;

        if (isIncoming) {
          setIncomingJob({
            id: String(data.job.id),
            startedAt: String(data.job.startedAt ?? data.job.createdAt ?? ""),
          });
        } else {
          setIncomingJob(null);
        }
      } catch {
        if (!alive) return;
        // If polling fails, don't get stuck showing the incoming card forever.
        setIncomingJob(null);
      }
    }

    tick();
    const id = window.setInterval(tick, 1500);

    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [activeTab, revalidator]);




  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  const deleteFetcher = useFetcher();

  const [deletePrompt, setDeletePrompt] = useState<null | { orderId: string }>(null);
  const [searchText, setSearchText] = useState("");

  const deliveryFetcher = useFetcher();
  const [editDelivery, setEditDelivery] = useState<null | { orderId: string; deliveryAddress: any }>(null);




  const removeLineFetcher = useFetcher();
  const [removeLinePrompt, setRemoveLinePrompt] = useState<null | { orderId: string; index: number }>(null);

  const [approvePrompt, setApprovePrompt] = useState<null | { orderId: string }>(null);
  const [approveConfirmed, setApproveConfirmed] = useState(false);
  const [approveSetDefaultAddr, setApproveSetDefaultAddr] = useState(false);





  const mergeDupesFetcher = useFetcher();
  const [mergeDupesPrompt, setMergeDupesPrompt] = useState<null | { orderId: string }>(null);

  const filteredOrders = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return orders;



    return orders.filter((order) => {
      const po = String((order as any).poNumber ?? "").toLowerCase();
      const oid = String(order.id ?? "").toLowerCase();

      // line item fields
      const lineBlob = (order.lineItems ?? [])
        .map((li: any) => {
          const raw = String(li?.rawText ?? "");
          const title = String(li?.match?.displayTitle ?? "");
          const sku = String(li?.match?.sku ?? "");
          return `${raw} ${title} ${sku}`.toLowerCase();
        })
        .join(" ");

      return (
        po.includes(q) ||
        oid.includes(q) ||
        lineBlob.includes(q)
      );
    });
  }, [orders, searchText]);


  const renderOrders = (() => {
    // Build a single render list. Incoming placeholder is treated like a "card"
    const list: Array<{ __incoming?: true } | (typeof filteredOrders)[number]> =
      showIncomingCard ? ([{ __incoming: true }] as any).concat(filteredOrders) : filteredOrders;

    // Empty state for the ACTIVE TAB
    if (list.length === 0) {
      return (
        <div className="card">
          <div className="card__header">
            <h2 className="card__title">No orders here</h2>
          </div>
          <div className="card__body">
            <p className="text-p1">
              {activeTab === "READY_FOR_REVIEW"
                ? "New orders will appear here when they arrive."
                : activeTab === "APPROVED"
                  ? "Approved orders appear here."
                  : "Rejected orders appear here."}
            </p>
          </div>
        </div>
      );
    }

    // Render list items (incoming placeholder OR order)
    return list.map((row: any) => {
      // Incoming placeholder card
      if (row?.__incoming) {
        return (
          <div key="__incoming" className="card oa-pulse" aria-live="polite">
            <div className="card__header">
              <h2 className="card__title">New order arriving</h2>
              <div className="text-ps text-iron" style={{ marginTop: 6 }}>
                We’ve detected an incoming order. It will appear here automatically.
              </div>
            </div>

            <div className="card__body">
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  textAlign: "center",
                  padding: "22px 12px",
                  gap: 14,
                }}
              >
                <div className="oa-progress" style={{ width: "min(520px, 92%)" }} />

                <div
                  style={{
                    display: "grid",
                    placeItems: "center",
                    gap: 10,
                    padding: "14px 16px",
                    borderRadius: 16,
                    border: "1px solid var(--border)",
                    background: "rgba(255,255,255,0.85)",
                    boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
                    width: "min(520px, 92%)",
                  }}
                >
                  <div className="oa-spinner oa-spinner--lg" aria-hidden="true" />

                  <div style={{ display: "grid", gap: 4 }}>
                    <div className="font-bold">Working on it</div>
                    <div className="text-ps text-iron">
                      {incomingMessages[incomingMsgIndex]}.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      }

      // Normal order card
      const order = row as (typeof filteredOrders)[number];

      const anyAuto = order.lineItems.some((li: any) => li.match?.status === "AUTO_MAPPED");
      const hasUnmapped = order.lineItems.some((li: any) => !isItemMapped(li));
      const dupes = findDuplicateVariantGroups(order.lineItems);

      return (
        <div
          key={order.id}
          className="card"
          style={{ marginBottom: 'var(--space-6)' }}
        >
          {/* HEADER */}
          <div className="card__header">
            <div className="flex" style={{ justifyContent: "space-between", gap: 12 }}>
              <div>
                <h2 className="card__title mb-2">
                  {order.poNumber ? `PO ${order.poNumber}` : `Order ${order.id.slice(0, 8)}`}
                </h2>

                <div className="flex" style={{ alignItems: "center", gap: 10 }}>
                  <span className="text-ps text-iron">List</span>

                  <OrderStatusBadge status={order.status} />
                </div>
              </div>

              <div className="flex" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                {anyAuto ? (
                  <Form method="post" action={`/pending-orders/${order.id}/accept-all-auto`}>
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <button type="submit" className="btn btn-outline btn--small">
                      Accept all suggestions
                    </button>
                  </Form>
                ) : null}

                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  disabled={hasUnmapped}
                  title={hasUnmapped ? "Choose a product for every item before continuing." : undefined}
                  onClick={() => {
                    if (hasUnmapped) return;
                    setApproveConfirmed(false);
                    setApproveSetDefaultAddr(false);
                    setApprovePrompt({ orderId: order.id });
                  }}
                >
                  Continue to checkout
                </button>

                <Form method="post">
                  <input type="hidden" name="id" value={order.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit" name="intent" value="reject" className="btn btn-outline btn--small">
                    Move to rejected
                  </button>
                </Form>

                <deleteFetcher.Form
                  method="post"
                  action={`/pending-orders/${order.id}/delete`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setDeletePrompt({ orderId: order.id });
                  }}
                >
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button
                    type="submit"
                    className="icon-btn--close"
                    aria-label="Delete PO"
                    title="Delete order"
                  />
                </deleteFetcher.Form>
              </div>
            </div>
          </div>

          {/* BODY */}
          <div className="card__body">
            {dupes.length ? (
              <div className="alert alert--warning mb-4">
                <div className="font-bold mb-1">Duplicate items found</div>
                <div className="text-p1">
                  This order has the same product listed more than once. Combine them into one line and add the quantities together.
                </div>

                <mergeDupesFetcher.Form
                  method="post"
                  style={{ marginTop: 10 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setMergeDupesPrompt({ orderId: order.id });
                  }}
                >
                  <input type="hidden" name="intent" value="merge_duplicates" />
                  <input type="hidden" name="id" value={order.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit" className="btn btn--primary btn--small">
                    Combine duplicates
                  </button>
                </mergeDupesFetcher.Form>
              </div>
            ) : null}

            {anyAuto ? (
              <div className="alert alert--info mb-4">
                <div className="font-bold mb-1">Suggestions available</div>
                <div className="text-p1">
                  Some items have suggested matches. Review them before continuing.
                </div>
              </div>
            ) : null}

            <div className="text-ps text-iron mb-2">
              All prices are <strong>ex GST</strong>.
            </div>


            <table className="table-alternate">
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ width: 200 }}>Stock</th>
                  <th style={{ width: 120, textAlign: "right" }}>Price (ex GST)</th>
                  <th style={{ width: 90, textAlign: "right" }}>Qty</th>
                  <th style={{ width: 130, textAlign: "right" }}>Total (ex GST)</th>
                  <th style={{ width: 34 }} />
                </tr>
              </thead>


              <tbody>
                {order.lineItems.map((item: any, i: number) => {
                  const status = item.match?.status;
                  const aiUngrounded = item.rawText === AI_UNGROUNDED_PLACEHOLDER;

                  return (
                    <tr key={i}>
                      <td>
                        {aiUngrounded ? (
                          <>
                            <div className="font-bold mb-1">
                              We couldn’t find any items in the document.
                            </div>
                            <div className="text-ps text-accent mt-2">
                              Please upload a clearer document or add the items manually.
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex" style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <InlineEditableLineItem
                                  orderId={order.id}
                                  index={i}
                                  item={item}
                                  returnTo={returnTo}
                                />
                              </div>

                              {status === "AUTO_MAPPED" ? (
                                <Form
                                  method="post"
                                  action={`/pending-orders/${order.id}/accept-auto`}
                                  style={{ flexShrink: 0 }}
                                >
                                  <input type="hidden" name="index" value={i} />
                                  <input type="hidden" name="returnTo" value={returnTo} />
                                  <button
                                    type="submit"
                                    className="btn btn--primary btn--small"
                                    title="Accept this suggestion"
                                  >
                                    Accept
                                  </button>
                                </Form>
                              ) : null}
                            </div>

                            {status === "UNMAPPED" ? (
                              <div className="text-ps text-accent mt-2" style={{ paddingLeft: 8 }}>
                                Needs a product match. Click the item name to search and choose a product.
                              </div>
                            ) : null}

                          </>
                        )}
                      </td>

                      <td style={{ width: 200 }}>
                        {(() => {
                          const vid = item.match?.variantId;
                          const isMapped =
                            !!vid && (item.match?.status === "MAPPED" || item.match?.status === "AUTO_MAPPED");

                          if (!isMapped) return <div className="text-ps text-iron">Choose a product</div>;

                          const stock = variantStockById?.[vid];
                          const badge = computeStockBadge({
                            orderedQty: Number(item.quantity ?? 0),
                            availableQty: stock?.inventoryQuantity ?? null,
                            restockDate: stock?.restockDate ?? null,
                            productTags: stock?.productTags ?? [],
                          });

                          return (
                            <div className="ex-stock-cell">
                              <div className="ex-card-badge" data-status={badge.status}>
                                <span className="text-p1" style={{ color: "inherit" }}>
                                  {badge.label}
                                </span>
                              </div>

                              {badge.note ? (
                                <div className="ex-stock-note text-p1" data-status={badge.status}>
                                  {badge.note}
                                </div>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>

                      {/* PRICE */}
                      <td style={{ width: 120, textAlign: "right", verticalAlign: "top" }}>
                        {(() => {
                          const vid = item.match?.variantId;
                          const isMapped =
                            !!vid && (item.match?.status === "MAPPED" || item.match?.status === "AUTO_MAPPED");
                          if (!isMapped) return <span className="text-ps text-iron">–</span>;

                          const stock = variantStockById?.[vid];
                          const priceNum = parseMoney(stock?.price);
                          const compareNum = parseMoney(stock?.compareAtPrice);

                          return (
                            <div style={{ display: "grid", justifyItems: "end", gap: 2 }}>
                              <div className="text-p1">{formatMoney(priceNum)}</div>
                              {compareNum != null && priceNum != null && compareNum > priceNum ? (
                                <div className="text-ps text-iron" style={{ textDecoration: "line-through" }}>
                                  {formatMoney(compareNum)}
                                </div>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>

                      {/* QTY */}
                      <td style={{ width: 90, textAlign: "right", verticalAlign: "top" }}>
                        <InlineEditableQty orderId={order.id} index={i} item={item} returnTo={returnTo} />
                      </td>

                      {/* TOTAL */}
                      <td style={{ width: 130, textAlign: "right", verticalAlign: "top" }}>
                        {(() => {
                          const vid = item.match?.variantId;
                          const isMapped =
                            !!vid && (item.match?.status === "MAPPED" || item.match?.status === "AUTO_MAPPED");
                          if (!isMapped) return <span className="text-ps text-iron">–</span>;

                          const stock = variantStockById?.[vid];
                          const priceNum = parseMoney(stock?.price);
                          if (priceNum == null) return <span className="text-ps text-iron">–</span>;

                          const qtyNum = Number(item.quantity ?? 0);
                          const total = priceNum * (Number.isFinite(qtyNum) ? qtyNum : 0);
                          return <span className="text-p1">{formatMoney(total)}</span>;
                        })()}
                      </td>

                      <td style={{ width: 34, textAlign: "right", verticalAlign: "top" }}>
                        {aiUngrounded ? null : (
                          <removeLineFetcher.Form
                            method="post"
                            action={`/pending-orders/${order.id}/remove-line-item`}
                            onSubmit={(e) => {
                              e.preventDefault();
                              setRemoveLinePrompt({ orderId: order.id, index: i });
                            }}
                            style={{ display: "inline-flex" }}
                          >
                            <input type="hidden" name="index" value={i} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <button
                              type="submit"
                              className="icon-btn--close"
                              aria-label="Remove item"
                              title="Remove item"
                            />
                          </removeLineFetcher.Form>
                        )}
                      </td>

                    </tr>
                  );
                })}

                <tr>
                  <td colSpan={6}>
                    <AddLineItemRow orderId={order.id} returnTo={returnTo} />
                  </td>
                </tr>


              </tbody>
            </table>

            {hasUnmapped ? (
              <div className="alert alert--warning mt-4">
                <div className="font-bold mb-1">Can’t continue yet</div>
                <div className="text-p1">
                  One or more items still need a product selected. Match every item before continuing.
                </div>
              </div>
            ) : null}

            {(() => {
              const oneLine = formatDeliveryAddressOneLine((order as any).deliveryAddress);
              const hasAddr = !!oneLine;

              return (
                <div className="mt-4" style={{ display: "grid", gap: 6 }}>
                  {/* Section header */}
                  <div className="font-bold text-p1">Delivery address</div>

                  {/* Address edit button */}
                  <button
                    type="button"
                    className="delivery-edit text-p1"
                    onClick={() =>
                      setEditDelivery({
                        orderId: order.id,
                        deliveryAddress: (order as any).deliveryAddress ?? {},
                      })
                    }
                    title={hasAddr ? oneLine : "Add or update delivery address"}
                  >
                    <span className="delivery-edit__icon" aria-hidden="true" />
                    <span
                      className={`delivery-edit__text ${hasAddr ? "" : "delivery-edit__text--placeholder"
                        }`}
                    >
                      {hasAddr ? oneLine : "Add delivery address (optional)"}
                    </span>
                  </button>

                  {/* Freight notice */}
                  <div className="text-ps text-iron" style={{ paddingLeft: 8 }}>
                    All freight rules and delivery charges are calculated at checkout.
                  </div>
                </div>
              );
            })()}

          </div>
        </div>
      );
    });
  })();



  return (
    <div className="section section--blue-page">
      <div className="container">
        <div className="on-blue">
          <header className="section__header section__header--blue">
            <h1 className="section__title">Orders to review</h1>
            <p className="section__subtitle">
              Check the items and quantities, then continue to checkout.
            </p>

          </header>
        </div>

        <div className="sidebar-layout">
          <aside className="card">
            <div className="card__header">
              <h2 className="card__title">Order lists</h2>
              <div className="text-ps text-iron">
                Choose a list to view.
              </div>
            </div>

            <div className="mb-4">
              <label className="form-label" style={{ marginBottom: 8 }}>
                Search this list
              </label>

              <input
                className="form-input"
                placeholder="PO number, item code, product name…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSearchText("");
                }}
              />

              <div className="text-ps text-iron" style={{ marginTop: 8 }}>
                Showing {filteredOrders.length} of {orders.length} in {orderStatusLabel(activeTab)}.
              </div>
            </div>


            <nav className="sidebar-tabs">
              <Link to="/ingest" className="sidebar-tab">
                <span>Upload order</span>
                <span className="sidebar-tab__count">New</span>
              </Link>

              <Link
                to="/pending-orders?status=READY_FOR_REVIEW"
                className={`sidebar-tab ${activeTab === "READY_FOR_REVIEW" ? "is-active" : ""
                  }`}
              >
                <span>Ready for review</span>
                <span className="sidebar-tab__count">{counts.READY_FOR_REVIEW}</span>
              </Link>

              <Link
                to="/pending-orders?status=APPROVED"
                className={`sidebar-tab ${activeTab === "APPROVED" ? "is-active" : ""}`}
              >
                <span>Approved</span>
                <span className="sidebar-tab__count">{counts.APPROVED}</span>
              </Link>

              <Link
                to="/pending-orders?status=REJECTED"
                className={`sidebar-tab ${activeTab === "REJECTED" ? "is-active" : ""}`}
              >
                <span>Rejected</span>
                <span className="sidebar-tab__count">{counts.REJECTED}</span>
              </Link>
            </nav>
          </aside>

          <main style={{ position: "relative" }}>
            <Outlet />

            {isCheckoutRoute ? null : (
              <div style={{ position: "relative" }}>
                {renderOrders}

                {isPageBusy ? (
                  <div
                    aria-live="polite"
                    aria-busy="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(255,255,255,0.55)",
                      borderRadius: 16,
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "flex-end",
                      padding: 12,
                      pointerEvents: "none",
                    }}
                  >
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 999,
                        background: "rgba(255,255,255,0.9)",
                      }}
                    >
                      <div className="oa-spinner" />
                      <span className="text-ps text-iron">Updating</span>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </main>


        </div>
      </div>
      <ConfirmModal
        open={!!deletePrompt}
        title="Delete this order?"
        message="This will permanently delete the order. This can’t be undone."
        confirmText="Delete order"
        cancelText="Cancel"
        confirmVariant="accent"
        onCancel={() => setDeletePrompt(null)}
        onConfirm={() => {
          const p = deletePrompt;
          if (!p) return;
          setDeletePrompt(null);

          const fd = new FormData();
          fd.set("returnTo", returnTo);

          deleteFetcher.submit(fd, {
            method: "post",
            action: `/pending-orders/${p.orderId}/delete`,
            preventScrollReset: true,
          });
        }}
      />
      <ConfirmModal
        open={!!removeLinePrompt}
        title="Remove this item?"
        message="Remove this item from the order?"
        confirmText="Remove item"
        cancelText="Cancel"
        confirmVariant="accent"
        onCancel={() => setRemoveLinePrompt(null)}
        onConfirm={() => {
          const p = removeLinePrompt;
          if (!p) return;
          setRemoveLinePrompt(null);

          const fd = new FormData();
          fd.set("index", String(p.index));
          fd.set("returnTo", returnTo);

          removeLineFetcher.submit(fd, {
            method: "post",
            action: `/pending-orders/${p.orderId}/remove-line-item`,
            preventScrollReset: true,
          });
        }}
      />

      <ConfirmModal
        open={!!mergeDupesPrompt}
        title="Combine duplicates?"
        message="Combine duplicate items into one line per product and add the quantities together?"
        confirmText="Combine"
        cancelText="Cancel"
        confirmVariant="primary"
        onCancel={() => setMergeDupesPrompt(null)}
        onConfirm={() => {
          const p = mergeDupesPrompt;
          if (!p) return;
          setMergeDupesPrompt(null);

          const fd = new FormData();
          fd.set("intent", "merge_duplicates");
          fd.set("id", p.orderId);
          fd.set("returnTo", returnTo);

          mergeDupesFetcher.submit(fd, {
            method: "post",
            preventScrollReset: true,
          });
        }}
      />

      {approvePrompt ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setApprovePrompt(null);
              setApproveConfirmed(false);
              setApproveSetDefaultAddr(false);
            }
          }}

        >
          <div className="modal-card" style={{ position: "relative", maxWidth: 720 }}>
            <button
              type="button"
              className="icon-btn--close modal-card__close"
              aria-label="Close"
              title="Close"
              onClick={() => {
                setApprovePrompt(null);
                setApproveConfirmed(false);
                setApproveSetDefaultAddr(false);
              }}

            />

            <div className="modal-card__header">
              <h3 className="modal-card__title">Continue to checkout</h3>
              <div className="text-ps text-iron" style={{ marginTop: 6 }}>
                Confirm the items and quantities are correct before continuing.
              </div>
            </div>

            <div className="modal-card__body" style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={approveConfirmed}
                  onChange={(e) => setApproveConfirmed(e.target.checked)}
                />
                <span>
                  <b>I confirm the items and quantities are correct.</b>
                  <div className="text-ps text-iron" style={{ marginTop: 4 }}>
                    After you continue, changes may require manual review.
                  </div>
                </span>
              </label>

              <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={approveSetDefaultAddr}
                  onChange={(e) => setApproveSetDefaultAddr(e.target.checked)}
                />
                <span>
                  <b>Use this delivery address for checkout.</b>
                  <div className="text-ps text-iron" style={{ marginTop: 4 }}>
                    This helps prefill the delivery address in checkout. You can change it at checkout if needed.
                  </div>
                </span>
              </label>
              {(actionData as any)?.error ? (
                <div className="alert alert--warning">
                  {String((actionData as any).error)}
                </div>
              ) : null}

            </div>




            <div className="modal-card__footer">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  setApprovePrompt(null);
                  setApproveConfirmed(false);
                  setApproveSetDefaultAddr(false);
                }}
              >
                Cancel
              </button>

              <Form method="post">
                <input type="hidden" name="intent" value="approve" />
                <input type="hidden" name="id" value={approvePrompt.orderId} />
                <input type="hidden" name="returnTo" value={returnTo} />
                {approveSetDefaultAddr ? (
                  <input type="hidden" name="setDefaultAddress" value="1" />
                ) : null}

                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={!approveConfirmed}
                >
                  Continue to checkout
                </button>
              </Form>

            </div>
          </div>
        </div>
      ) : null}


      {editDelivery ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditDelivery(null);
          }}
        >
          <div className="modal-card" style={{ position: "relative", maxWidth: 720 }}>
            <button
              type="button"
              className="icon-btn--close modal-card__close"
              aria-label="Close"
              title="Close"
              onClick={() => setEditDelivery(null)}
            />

            <div className="modal-card__header">
              <h3 className="modal-card__title">Delivery address</h3>
              <div className="text-ps text-iron" style={{ marginTop: 6 }}>
                Optional. You can still change this at checkout.
              </div>
            </div>

            <div className="modal-card__body">
              <deliveryFetcher.Form
                method="post"
                action={`/pending-orders/${editDelivery.orderId}/update-delivery-address`}
                onSubmit={() => setEditDelivery(null)}
                style={{ display: "grid", gap: 10 }}
              >
                <div className="grid" style={{ gap: 10, gridTemplateColumns: "1fr 1fr" }}>
                  <input
                    className="form-input"
                    name="firstName"
                    placeholder="First name (optional)"
                    defaultValue={editDelivery.deliveryAddress?.firstName ?? ""}
                  />
                  <input
                    className="form-input"
                    name="lastName"
                    placeholder="Last name (optional)"
                    defaultValue={editDelivery.deliveryAddress?.lastName ?? ""}
                  />

                  <input
                    className="form-input"
                    name="company"
                    placeholder="Company"
                    defaultValue={editDelivery.deliveryAddress?.company ?? ""}
                  />
                  <input
                    className="form-input"
                    name="attention"
                    placeholder="Attention (optional)"
                    defaultValue={editDelivery.deliveryAddress?.attention ?? ""}
                  />

                  <input
                    className="form-input"
                    name="line1"
                    placeholder="Address line 1"
                    defaultValue={editDelivery.deliveryAddress?.line1 ?? ""}
                    style={{ gridColumn: "1 / -1" }}
                  />
                  <input
                    className="form-input"
                    name="line2"
                    placeholder="Address line 2"
                    defaultValue={editDelivery.deliveryAddress?.line2 ?? ""}
                    style={{ gridColumn: "1 / -1" }}
                  />

                  <input
                    className="form-input"
                    name="suburb"
                    placeholder="Suburb"
                    defaultValue={editDelivery.deliveryAddress?.suburb ?? ""}
                  />
                  <input
                    className="form-input"
                    name="state"
                    placeholder="State"
                    defaultValue={editDelivery.deliveryAddress?.state ?? ""}
                  />

                  <input
                    className="form-input"
                    name="postcode"
                    placeholder="Postcode"
                    defaultValue={editDelivery.deliveryAddress?.postcode ?? ""}
                  />
                  <input
                    className="form-input"
                    name="country"
                    placeholder="Country"
                    defaultValue={editDelivery.deliveryAddress?.country ?? ""}
                  />

                  <input
                    className="form-input"
                    name="phone"
                    placeholder="Phone"
                    defaultValue={editDelivery.deliveryAddress?.phone ?? ""}
                    style={{ gridColumn: "1 / -1" }}
                  />

                  <input
                    className="form-input"
                    name="instructions"
                    placeholder="Instructions"
                    defaultValue={editDelivery.deliveryAddress?.instructions ?? ""}
                    style={{ gridColumn: "1 / -1" }}
                  />
                </div>

                <div className="modal-card__footer" style={{ justifyContent: "space-between" }}>
                  <button type="submit" className="btn btn--primary">
                    Save address
                  </button>

                  <button
                    type="submit"
                    name="intent"
                    value="clear"
                    className="btn btn-outline"
                  >
                    Clear address
                  </button>
                </div>
              </deliveryFetcher.Form>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
