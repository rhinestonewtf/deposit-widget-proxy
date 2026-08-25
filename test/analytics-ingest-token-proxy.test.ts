import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const UPSTREAM_PORT = 4614;
const PROXY_PORT = 4615;

interface UpstreamCall {
  method: string;
  pathname: string;
  apiKey: string | null;
  body: string;
}

const TOKEN = {
  token: "analytics-token",
  expiresAt: "2026-08-25T16:00:00.000Z",
};

let calls: UpstreamCall[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.spawn>;

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
      const body = await req.text();
      calls.push({
        method: req.method,
        pathname: url.pathname,
        apiKey: req.headers.get("x-api-key"),
        body,
      });
      if (url.pathname !== "/analytics/ingest-token" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (JSON.parse(body).reject) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return Response.json(TOKEN);
    },
  });

  proxy = Bun.spawn(["bun", "src/index.ts"], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    env: {
      ...process.env,
      RHINESTONE_API_KEY: "configured-key",
      DEPOSIT_SERVICE_URL: `http://localhost:${UPSTREAM_PORT}`,
      PORT: String(PROXY_PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(PROXY_PORT);
});

afterAll(() => {
  proxy?.kill();
  upstream?.stop(true);
});

function mint(body: unknown, headers?: Record<string, string>) {
  return fetch(`http://localhost:${PROXY_PORT}/analytics/ingest-token`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("analytics ingest token", () => {
  test("forwards the exact POST route with the configured API key", async () => {
    calls = [];
    const body = { sessionId: "session-id" };

    const res = await mint(body, {
      "x-api-key": "browser-key",
      "x-deposit-modal-version": "1.0.0",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TOKEN);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([
      {
        method: "POST",
        pathname: "/analytics/ingest-token",
        apiKey: "configured-key",
        body: JSON.stringify(body),
      },
    ]);
  });

  test("preserves upstream authentication failures without a token", async () => {
    calls = [];

    const res = await mint({ reject: true });
    const payload = await res.json();

    expect(res.status).toBe(401);
    expect(payload).toEqual({ error: "Unauthorized" });
    expect(payload).not.toHaveProperty("token");
    expect(res.headers.get("cache-control")).toBeNull();
    expect(calls[0]?.apiKey).toBe("configured-key");
  });

  test("does not expose a GET route", async () => {
    calls = [];

    const res = await fetch(
      `http://localhost:${PROXY_PORT}/analytics/ingest-token`,
    );

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("clears preflight with the existing modal headers", async () => {
    calls = [];

    const res = await fetch(
      `http://localhost:${PROXY_PORT}/analytics/ingest-token`,
      {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "content-type,x-deposit-modal-version",
        },
      },
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "x-deposit-modal-version",
    );
    expect(calls).toHaveLength(0);
  });
});
