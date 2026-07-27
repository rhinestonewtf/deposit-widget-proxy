/**
 * Integration tests for the opt-in POST /deposits/refund route.
 *
 * The proxy reads its config from the environment at module load, so these run
 * it as a subprocess against a stub processor rather than importing the app —
 * which also means CORS and the opt-in gate are exercised for real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";

const SECRET = "test-secret";
const UPSTREAM_PORT = 4599;
const PROXY_PORT = 4600;
const PROXY_NO_SECRET_PORT = 4601;

// Addresses are deliberately checksummed here and lowercased in the stub's
// responses — the processor lowercases EVM addresses, so the ownership check
// has to match across casing.
const OWNED = {
  recipient: "0x1111111111111111111111111111111111111111",
  destination: "0x2222222222222222222222222222222222222222",
  chain: "eip155:8453",
  txHash: `0x${"ab".repeat(32)}`,
  account: "0xDE0FDF9C06B404CC5E20543CB84CAC9067102F19",
  token: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
};

let refundCalls: Record<string, string>[] = [];
let lookupQueries: string[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.spawn>;
let proxyNoSecret: ReturnType<typeof Bun.spawn>;

const now = () => Math.floor(Date.now() / 1000);
const token = (claims: Record<string, unknown>, secret = SECRET) =>
  sign({ exp: now() + 60, ...claims }, secret, "HS256");

/**
 * Posts a body that asks for a completely different refund than the token
 * authorizes. Every assertion below relies on it being ignored.
 */
function post(port: number, userToken?: string) {
  return fetch(`http://localhost:${port}/deposits/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userToken ? { "x-user-token": userToken } : {}),
    },
    body: JSON.stringify({
      chain: "eip155:1",
      txHash: `0x${"99".repeat(32)}`,
      account: "0xattacker",
      token: "0xattacker",
      recipient: "0xattacker",
    }),
  });
}

function spawnProxy(port: number, withSecret: boolean) {
  return Bun.spawn(["bun", "src/index.ts"], {
    cwd: import.meta.dir.replace(/\/src$/, ""),
    env: {
      ...process.env,
      RHINESTONE_API_KEY: "test-key",
      DEPOSIT_SERVICE_URL: `http://localhost:${UPSTREAM_PORT}`,
      PORT: String(port),
      ...(withSecret ? { REFUND_TOKEN_SECRET: SECRET } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForHealth(port: number) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`proxy on ${port} never became healthy`);
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/deposits" && req.method === "GET") {
        lookupQueries.push(url.search);
        const deposits =
          url.searchParams.get("recipient") === OWNED.recipient
            ? [
                {
                  depositAddress: OWNED.account.toLowerCase(),
                  token: OWNED.token.toLowerCase(),
                  status: "failed",
                },
              ]
            : [];
        return Response.json({ deposits });
      }
      if (url.pathname === "/deposits/refund" && req.method === "POST") {
        refundCalls.push((await req.json()) as Record<string, string>);
        return Response.json({
          message: "ok",
          transactionHash: "0xfeed",
          amount: "1000",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  proxy = spawnProxy(PROXY_PORT, true);
  proxyNoSecret = spawnProxy(PROXY_NO_SECRET_PORT, false);
  await waitForHealth(PROXY_PORT);
  await waitForHealth(PROXY_NO_SECRET_PORT);
});

afterAll(() => {
  proxy?.kill();
  proxyNoSecret?.kill();
  upstream?.stop();
});

describe("opt-in gate", () => {
  test("the route does not exist without REFUND_TOKEN_SECRET", async () => {
    // A deployment that merely bumps the proxy version must not acquire a
    // browser-reachable endpoint that spends its API key.
    const res = await post(PROXY_NO_SECRET_PORT, await token(OWNED));
    expect(res.status).toBe(404);
  });
});

describe("token verification", () => {
  test.each([
    ["no token at all", undefined],
    ["a malformed token", "not.a.jwt"],
  ])("rejects %s with 401", async (_label, value) => {
    expect((await post(PROXY_PORT, value as string | undefined)).status).toBe(
      401,
    );
  });

  test("rejects a token signed with the wrong secret", async () => {
    const res = await post(PROXY_PORT, await token(OWNED, "other-secret"));
    expect(res.status).toBe(401);
  });

  test("rejects an expired token", async () => {
    const res = await post(PROXY_PORT, await token({ ...OWNED, exp: now() - 5 }));
    expect(res.status).toBe(401);
  });

  test("rejects a token with no exp, which would never expire", async () => {
    const res = await post(
      PROXY_PORT,
      await sign({ ...OWNED }, SECRET, "HS256"),
    );
    expect(res.status).toBe(401);
  });

  test("rejects a token missing a required claim", async () => {
    const { destination: _omitted, ...withoutDestination } = OWNED;
    const res = await post(PROXY_PORT, await token(withoutDestination));
    expect(res.status).toBe(401);
  });
});

describe("ownership", () => {
  test("403s when the deposit belongs to a different recipient", async () => {
    refundCalls = [];
    const res = await post(
      PROXY_PORT,
      await token({
        ...OWNED,
        recipient: "0x9999999999999999999999999999999999999999",
      }),
    );
    expect(res.status).toBe(403);
    expect(refundCalls).toHaveLength(0);
  });

  test("403s when the recipient is right but the account is not theirs", async () => {
    refundCalls = [];
    const res = await post(
      PROXY_PORT,
      await token({ ...OWNED, account: "0xdeadbeef" }),
    );
    expect(res.status).toBe(403);
    expect(refundCalls).toHaveLength(0);
  });
});

describe("happy path", () => {
  test("forwards exactly one refund built from the token, ignoring the body", async () => {
    refundCalls = [];
    lookupQueries = [];

    const res = await post(PROXY_PORT, await token(OWNED));

    expect(res.status).toBe(200);
    expect(refundCalls).toHaveLength(1);
    // `recipient` upstream is the processor's name for the DESTINATION. None of
    // the attacker-supplied body fields appear anywhere.
    expect(refundCalls[0]).toEqual({
      chain: OWNED.chain,
      txHash: OWNED.txHash,
      account: OWNED.account,
      token: OWNED.token,
      recipient: OWNED.destination,
    });
  });

  test("scopes the ownership lookup and includes spam-flagged rows", async () => {
    refundCalls = [];
    lookupQueries = [];
    await post(PROXY_PORT, await token(OWNED));

    expect(lookupQueries).toHaveLength(1);
    const query = new URLSearchParams(lookupQueries[0]);
    expect(query.get("recipient")).toBe(OWNED.recipient);
    expect(query.get("chain")).toBe(OWNED.chain);
    expect(query.get("txHash")).toBe(OWNED.txHash);
    // Defaults to false upstream, and spam-flagged `rejected` deposits are
    // exactly the ones users need refunded.
    expect(query.get("includeSpam")).toBe("true");
  });
});

describe("CORS", () => {
  test("preflight allows x-user-token", async () => {
    // Missing from allowHeaders, the browser blocks the whole request.
    const res = await fetch(`http://localhost:${PROXY_PORT}/deposits/refund`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-user-token",
      },
    });
    expect(
      (res.headers.get("access-control-allow-headers") ?? "").toLowerCase(),
    ).toContain("x-user-token");
  });
});
