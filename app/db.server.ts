import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set at runtime");
}
console.log("RUNTIME DATABASE_URL prefix:", process.env.DATABASE_URL.slice(0, 20));

if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  if (!global.__prisma) global.__prisma = new PrismaClient();
  prisma = global.__prisma;
}

export { prisma };
export default prisma;
