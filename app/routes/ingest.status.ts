import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { prisma } from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const to = url.searchParams.get("to")?.trim().toLowerCase() || null;

  // "Early confidence": show any job created/started very recently
  const since = new Date(Date.now() - 60_000);

  const running = await prisma.ingestJob.findFirst({
    where: {
      status: "RUNNING",
      OR: [{ createdAt: { gte: since } }, { startedAt: { gte: since } }],
      ...(to ? { to } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      source: true,
      createdAt: true,
      startedAt: true,
      requestId: true,
      to: true,
    },
  });

  return json({
    incoming: !!running,
    job: running ?? null,
  });
}
