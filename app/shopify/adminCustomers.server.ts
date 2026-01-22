// app/shopify/adminCustomers.server.ts
function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function adminGraphQL<T>(query: string, variables: any): Promise<T> {
  const shop = env("SHOPIFY_STORE_DOMAIN");
  const token = env("SHOPIFY_ADMIN_TOKEN");

  const res = await fetch(`https://${shop}/admin/api/2025-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("[adminGraphQL] error", json);
    throw new Error("Shopify Admin GraphQL error");
  }
  return json.data;
}

export type DeliveryAddress = {
  email?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  country?: string;
};

export async function findCustomerIdByEmail(email: string): Promise<string | null> {
  const q = /* GraphQL */ `
    query FindCustomer($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node { id }
        }
      }
    }
  `;
  const data = await adminGraphQL<any>(q, { query: `email:${JSON.stringify(email)}` });
  const id = data?.customers?.edges?.[0]?.node?.id ?? null;
  return id;
}

export async function getCustomerDefaultAddressId(customerId: string): Promise<string | null> {
  const q = /* GraphQL */ `
    query CustomerDefault($id: ID!) {
      customer(id: $id) {
        defaultAddress { id }
      }
    }
  `;
  const data = await adminGraphQL<any>(q, { id: customerId });
  return data?.customer?.defaultAddress?.id ?? null;
}

export async function createCustomerAddress(customerId: string, delivery: DeliveryAddress): Promise<string> {
  const m = /* GraphQL */ `
    mutation CreateAddr($customerId: ID!, $address: MailingAddressInput!) {
      customerAddressCreate(customerId: $customerId, address: $address) {
        customerAddress { id }
        userErrors { field message }
      }
    }
  `;

  const address: any = {
    firstName: delivery.firstName ?? undefined,
    lastName: delivery.lastName ?? undefined,
    company: delivery.company ?? undefined,
    phone: delivery.phone ?? undefined,
    address1: delivery.line1 ?? undefined,
    address2: delivery.line2 ?? undefined,
    city: delivery.suburb ?? undefined,
    province: delivery.state ?? undefined,
    zip: delivery.postcode ?? undefined,
    country: delivery.country ?? "Australia",
  };

  const data = await adminGraphQL<any>(m, { customerId, address });
  const errs = data?.customerAddressCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "));

  const id = data?.customerAddressCreate?.customerAddress?.id;
  if (!id) throw new Error("Missing customerAddress id from customerAddressCreate");
  return id;
}

export async function setCustomerDefaultAddress(customerId: string, addressId: string): Promise<void> {
  const m = /* GraphQL */ `
    mutation SetDefault($customerId: ID!, $addressId: ID!) {
      customerUpdateDefaultAddress(customerId: $customerId, addressId: $addressId) {
        userErrors { field message }
      }
    }
  `;
  const data = await adminGraphQL<any>(m, { customerId, addressId });
  const errs = data?.customerUpdateDefaultAddress?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "));
}

export async function deleteCustomerAddress(addressId: string): Promise<void> {
  const m = /* GraphQL */ `
    mutation Del($addressId: ID!) {
      customerAddressDelete(addressId: $addressId) {
        deletedCustomerAddressId
        userErrors { field message }
      }
    }
  `;
  const data = await adminGraphQL<any>(m, { addressId });
  const errs = data?.customerAddressDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "));
}
