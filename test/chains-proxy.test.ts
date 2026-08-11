/**
 * Contract tests for the chain catalog route.
 *
 * Runs the proxy as a subprocess against a stub processor, like the QR token
 * tests, so the assertions cover what actually reaches the upstream — the path,
 * the injected API key and the query string — rather than a mocked fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const UPSTREAM_PORT = 4612
const PROXY_PORT = 4613

interface UpstreamCall {
  pathname: string
  search: string
  apiKey: string | null
}

let calls: UpstreamCall[] = []
let upstream: ReturnType<typeof Bun.serve>
let proxy: ReturnType<typeof Bun.spawn>

const CATALOG = {
  chains: [
    {
      chainId: 'eip155:8453',
      name: 'Base',
      deposit: true,
      destination: true,
      refund: true,
      supportedTokens: 'all',
    },
  ],
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
      if (url.pathname === '/chains' && req.method === 'GET') {
        return Response.json(CATALOG)
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

describe('chain catalog', () => {
  test('forwards GET /chains with the API key injected', async () => {
    calls = []

    const res = await fetch(`http://localhost:${PROXY_PORT}/chains`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(CATALOG)
    expect(calls).toEqual([
      { pathname: '/chains', search: '', apiKey: 'test-key' },
    ])
  })

  test('does not let the browser supply its own API key', async () => {
    calls = []

    await fetch(`http://localhost:${PROXY_PORT}/chains`, {
      headers: { 'x-api-key': 'browser-key' },
    })

    expect(calls[0]?.apiKey).toBe('test-key')
  })

  test('preserves the query string', async () => {
    calls = []

    await fetch(`http://localhost:${PROXY_PORT}/chains?deposit=true`)

    expect(calls.map((call) => call.search)).toEqual(['?deposit=true'])
  })

  test('clears preflight on the headers the modal already sends', async () => {
    // Pins that this route needed no CORS change: the modal sends it with the
    // same header set as every other GET, so a self-hosted proxy that adds the
    // route needs no allowHeaders edit to go with it.
    const res = await fetch(`http://localhost:${PROXY_PORT}/chains`, {
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
