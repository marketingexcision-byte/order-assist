// scripts/seed-pending-order.cjs
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const created = await prisma.pendingOrder.create({
    data: {
      status: "READY_FOR_REVIEW",
      lineItems: [
        { rawText: "0500014", quantity: 2, match: { status: "UNMAPPED" } },
        { rawText: "0500016", quantity: 1, match: { status: "UNMAPPED" } },
      ],
    },
  });

  console.log("seeded", created.id);
}


main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
