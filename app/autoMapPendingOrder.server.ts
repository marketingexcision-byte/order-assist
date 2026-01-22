import { searchVariantsByText } from "./shopify/adminCatalog.server";
import { prisma } from "./db.server";

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

function isSkuLike(text: string) {
  const cleaned = text.trim();
  return /^[A-Za-z0-9_-]{3,}$/.test(cleaned) && !/\s/.test(cleaned);
}

export async function autoMapPendingOrderLineItems(orderId: string) {
  const order = await prisma.pendingOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error(`PendingOrder not found: ${orderId}`);

  const items = order.lineItems as unknown as LineItem[];

  const updated: LineItem[] = await Promise.all(
    items.map(async (li) => {
      const rawText = String(li.rawText ?? "").trim();
      if (!rawText) return li;

      // Never clobber a human selection.
      if (li.match?.status === "MAPPED" && li.match?.variantId) return li;

      // Default. If we cannot confidently auto-select, do nothing.
      // Also clears any historical junk that may already be stored.
      const base: LineItem = { ...li, match: { status: "UNMAPPED", confidence: 0 } };

      // Only auto-select on SKU-like input.
      if (!isSkuLike(rawText)) return base;

      const hits = await searchVariantsByText(rawText);

      // Exact SKU match only. Case-insensitive, trimmed.
      const exact = hits.filter(
        (h) => String(h.sku ?? "").trim().toUpperCase() === rawText.toUpperCase()
      );

      if (exact.length !== 1) return base;

      const v = exact[0];
      const niceTitle = `${v.productTitle} · ${v.title}${v.sku ? ` (SKU: ${v.sku})` : ""}`;

      return {
        ...li,
        match: {
          status: "AUTO_MAPPED",
          confidence: 1,
          variantId: v.id,
          sku: v.sku ?? undefined,
          displayTitle: niceTitle,
        },
      };
    })
  );

  await prisma.pendingOrder.update({
    where: { id: orderId },
    data: { lineItems: updated },
  });

  return { orderId, updatedCount: updated.length };
}
