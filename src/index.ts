import { Hono } from "hono";
import { cors } from "hono/cors";
import { verify } from "hono/jwt";

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

// Self-service refunds: the modal presents a token your app minted for the
// signed-in user. Sent ONLY on POST /deposits/refund, never the other routes,
// so a client still running an older proxy sees no preflight change.
const USER_TOKEN_HEADER = "x-user-token";

// Opt-in. When this is unset the refund route is never registered at all —
// deliberately a registration gate rather than a 401 inside the handler, so a
// deployment that merely bumps the proxy version cannot silently acquire a
// browser-reachable endpoint that spends its API key.
const REFUND_TOKEN_SECRET = process.env.REFUND_TOKEN_SECRET?.trim();

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
  ["post", "/onramp/swapped/widget-url"],
  ["post", "/onramp/swapped/connect-url"],
  ["get", "/onramp/swapped/connect-exchanges"],
  ["get", "/onramp/swapped/status/:smartAccount"],
  // Read-only client config for the modal. Only GET is proxied — POST /setup is
  // an admin write (rotates the webhook secret / sponsorship) and must stay
  // off the browser-facing proxy. The processor never returns the signing
  // secret here (only `hasWebhookSecret`), so this is safe to expose.
  ["get", "/setup"],
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
      USER_TOKEN_HEADER,
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

// --- Self-service refunds (opt-in) ---------------------------------------
//
// Managed deposit accounts are owned by the Rhinestone service, so there is no
// user wallet that can sign for a refund, and for exchange-funded deposits the
// sender cannot sign either. Entitlement is therefore something only YOUR app
// can attest: it authenticated the user and it knows which in-app `recipient`
// belongs to them.
//
// The split of responsibilities:
//   your app   — authenticates the user, mints a short-lived token
//   this proxy — verifies the token, checks the deposit really belongs to that
//                recipient, then spends the API key
//   processor  — atomically claims the deposit out of failed/rejected and pays
//
// Every field of the upstream call comes from the signed token; the request
// body is ignored entirely. The browser presents a credential, it does not get
// to describe the refund.

interface RefundClaims {
  /**
   * The user's in-app recipient — what the deposit is checked against. NOT
   * where the money goes. (The processor's own refund body confusingly calls
   * the destination `recipient`; keep the two straight.)
   */
  recipient: string;
  /** Destination for the refunded funds, on the deposit's source chain. */
  destination: string;
  chain: string;
  txHash: string;
  account: string;
  token: string;
}

const REFUND_CLAIM_FIELDS = [
  "recipient",
  "destination",
  "chain",
  "txHash",
  "account",
  "token",
] as const;

/**
 * Case-insensitive only for 0x-hex (EVM addresses and tx hashes, which the
 * processor lowercases). Solana base58 is case-SENSITIVE, so it must compare
 * exactly or two distinct addresses could be treated as equal.
 */
function sameIdentifier(a: string, b: string): boolean {
  if (a === b) return true;
  const isHex = (v: string) => /^0x[0-9a-fA-F]+$/.test(v);
  return isHex(a) && isHex(b) && a.toLowerCase() === b.toLowerCase();
}

function parseRefundClaims(payload: unknown): RefundClaims | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  // A token with no `exp` never expires, which turns a one-shot authorization
  // into a permanent bearer credential. Require it rather than trusting the
  // minting app to have set one.
  if (typeof record.exp !== "number") return null;
  for (const field of REFUND_CLAIM_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) return null;
  }
  return Object.fromEntries(
    REFUND_CLAIM_FIELDS.map((field) => [field, record[field]]),
  ) as unknown as RefundClaims;
}

if (REFUND_TOKEN_SECRET) {
  app.post("/deposits/refund", async (c) => {
    const userToken = c.req.header(USER_TOKEN_HEADER);
    if (!userToken) {
      return c.json({ error: "Missing user token" }, 401);
    }

    let claims: RefundClaims | null = null;
    try {
      // Algorithm pinned rather than read from the token header, so a token
      // that declares a different `alg` can't talk us into verifying it a
      // weaker way.
      claims = parseRefundClaims(
        await verify(userToken, REFUND_TOKEN_SECRET, "HS256"),
      );
    } catch {
      // Bad signature, malformed token, or past `exp` — hono/jwt throws for all
      // three. Collapsed to one response so a caller can't probe which.
      return c.json({ error: "Invalid user token" }, 401);
    }
    if (!claims) {
      return c.json({ error: "Invalid user token" }, 401);
    }

    const upstreamHeaders: Record<string, string> = {
      ...JSON_HEADERS,
      "x-api-key": API_KEY,
    };

    // Does this deposit actually belong to this user? `recipient` aggregates
    // across every managed account that resolves to it, which matters because
    // the account salt includes the target chain/token — one user legitimately
    // has several accounts. Filtering by txHash too keeps this to a single page
    // regardless of how many deposits they have. `includeSpam=true` is load
    // bearing: it defaults to false, and spam-flagged `rejected` deposits are
    // exactly the ones people need refunded.
    const query = new URLSearchParams({
      recipient: claims.recipient,
      chain: claims.chain,
      txHash: claims.txHash,
      includeSpam: "true",
    });
    const lookup = await fetch(`${BACKEND_URL}/deposits?${query}`, {
      headers: upstreamHeaders,
    });
    if (!lookup.ok) {
      return new Response(await lookup.text(), {
        status: lookup.status,
        headers: JSON_HEADERS,
      });
    }
    // `GET /deposits` returns the smart account as `depositAddress`; a list row
    // has no `account` field at all. The refund body calls the same value
    // `account`, so the names differ across the two calls by design.
    const { deposits = [] } = (await lookup.json()) as {
      deposits?: { depositAddress?: string; token?: string }[];
    };
    const owned = deposits.some(
      (deposit) =>
        deposit.depositAddress !== undefined &&
        deposit.token !== undefined &&
        sameIdentifier(deposit.depositAddress, claims.account) &&
        sameIdentifier(deposit.token, claims.token),
    );
    if (!owned) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // `recipient` here is the processor's name for the DESTINATION. Replay is
    // handled upstream: the refund atomically claims the deposit out of
    // failed/rejected, so a token replayed inside its lifetime finds nothing
    // refundable rather than paying twice.
    const upstream = await fetch(`${BACKEND_URL}/deposits/refund`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify({
        chain: claims.chain,
        txHash: claims.txHash,
        account: claims.account,
        token: claims.token,
        recipient: claims.destination,
      }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return new Response(text, { status: upstream.status, headers: JSON_HEADERS });
    }
    // Report where the funds ACTUALLY went. The destination is whatever your
    // app put in the token, which is not necessarily what the browser asked
    // for — the processor doesn't echo it back, so without this the modal
    // would show the user the address they typed rather than the one paid.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(text, { status: upstream.status, headers: JSON_HEADERS });
    }
    return new Response(
      JSON.stringify({
        ...(parsed as Record<string, unknown>),
        destination: claims.destination,
      }),
      { status: upstream.status, headers: JSON_HEADERS },
    );
  });
}

export default {
  port: Number(process.env.PORT ?? 4000),
  fetch: app.fetch,
};
