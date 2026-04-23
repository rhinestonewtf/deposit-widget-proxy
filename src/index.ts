import { Hono } from "hono";
import { cors } from "hono/cors";

const DEFAULT_BACKEND_URL =
  "https://v1.orchestrator.rhinestone.dev/deposit-processor";

const BACKEND_URL = (
  process.env.DEPOSIT_SERVICE_URL ?? DEFAULT_BACKEND_URL
).replace(/\/$/, "");
const API_KEY = process.env.RHINESTONE_API_KEY?.trim();
if (!API_KEY) {
  throw new Error("RHINESTONE_API_KEY is not set");
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const ROUTES = [
  ["post", "/setup-account"],
  ["post", "/register"],
  ["get", "/check/:address"],
  ["get", "/portfolio/:address"],
  ["get", "/portfolio/solana/:address"],
  ["get", "/deposits"],
  ["get", "/liquidity"],
  ["post", "/safe/withdraw"],
] as const;

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-api-key"],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

for (const [method, path] of ROUTES) {
  app[method](path, async (c) => {
    const { pathname, search } = new URL(c.req.url);
    const upstream = await fetch(`${BACKEND_URL}${pathname}${search}`, {
      method: method.toUpperCase(),
      headers: { ...JSON_HEADERS, "x-api-key": API_KEY },
      body: method === "post" ? await c.req.text() : undefined,
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: JSON_HEADERS,
    });
  });
}

export default {
  port: Number(process.env.PORT ?? 4000),
  fetch: app.fetch,
};
