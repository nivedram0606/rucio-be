import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { ALL_KEYS } from "./seed-permissions";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to seed the permission catalog.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main() {
  await prisma.$transaction(
    ALL_KEYS.map((permissionKey) => {
      const [module, action] = permissionKey.split(".");
      return prisma.permission.upsert({
        where: { permissionKey },
        update: { module, action },
        create: { permissionKey, module, action },
      });
    }),
  );

  console.log(`Synchronized ${ALL_KEYS.length} permission keys.`);
}

main()
  .catch((error: unknown) => {
    console.error("Permission seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
