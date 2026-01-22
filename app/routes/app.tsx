import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import * as React from "react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

// Local UI dev toggle.
// Use env var: LOCAL_UI_DEV=1
// Or query param: ?local-ui=1
function isLocalUiDev(request: Request) {
  const url = new URL(request.url);
  return process.env.LOCAL_UI_DEV === "1" || url.searchParams.get("local-ui") === "1";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (isLocalUiDev(request)) {
    // Bypass Shopify auth + embedded context for local UI work
    return json({ apiKey: "dev", localUiDev: true });
  }

  await authenticate.admin(request);
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "", localUiDev: false });
};

export default function App() {
  const data = useLoaderData<typeof loader>();

  // Local UI dev mode. No Shopify imports, no App Bridge, no Polaris JSON import.
  if (data.localUiDev) {
    return <Outlet />;
  }

  // Non-local mode. We dynamically import Shopify AppProvider so dev bundler
  // does not parse its JSON import attributes when LOCAL_UI_DEV=1.
  return <EmbeddedApp apiKey={data.apiKey} />;
}

function EmbeddedApp({ apiKey }: { apiKey: string }) {
  const [ShopifyAppProvider, setShopifyAppProvider] =
    React.useState<null | React.ComponentType<any>>(null);

  React.useEffect(() => {
    let cancelled = false;

    import("@shopify/shopify-app-remix/react").then((mod) => {
      if (cancelled) return;
      setShopifyAppProvider(() => mod.AppProvider);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ShopifyAppProvider) return null;

  return (
    <ShopifyAppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Home
        </Link>
        <Link to="/app/additional">Additional page</Link>
      </NavMenu>
      <Outlet />
    </ShopifyAppProvider>
  );
}


// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
