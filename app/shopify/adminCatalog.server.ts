// app/shopify/adminCatalog.server.ts
function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function adminGraphQL<T>(query: string, variables: any): Promise<T> {
  const shop = env("SHOPIFY_STORE_DOMAIN");
  const token = env("SHOPIFY_ADMIN_TOKEN");

  const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("Admin GraphQL error:", json);
    throw new Error("Admin GraphQL request failed");
  }
  return json.data;
}

export type VariantHit = {
  id: string;
  sku: string | null;
  title: string;
  productTitle: string;
};

export async function searchVariantsByText(text: string): Promise<VariantHit[]> {
  const cleaned = text.trim();
  if (!cleaned) return [];

  // Split on spaces, slashes, backslashes, hyphens.
  const rawTokens = cleaned
    .split(/[\s/\\-]+/g)
    .map((t) => t.trim())
    .filter(Boolean);

  // Keep short numeric tokens like "16". Skip short non-numeric noise.
  const tokens = rawTokens
    .filter((t) => t.length >= 3 || /^\d{1,2}$/.test(t))
    .slice(0, 8);

  // If after filtering we have nothing, fall back to the raw cleaned string.
  const effective = tokens.length ? tokens : [cleaned];

  // AND across tokens. OR across fields within a token.
  const q = effective
    .map((w) => {
      const escaped = w.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `(sku:*${escaped}* OR title:*${escaped}* OR product_title:*${escaped}*)`;
    })
    .join(" AND ");

  const data = await adminGraphQL<any>(
    `
    query VariantSearch($q: String!) {
      productVariants(first: 50, query: $q) {
        edges {
          node {
            id
            sku
            title
            product { title }
          }
        }
      }
    }
    `,
    { q }
  );

  return (data.productVariants.edges as any[]).map((e) => ({
    id: e.node.id,
    sku: e.node.sku ?? null,
    title: e.node.title,
    productTitle: e.node.product.title,
  }));
}

export type VariantStockInfo = {
  id: string;
  inventoryQuantity: number | null;
  productTags: string[];
  restockDate: string | null;

  // pricing
  price: string | null;
  compareAtPrice: string | null;
};


export async function getVariantStockByIds(variantIds: string[]): Promise<Record<string, VariantStockInfo>> {
  const ids = Array.from(new Set(variantIds)).filter(Boolean);
  if (ids.length === 0) return {};

  // If your admin GraphQL helper is named differently, use the same one getVariantById uses.
  // This assumes you have a function that can run Admin GraphQL and return data.
  const query = `
  query VariantStock($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on ProductVariant {
        id
          price
        compareAtPrice
        metafield(namespace: "custom", key: "restock_date") {
          value
        }
        product {
          tags
        }
inventoryItem {
  tracked
  inventoryLevels(first: 50) {
    edges {
      node {
        quantities(names: ["available"]) {
          name
          quantity
        }
      }
    }
  }
}

      }
    }
  }
`;


  type Resp = {
    nodes: Array<
      | null
      | {
        __typename: "ProductVariant";
        id: string;
        price: string | null;
        compareAtPrice: string | null;
        metafield: { value: string | null } | null;
        product: { tags: string[] } | null;
        inventoryItem: {
          tracked: boolean;
          inventoryLevels: {
            edges: Array<{
              node: {
                quantities: Array<{ name: string; quantity: number }>;
              };
            }>;
          };
        } | null;
      }
      | { __typename: string }
    >;
  };


  // IMPORTANT: replace `adminGraphql` with whatever your file uses internally for Admin API calls.
  const data = await adminGraphQL<Resp>(query, { ids });


  const out: Record<string, VariantStockInfo> = {};
  for (const node of data.nodes) {
    if (!node) continue;
    if ((node as any).__typename !== "ProductVariant") continue;

    const v = node as Extract<NonNullable<Resp["nodes"][number]>, { __typename: "ProductVariant" }>;
    const tracked = v.inventoryItem?.tracked ?? false;
    const levels = v.inventoryItem?.inventoryLevels?.edges ?? [];
    const sumAvailable = levels.reduce((acc, e) => {
      const qs = e?.node?.quantities ?? [];
      const available = qs.find((q) => q.name === "available")?.quantity ?? 0;
      return acc + available;
    }, 0);


    // If not tracked, treat as unknown (null). If tracked, use summed available.
    const inventoryQuantity = tracked ? sumAvailable : null;

    out[v.id] = {
      id: v.id,
      inventoryQuantity,
      productTags: v.product?.tags ?? [],
      restockDate: v.metafield?.value ?? null,

      price: v.price ?? null,
      compareAtPrice: v.compareAtPrice ?? null,
    };


  }

  return out;
}



export async function getVariantById(variantId: string): Promise<VariantHit | null> {
  const data = await adminGraphQL<any>(
    `
    query VariantById($id: ID!) {
      node(id: $id) {
        ... on ProductVariant {
          id
          sku
          title
          product { title }
        }
      }
    }
    `,
    { id: variantId }
  );

  const v = data.node;
  if (!v) return null;

  return {
    id: v.id,
    sku: v.sku ?? null,
    title: v.title,
    productTitle: v.product.title,
  };
}
