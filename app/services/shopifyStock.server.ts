// app/services/shopifyStock.server.ts
type ShopifyVariantStock = {
  variantId: string;
  quantityAvailable: number | null; // null means unknown/unavailable
  restockDate: string | null; // raw metafield value
  productTags: string[];
};

function getRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const SHOPIFY_STOREFRONT_URL = () => getRequiredEnv("SHOPIFY_STOREFRONT_URL");
const SHOPIFY_STOREFRONT_TOKEN = () => getRequiredEnv("SHOPIFY_STOREFRONT_TOKEN");

async function storefrontFetch<T>(query: string, variables: Record<string, any>): Promise<T> {
  const res = await fetch(SHOPIFY_STOREFRONT_URL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN(),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify Storefront error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data as T;
}

const VARIANT_STOCK_QUERY = `
  query VariantStock($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on ProductVariant {
        id
        quantityAvailable
        metafield(namespace: "custom", key: "restock_date") {
          value
        }
        product {
          tags
        }
      }
    }
  }
`;

export async function getVariantStockByIds(variantIds: string[]): Promise<Record<string, ShopifyVariantStock>> {
  const ids = Array.from(new Set(variantIds)).filter(Boolean);
  if (ids.length === 0) return {};

  type Resp = {
    nodes: Array<
      | null
      | {
          __typename: "ProductVariant";
          id: string;
          quantityAvailable: number | null;
          metafield: { value: string | null } | null;
          product: { tags: string[] } | null;
        }
      | { __typename: string }
    >;
  };

  const data = await storefrontFetch<Resp>(VARIANT_STOCK_QUERY, { ids });

  const out: Record<string, ShopifyVariantStock> = {};
  for (const node of data.nodes) {
    if (!node) continue;
    if ((node as any).__typename !== "ProductVariant") continue;

    const v = node as Extract<NonNullable<Resp["nodes"][number]>, { __typename: "ProductVariant" }>;
    out[v.id] = {
      variantId: v.id,
      quantityAvailable: typeof v.quantityAvailable === "number" ? v.quantityAvailable : null,
      restockDate: v.metafield?.value ?? null,
      productTags: v.product?.tags ?? [],
    };
  }

  return out;
}
