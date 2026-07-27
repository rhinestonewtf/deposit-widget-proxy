import { Hono } from "hono";
import { cors } from "hono/cors";

const DEFAULT_BACKEND_URL =
  "https://v1.orchestrator.rhinestone.dev/deposit-processor";

const BACKEND_URL = (
  process.env.DEPOSIT_SERVICE_URL ?? DEFAULT_BACKEND_URL
).replace(/\/$/, "");
// The QR/transfer token catalog (GET /tokens) is served statically by
// deposit-widget-backend, NOT by the deposit-processor. It lives at the same
// host under /deposit-widget, so derive it from the processor URL (overridable
// via WIDGET_BACKEND_URL). If the processor URL doesn't match, this no-ops and
// /tokens 404s upstream — the modal falls back to its built-in token set.
const WIDGET_BACKEND_URL = (
  process.env.WIDGET_BACKEND_URL ??
  BACKEND_URL.replace(/\/deposit-processor$/, "/deposit-widget")
).replace(/\/$/, "");
const API_KEY = process.env.RHINESTONE_API_KEY?.trim();
if (!API_KEY) {
  throw new Error("RHINESTONE_API_KEY is not set");
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// The deposit modal stamps its package version on every request. It has to be
// in the CORS allow-list below or the browser preflight rejects it and every
// modal request fails — not just the version reporting.
const MODAL_VERSION_HEADER = "x-deposit-modal-version";

// Each route is [method, path] forwarded to BACKEND_URL, or [method, path,
// upstreamBase] to override the upstream for that route.
const ROUTES = [
  ["post", "/setup-account"],
  ["post", "/register"],
  // Service-managed account registration. The modal calls this instead of
  // /setup-account + /register from v0.9.0 — omitting it 404s registration and
  // the deposit flow is dead, not degraded. The older pair stays for accounts
  // registered by earlier modal versions.
  ["post", "/register-managed"],
  ["get", "/check/:address"],
  ["get", "/portfolio/:address"],
  ["get", "/portfolio/solana/:address"],
  ["get", "/deposits"],
  ["get", "/liquidity"],
  ["get", "/prices"],
  ["post", "/quotes/preview"],
  ["post", "/safe/withdraw"],
  ["post", "/polymarket/withdraw"],
  ["post", "/onramp/swapped/widget-url"],
  ["post", "/onramp/swapped/connect-url"],
  ["get", "/onramp/swapped/connect-exchanges"],
  ["get", "/onramp/swapped/status/:smartAccount"],
  // Read-only client config for the modal. Only GET is proxied — POST /setup is
  // an admin write (rotates the webhook secret / sponsorship) and must stay
  // off the browser-facing proxy. The processor never returns the signing
  // secret here (only `hasWebhookSecret`), so this is safe to expose.
  ["get", "/setup"],
  // Static top-tokens-per-chain list for the QR flow — served by the widget
  // backend, not the processor.
  ["get", "/tokens", WIDGET_BACKEND_URL],
] as const;

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-api-key", MODAL_VERSION_HEADER],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

for (const [method, path, upstreamBase] of ROUTES) {
  app[method](path, async (c) => {
    const { pathname, search } = new URL(c.req.url);
    const base = upstreamBase ?? BACKEND_URL;
    // Forward the browser's Origin/Referer to the processor so it can derive
    // the Swapped submerchant (per-dapp attribution) from the embedding page's
    // domain. Without these, the processor only sees this proxy and the
    // submerchant falls back to "unknown".
    const headers: Record<string, string> = {
      ...JSON_HEADERS,
      "x-api-key": API_KEY,
    };
    const origin = c.req.header("origin");
    if (origin) headers.origin = origin;
    const referer = c.req.header("referer");
    if (referer) headers.referer = referer;
    // Same rationale as origin/referer: relay the modal's version so the
    // processor can report which modal version each client runs. Without it
    // the processor only ever sees this proxy. Passed through unvalidated —
    // the processor shape-checks and length-caps it before use.
    const modalVersion = c.req.header(MODAL_VERSION_HEADER);
    if (modalVersion) headers[MODAL_VERSION_HEADER] = modalVersion;
    const upstream = await fetch(`${base}${pathname}${search}`, {
      method: method.toUpperCase(),
      headers,
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
