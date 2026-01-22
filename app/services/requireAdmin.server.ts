import { authenticate } from "../shopify.server";

export async function requireAdmin(request: Request) {
  await authenticate.admin(request);
}
