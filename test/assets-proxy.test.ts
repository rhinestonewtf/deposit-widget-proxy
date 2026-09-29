import { afterAll, beforeAll, describe, expect, it } from "bun:test";

type Call = {
  method: string;
  pathname: string;
  search: string;
  headers: Headers;
  body: string;
};

let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.spawn>;
let base: string;
const calls: Call[] = [];

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        headers: new Headers(request.headers),
        body: await request.text(),
      });
      const status = Number(url.searchParams.get("status") ?? 200);
      const body =
        status === 200
          ? { data: { "eip155:1:native": { symbol: "ETH" } } }
          : { error: { code: "invalid_request", message: "bad" } };
      return Response.json(body, { status });
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
      TRUSTED_PROXY_CIDRS: "",
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

describe("/assets", () => {
  it("forwards GET with the query string verbatim and the server key", async () => {
    const search =
      "?ids=eip155:1:native&ids=eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&fields=symbol,price";
    const response = await fetch(`${base}/assets${search}`, {
      headers: { "x-api-key": "browser-key" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { "eip155:1:native": { symbol: "ETH" } },
    });
    const call = calls.at(-1)!;
    expect(call.method).toBe("GET");
    expect(call.pathname).toBe("/assets");
    expect(call.search).toBe(search);
    expect(call.headers.get("x-api-key")).toBe("server-key");
    expect(call.body).toBe("");
  });

  it("forwards QUERY as QUERY with the body unchanged", async () => {
    const body = JSON.stringify({
      ids: ["eip155:1:native"],
      fields: ["price"],
    });
    const response = await fetch(`${base}/assets`, {
      method: "QUERY",
      headers: {
        "content-type": "application/json",
        "x-api-key": "browser-key",
      },
      body,
    });
    expect(response.status).toBe(200);
    const call = calls.at(-1)!;
    // Bun's fetch downgrades methods it doesn't recognise to GET.
    expect(call.method).toBe("QUERY");
    expect(call.pathname).toBe("/assets");
    expect(call.body).toBe(body);
    expect(call.headers.get("x-api-key")).toBe("server-key");
    expect(call.headers.get("content-type")).toBe("application/json");
  });

  it.each([400, 403, 502])(
    "passes upstream %i status and body through",
    async (status) => {
      for (const method of ["GET", "QUERY"]) {
        const response = await fetch(`${base}/assets?status=${status}`, {
          method,
          body: method === "QUERY" ? "{}" : undefined,
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({
          error: { code: "invalid_request", message: "bad" },
        });
        expect(calls.at(-1)?.method).toBe(method);
      }
    },
  );

  it("allows QUERY at preflight with the modal's headers", async () => {
    const response = await fetch(`${base}/assets`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "QUERY",
        "access-control-request-headers": "content-type,x-deposit-modal-version",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "QUERY",
    );
    expect(
      response.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("x-deposit-modal-version");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "does not forward %s",
    async (method) => {
      const count = calls.length;
      const response = await fetch(`${base}/assets`, { method, body: "{}" });
      expect(response.status).toBe(404);
      expect(calls.length).toBe(count);
    },
  );
});
