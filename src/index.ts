import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  createTrustedProxyCheck,
  type EdgeConfig,
  normalizeTrustedCountryHeader,
  resolveEdgeSignals,
} from "./geoip";

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

// The deposit modal stamps its package version on every request. It has to be
// in the CORS allow-list below or the browser preflight rejects it and every
// modal request fails — not just the version reporting.
const MODAL_VERSION_HEADER = "x-deposit-modal-version";

// --- Regional on-ramp localization (opt-in) --------------------------------
//
// Swapped shows different payment methods per country, and only this proxy can
// see the end user — the processor sits behind it. Set ONE of:
//
//   TRUSTED_COUNTRY_HEADER=cf-ipcountry   your CDN already resolved the country
//                                         (also x-vercel-ip-country,
//                                         cloudfront-viewer-country, …)
//   TRUSTED_PROXY_HOPS=<n>                we name the IP, the processor looks it
//                                         up. 0 = nothing in front of this
//                                         process; n>0 walks x-forwarded-for
//                                         and needs TRUSTED_PROXY_CIDRS.
//
// Leave both unset and nothing is relayed: the modal shows a generic method set.
// Getting TRUSTED_PROXY_HOPS wrong fails closed (no country), never open.
const TRUSTED_COUNTRY_HEADER = normalizeTrustedCountryHeader(
  process.env.TRUSTED_COUNTRY_HEADER,
);
const rawHops = process.env.TRUSTED_PROXY_HOPS?.trim();
// Presence is the gate, so an unset value resolves no IP at all rather than
// quietly defaulting to some topology that may not be yours.
const TRUSTED_PROXY_HOPS = rawHops ? Number(rawHops) : undefined;
if (
  TRUSTED_PROXY_HOPS !== undefined &&
  (!Number.isInteger(TRUSTED_PROXY_HOPS) || TRUSTED_PROXY_HOPS < 0)
) {
  throw new Error("TRUSTED_PROXY_HOPS must be a non-negative integer");
}
const isTrustedProxy = createTrustedProxyCheck(
  process.env.TRUSTED_PROXY_CIDRS,
);
if (TRUSTED_PROXY_HOPS !== undefined && TRUSTED_PROXY_HOPS > 0 && !isTrustedProxy) {
  throw new Error(
    "TRUSTED_PROXY_HOPS > 0 requires TRUSTED_PROXY_CIDRS: without an allowlist any client could forge x-forwarded-for",
  );
}
if (TRUSTED_COUNTRY_HEADER && !isTrustedProxy) {
  throw new Error(
    "TRUSTED_COUNTRY_HEADER requires TRUSTED_PROXY_CIDRS: without an allowlist any client could send that header directly",
  );
}
const EDGE_CONFIG: EdgeConfig = {
  countryHeader: TRUSTED_COUNTRY_HEADER,
  trustedHops: TRUSTED_PROXY_HOPS,
  isTrustedProxy,
};
const LOCALIZATION_ENABLED =
  TRUSTED_COUNTRY_HEADER !== undefined || TRUSTED_PROXY_HOPS !== undefined;

/** The socket peer address, which Bun exposes only via the server handle. */
function directPeerIp(c: Context): string | undefined {
  const server = (
    c.env as
      | {
          server?: { requestIP?: (req: Request) => { address?: string } | null };
        }
      | undefined
  )?.server;
  return server?.requestIP?.(c.req.raw)?.address;
}

// Each route is [method, path], or [method, path, upstreamPath] when the
// processor's path differs from the one the modal calls. Everything goes to
// BACKEND_URL — this proxy has exactly one upstream.
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
  // Regional fiat method list. Localized from the country/IP resolved below —
  // without that it returns the generic set, which is what it did while this
  // route was missing from the proxy entirely.
  ["get", "/onramp/swapped/payment-methods"],
  ["post", "/onramp/swapped/widget-url"],
  ["post", "/onramp/swapped/connect-url"],
  ["get", "/onramp/swapped/connect-exchanges"],
  ["get", "/onramp/swapped/status/:smartAccount"],
  // Read-only client config for the modal. Only GET is proxied — POST /setup is
  // an admin write (rotates the webhook secret / sponsorship) and must stay
  // off the browser-facing proxy. The processor never returns the signing
  // secret here (only `hasWebhookSecret`), so this is safe to expose.
  ["get", "/setup"],
  // DeFi position migration. The holder's EOA owns the aTokens, so `unwind`
  // returns UNSIGNED calldata that only that EOA can execute — the proxy is not
  // handing out an executable action, and every guard that matters (recipient
  // resolved from the registered account, amount capped against Aave's full
  // withdraw validation, deposit policy refused before signature) is upstream.
  // Note `unwind` needs a key with the `deposits:write` scope; a read-scoped key
  // 403s here while /positions keeps working, which reads as a broken unwind
  // rather than a misconfigured key.
  ["get", "/positions/:address"],
  ["post", "/positions/:address/unwind"],
  // Suggested source tokens for the QR / manual-transfer flow, filtered to what
  // this project's deposit whitelist actually accepts.
  ["get", "/qr/tokens"],
  // Legacy alias: the modal called this `/tokens` before 0.9.x, and clients
  // self-host this proxy, so an older modal can well be pointed at a newer
  // deployment. Same response shape, so it maps straight onto /qr/tokens.
  // Remove once no released modal calls /tokens.
  ["get", "/tokens", "/qr/tokens"],
] as const;

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "x-api-key",
      MODAL_VERSION_HEADER,
    ],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

for (const [method, path, upstreamPath] of ROUTES) {
  app[method](path, async (c) => {
    const { pathname, search } = new URL(c.req.url);
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
    // Regional on-ramp localization. Note these are SET here and never copied
    // from the request: `headers` is built fresh, so a browser-supplied
    // x-user-country / x-client-ip is dropped no matter what it sends. They are
    // also absent from the CORS allow-list, so a browser can't even send them.
    if (LOCALIZATION_ENABLED) {
      const { country, clientIp } = resolveEdgeSignals(
        { header: (name) => c.req.header(name), directIp: directPeerIp(c) },
        EDGE_CONFIG,
      );
      if (country) headers["x-user-country"] = country;
      else if (clientIp) headers["x-client-ip"] = clientIp;
    }
    const upstream = await fetch(
      `${BACKEND_URL}${upstreamPath ?? pathname}${search}`,
      {
        method: method.toUpperCase(),
        headers,
        body: method === "post" ? await c.req.text() : undefined,
      },
    );
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: JSON_HEADERS,
    });
  });
}

export default {
  port: Number(process.env.PORT ?? 4000),
  // `server` is threaded into the Hono env because it is the only way to reach
  // the socket peer address (`server.requestIP`), which the client-IP resolution
  // needs. Without it every request looks like it came from nowhere.
  fetch(request: Request, server?: unknown): Response | Promise<Response> {
    return app.fetch(request, { server });
  },
};
