import { afterAll, beforeAll, describe, expect, it } from "bun:test";

let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.spawn>;
let base: string;
const calls: { url: string; headers: Headers; body: string }[] = [];
beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const snapshot = {
        url: request.url,
        headers: new Headers(request.headers),
        body: await request.text(),
      };
      calls.push(snapshot);
      return Response.json(
        { ok: true },
        {
          status: Number(
            new URL(snapshot.url).searchParams.get("status") ?? 200,
          ),
        },
      );
    },
  });
  const port = Bun.serve({ port: 0, fetch: () => new Response() });
  const number = port.port;
  port.stop(true);
  base = `http://localhost:${number}`;
  proxy = Bun.spawn(["bun", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(number),
      RHINESTONE_API_KEY: "server-key",
      DEPOSIT_SERVICE_URL: `http://localhost:${upstream.port}`,
      TRUSTED_COUNTRY_HEADER: "",
      TRUSTED_PROXY_HOPS: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error("Proxy failed to start");
});
afterAll(() => {
  proxy?.kill();
  upstream?.stop(true);
});

describe("customer route boundary", () => {
  it.each([
    "/onramp/noah/setup",
    "/offramp/noah/sessions",
    // Starting hosted verification is likewise a POST and likewise distinct
    // from the GET on /compliance/status: status reads the outcome, this one
    // creates the session that produces it.
    "/compliance/verification",
  ])(
    "preserves POST body without application credentials on %s",
    async (path) => {
      const body = JSON.stringify({ currency: "EUR" });
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer browser-token",
          "content-type": "application/json",
          "x-api-key": "attacker",
        },
        body,
      });
      expect(response.status).toBe(200);
      expect(calls.at(-1)?.body).toBe(body);
      expect(calls.at(-1)?.headers.get("authorization")).toBe(
        "Bearer browser-token",
      );
      expect(calls.at(-1)?.headers.get("x-api-key")).toBeNull();
    },
  );
  it("preserves processor rejection and prevents caching errors", async () => {
    const response = await fetch(`${base}/onramp/noah/payments?status=403`, {
      headers: { authorization: "Bearer browser-token" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    "/compliance/status",
    "/onramp/noah/options",
    "/onramp/noah/payments",
    "/onramp/noah/payments/id",
    "/onramp/noah/accounts",
    "/onramp/noah/accounts/id",
    "/onramp/noah/accounts/id/details",
    "/onramp/noah/setup/id",
    "/offramp/noah/options",
    "/offramp/noah/payments",
    "/offramp/noah/payments/id",
    "/offramp/noah/sessions/id",
  ])("forwards only browser credentials on %s", async (path) => {
    const response = await fetch(`${base}${path}?limit=10`, {
      headers: {
        authorization: "Bearer browser-token",
        "x-api-key": "attacker",
        origin: "https://app.test",
        "x-deposit-modal-version": "1.0.0",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const request = calls.at(-1)!;
    expect(request.headers.get("authorization")).toBe("Bearer browser-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("origin")).toBe("https://app.test");
    expect(request.headers.get("x-deposit-modal-version")).toBe("1.0.0");
    expect(new URL(request.url).search).toBe("?limit=10");
  });
  it("rejects missing bearer without reaching upstream", async () => {
    const count = calls.length;
    const response = await fetch(`${base}/onramp/noah/payments`);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls.length).toBe(count);
  });
  it.each([
    // Stays denied for a different reason than the rest: it is authenticated by
    // the PROJECT API KEY, not a customer bearer, so forwarding it would let any
    // browser mint a session for any smart account using our injected key.
    // `/compliance/verification` sits on the customer bearer and is allowed.
    "/compliance/sessions",
    "/compliance/verification/sessions",
    "/compliance/support/sessions",
    "/compliance/recovery/sessions",
    "/onramp/recovery",
    // The unqualified prefix is nobody's surface now (RHI-7284).
    "/onramp/sessions",
    "/onramp/accounts",
    "/admin/flags",
  ])("does not expose %s", async (path) => {
    const count = calls.length;
    expect(
      (
        await fetch(`${base}${path}`, {
          method: "POST",
          headers: { authorization: "Bearer browser-token" },
        })
      ).status,
    ).toBe(404);
    expect(calls.length).toBe(count);
  });
  it("does not expose a preliminary capability endpoint", async () => {
    const count = calls.length;
    const response = await fetch(`${base}/compliance/access?currency=EUR`, {
      headers: { authorization: "Bearer browser-token" },
    });
    expect(response.status).toBe(404);
    expect(calls.length).toBe(count);
  });
  it("allows browser Authorization preflight", async () => {
    const response = await fetch(`${base}/onramp/noah/setup`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(
      response.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("authorization");
  });
});
