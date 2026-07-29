/**
 * Contract tests for the DeFi position migration routes (RHI-5181).
 *
 * Runs the proxy as a subprocess against a stub processor, like the QR-token and
 * refund tests, so the assertions cover what actually reaches the upstream — the
 * path, the injected API key, the method and the relayed body — rather than a
 * mocked fetch. That is the seam the whole ticket exists for: the endpoints were
 * live on the processor and unreachable through the proxy, which no unit test on
 * either side could show.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const UPSTREAM_PORT = 4604
const PROXY_PORT = 4605

const HOLDER = '0x462cd08903ad2068ad293cab35f43130b3b8193c'
const ACCOUNT = '0x742d35cc6634c0532925a3b844bc9e7595f5be91'
const POOL = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5'

interface UpstreamCall {
  method: string
  pathname: string
  search: string
  apiKey: string | null
  body: string
}

let calls: UpstreamCall[] = []
let upstream: ReturnType<typeof Bun.serve>
let proxy: ReturnType<typeof Bun.spawn>

const POSITIONS = {
  positions: [
    {
      venue: 'aave',
      kind: 'lending',
      market: { address: POOL, name: 'Aave v3 Base' },
      chain: 'eip155:8453',
      asset: {
        address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        symbol: 'USDC',
        decimals: 6,
      },
      amount: '1500000',
      usdValue: 1.5,
      apy: 0.041,
      isCollateral: true,
      maxWithdrawable: '1500000',
      isFullExit: true,
      constraints: [],
    },
  ],
  totalUsd: 1.5,
  minDepositUsd: 0.04,
}

const PREPARED = {
  transaction: {
    to: POOL,
    data: '0x69328dec',
    value: '0',
    chainId: 8453,
  },
  amount: '1500000',
  isFullExit: true,
  recipient: ACCOUNT,
  constraints: [],
}

async function waitForHealth(port: number) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`proxy on ${port} never became healthy`)
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    async fetch(req) {
      const url = new URL(req.url)
      calls.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        apiKey: req.headers.get('x-api-key'),
        body: await req.text(),
      })
      if (url.pathname === `/positions/${HOLDER}` && req.method === 'GET') {
        return Response.json(POSITIONS)
      }
      if (
        url.pathname === `/positions/${HOLDER}/unwind` &&
        req.method === 'POST'
      ) {
        return Response.json(PREPARED)
      }
      return new Response('not found', { status: 404 })
    },
  })

  proxy = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: import.meta.dir.replace(/\/test$/, ''),
    env: {
      ...process.env,
      RHINESTONE_API_KEY: 'test-key',
      DEPOSIT_SERVICE_URL: `http://localhost:${UPSTREAM_PORT}`,
      PORT: String(PROXY_PORT),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitForHealth(PROXY_PORT)
})

afterAll(() => {
  proxy?.kill()
  upstream?.stop(true)
})

describe('DeFi position migration', () => {
  test('forwards GET /positions/:address with the API key injected', async () => {
    calls = []

    const res = await fetch(`http://localhost:${PROXY_PORT}/positions/${HOLDER}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(POSITIONS)
    expect(calls).toEqual([
      {
        method: 'GET',
        pathname: `/positions/${HOLDER}`,
        search: '',
        apiKey: 'test-key',
        body: '',
      },
    ])
  })

  test('forwards POST /positions/:address/unwind with the body intact', async () => {
    // The body carries the amount and market the processor re-validates against
    // live state. A dropped or rewritten field here would surface as a confusing
    // upstream 400, so assert the exact bytes.
    calls = []
    const body = {
      account: ACCOUNT,
      market: POOL,
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amount: '1500000',
    }

    const res = await fetch(
      `http://localhost:${PROXY_PORT}/positions/${HOLDER}/unwind`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(PREPARED)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.pathname).toBe(`/positions/${HOLDER}/unwind`)
    expect(calls[0]?.apiKey).toBe('test-key')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(body)
  })

  test('routes the unwind sub-path rather than swallowing it into /positions/:address', async () => {
    // `/positions/:address` would also match `/positions/x/unwind` under a
    // looser router. If it did, an unwind would silently become a position read
    // and the user would get a 200 with no transaction to sign.
    calls = []

    await fetch(`http://localhost:${PROXY_PORT}/positions/${HOLDER}/unwind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(calls.map((call) => call.pathname)).toEqual([
      `/positions/${HOLDER}/unwind`,
    ])
  })

  test('does not let the browser supply its own API key', async () => {
    calls = []

    await fetch(`http://localhost:${PROXY_PORT}/positions/${HOLDER}`, {
      headers: { 'x-api-key': 'browser-key' },
    })

    expect(calls[0]?.apiKey).toBe('test-key')
  })

  test('relays the upstream status rather than collapsing a refusal to 200', async () => {
    // A refused unwind (below the deposit floor, not whitelisted, unsettleable
    // source chain) is the pre-signature "blocked, nothing happened" case. The
    // modal shows the processor's reason, so the status and body have to survive.
    calls = []

    const res = await fetch(
      `http://localhost:${PROXY_PORT}/positions/0xdeadbeef/unwind`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    )

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not found')
  })
})
