import "dotenv/config";
import { buildApp } from "./app";
import { closePrismaClient } from "./db/client";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer from 1 to 65535.");
}

const defaultDevKey = process.env.NODE_ENV !== "production"
  ? "restaurant-os-dev-loopback-key-2026-min-32-bytes"
  : undefined;
const onboardingKey = process.env.ONBOARDING_API_KEY || defaultDevKey;

const app = await buildApp({ logger: true, onboardingKey });

try {
  await app.listen({ port, host });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Shutting down gracefully");
    try {
      await app.close();
      await closePrismaClient();
    } catch (error) {
      app.log.error(error, "Graceful shutdown failed");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
