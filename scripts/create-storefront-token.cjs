const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function main() {
  if (!SHOP || !ADMIN_TOKEN) throw new Error("Missing env vars");

  const res = await fetch(`https://${SHOP}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({
      query: `
        mutation CreateToken($title: String!) {
          storefrontAccessTokenCreate(input: { title: $title }) {
            storefrontAccessToken { accessToken }
            userErrors { field message }
          }
        }
      `,
      variables: { title: "Order Assist" },
    }),
  });

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
