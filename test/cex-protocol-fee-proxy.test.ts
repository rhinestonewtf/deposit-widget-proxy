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

function captureProcessor(payload: unknown): ProcessorCall[] {
  const calls: ProcessorCall[] = [];
  globalThis.fetch = mock(
    (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  ) as unknown as typeof fetch;
  return calls;
}

describe("CEX Connect protocol-fee proxy contract", () => {
  it("preserves exchangeFeeBps from connect-exchanges", async () => {
    const payload = {
      exchanges: [
        { connection: "binance", name: "Binance", logoUrl: null },
      ],
      fetchedAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2026-07-28T00:00:00.000Z",
      stale: false,
      exchangeFeeBps: 35,
    };
    const calls = captureProcessor(payload);

    const response = await handler(
      new Request("http://proxy.test/onramp/swapped/connect-exchanges"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://processor.test/onramp/swapped/connect-exchanges",
    );
    expect(new Headers(calls[0]?.init.headers).get("x-api-key")).toBe(
      "proxy-key",
    );
  });

  it("preserves the fee-bearing signed URL and disclosure from connect-url", async () => {
    const payload = {
      ok: true,
      url: "https://connect.swapped.test/?walletAddress=USDC%3Abase%3A0xcexdeposit",
      currencyCode: "USDC_BASE",
      sandbox: false,
      externalCustomerId: "0xuser:order-id",
      exchangeFeeBps: 35,
      expiresAt: "2026-07-27T01:00:00.000Z",
    };
    const calls = captureProcessor(payload);
    const requestBody = {
      smartAccount: "0x0000000000000000000000000000000000000001",
      connection: "binance",
    };

    const response = await handler(
      new Request("http://proxy.test/onramp/swapped/connect-url", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://client.example",
        },
        body: JSON.stringify(requestBody),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://processor.test/onramp/swapped/connect-url",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual(requestBody);
    expect(new Headers(calls[0]?.init.headers).get("origin")).toBe(
      "https://client.example",
    );
  });
});
