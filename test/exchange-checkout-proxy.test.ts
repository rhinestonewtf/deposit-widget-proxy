import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";

process.env.DEPOSIT_SERVICE_URL = "https://processor.test";
process.env.RHINESTONE_API_KEY = "proxy-key";

type ProxyHandler = (request: Request) => Response | Promise<Response>;
type ProcessorCall = { url: string; init: RequestInit };

let handler: ProxyHandler;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const server = (await import("../src/index")).default;
  handler = (request) => server.fetch(request);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureProcessor(payload: unknown, status = 200): ProcessorCall[] {
  const calls: ProcessorCall[] = [];
  globalThis.fetch = mock(
    (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  ) as unknown as typeof fetch;
  return calls;
}

describe("exchange checkout on the project key", () => {
  it("forwards the exchange options on the key and returns them unchanged", async () => {
    const payload = {
      provider: "swapped",
      kind: "exchange",
      connections: [
        {
          connection: "binance",
          name: "Binance",
          logoUrl: null,
          kind: "exchange",
          appHandoff: "none",
        },
      ],
    };
    const calls = captureProcessor(payload);

    const response = await handler(
      new Request(
        "http://proxy.test/onramp/options?provider=swapped&kind=exchange",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://processor.test/onramp/options?provider=swapped&kind=exchange",
    );
    expect(new Headers(calls[0]?.init.headers).get("x-api-key")).toBe(
      "proxy-key",
    );
  });

  it("starts an exchange order on the key, body unchanged, and passes the 202 through", async () => {
    const payload = {
      orderId: "0199a000-0000-7000-8000-000000000001",
      nextAction: {
        type: "hosted",
        url: "https://connect.swapped.test/?walletAddress=USDC%3Abase%3A0xcexdeposit",
        presentation: "iframe",
      },
      expiresAt: "2026-07-27T01:00:00.000Z",
    };
    const calls = captureProcessor(payload, 202);
    const body = JSON.stringify({
      provider: "swapped",
      kind: "exchange",
      account: "0x0000000000000000000000000000000000000001",
      connection: "binance",
    });

    const response = await handler(
      new Request("http://proxy.test/onramp/orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://client.example",
        },
        body,
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://processor.test/onramp/orders");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(body);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-api-key")).toBe("proxy-key");
    expect(headers.get("origin")).toBe("https://client.example");
  });
});
