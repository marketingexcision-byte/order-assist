// app/services/stockStatus.ts
export type StockBadgeStatus =
  | "green"
  | "orange"
  | "red"
  | "yellow"
  | "blue"
  | "mto"
  | "grey";


export type StockBadge = {
  status: StockBadgeStatus;
  label: string;
  note?: string;
};

function normalizeTag(t: string) {
  return t.trim().toLowerCase();
}

function normalizeDateISO(dateISO: string | null | undefined): Date | null {
  if (!dateISO) return null;
  const d = new Date(`${dateISO}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isFutureDateISO(dateISO: string | null | undefined): boolean {
  const d = normalizeDateISO(dateISO);
  if (!d) return false;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() > today.getTime();
}


export function computeStockBadge(args: {
  orderedQty: number;
  availableQty: number | null;
  restockDate: string | null;
  productTags: string[];
}): StockBadge {
  const orderedQty = Number.isFinite(args.orderedQty) ? args.orderedQty : 0;
  const available = args.availableQty;
  const tags = (args.productTags ?? []).map(normalizeTag);
  const effectiveRestockDate = isFutureDateISO(args.restockDate) ? args.restockDate : null;


  if (tags.includes("custom length")) {
    return { status: "mto", label: "Made to order" };
  }

  if (available == null) {
    return { status: "grey", label: "Stock unknown" };
  }

// Shopify can report negative availability when the variant is oversold.
// That negative number represents existing backorders, not something to add onto THIS PO.
// For our PO preview, treat negative availability as 0 and cap backorder at orderedQty.
const safeAvailable = Math.max(0, available);
const backorder = Math.min(orderedQty, Math.max(0, orderedQty - safeAvailable));


  if (backorder <= 0) {
    return { status: "green", label: "In stock" };
  }

if (effectiveRestockDate) {
  return {
    status: "blue",
    label: `Restocking on ${effectiveRestockDate}`,
    note: `Place ${backorder} on backorder`,
  };
}


  if (available > 0) {
    return {
      status: "orange",
      label: "Insufficient stock",
      note: `Place ${backorder} on backorder`,
    };
  }

  return {
    status: "red",
    label: "No stock",
    note: `Place ${backorder} on backorder`,
  };
}
