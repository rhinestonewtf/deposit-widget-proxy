/**
 * Contract tests for the QR token shortlist routes.
 *
 * Runs the proxy as a subprocess against a stub processor, like the refund
 * tests, so the assertions cover what actually reaches the upstream — the path,
 * the injected API key and the query string — rather than a mocked fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const UPSTREAM_PORT = 4602
const PROXY_PORT = 4603

interface UpstreamCall {
  pathname: string
  search: string
  apiKey: string | null
}

let calls: UpstreamCall[] = []
let upstream: ReturnType<typeof Bun.serve>
let proxy: ReturnType<typeof Bun.spawn>

const SHORTLIST = {
  tokens: {
    '8453': [
      {
        symbol: 'USDC',
        address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        decimals: 6,
      },
    ],
    solana: [{ symbol: 'SOL', address: 'native', decimals: 9 }],
  },
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
    fetch(req) {
      const url = new URL(req.url)
      calls.push({
        pathname: url.pathname,
        search: url.search,
        apiKey: req.headers.get('x-api-key'),
      })
      if (url.pathname === '/qr/tokens' && req.method === 'GET') {
        return Response.json(SHORTLIST)
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

describe('QR token shortlist', () => {
  test('forwards GET /qr/tokens with the API key injected', async () => {
    calls = []

    const res = await fetch(`http://localhost:${PROXY_PORT}/qr/tokens`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SHORTLIST)
    expect(calls).toEqual([
      { pathname: '/qr/tokens', search: '', apiKey: 'test-key' },
    ])
  })

  test('serves the legacy GET /tokens from the same upstream path', async () => {
    // A client self-hosts this proxy, so a modal older than 0.9.x can be
    // pointed at a current deployment. The alias has to reach /qr/tokens
    // upstream, not /tokens — nothing serves /tokens on the processor.
    calls = []

    const res = await fetch(`http://localhost:${PROXY_PORT}/tokens`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SHORTLIST)
    expect(calls.map((call) => call.pathname)).toEqual(['/qr/tokens'])
  })

  test('does not let the browser supply its own API key', async () => {
    calls = []

    await fetch(`http://localhost:${PROXY_PORT}/qr/tokens`, {
      headers: { 'x-api-key': 'browser-key' },
    })

    expect(calls[0]?.apiKey).toBe('test-key')
  })

  test('preserves the query string on both paths', async () => {
    calls = []

    await fetch(`http://localhost:${PROXY_PORT}/qr/tokens?chain=8453`)
    await fetch(`http://localhost:${PROXY_PORT}/tokens?chain=8453`)

    expect(calls.map((call) => call.search)).toEqual([
      '?chain=8453',
      '?chain=8453',
    ])
  })

  test('allows the modal version header through CORS preflight', async () => {
    const res = await fetch(`http://localhost:${PROXY_PORT}/qr/tokens`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type,x-deposit-modal-version',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'x-deposit-modal-version',
    )
  })
})
