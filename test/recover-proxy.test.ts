/**
 * Contract tests for signed deposit recovery (RHI-5265).
 *
 * Runs the proxy as a subprocess against a stub processor, like the QR-token and
 * positions tests, so the assertions cover what actually reaches the upstream —
 * path, method, injected API key and relayed body — rather than a mocked fetch.
 *
 * That seam is the whole reason this route exists. The previous signed-recovery
 * attempt (deposit-modal #84) failed partly because `POST /deposits/recover` was
 * proxied by neither proxy, so the submit 404'd no matter what the client did, and
 * no unit test on either side could show it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const UPSTREAM_PORT = 4610
const PROXY_PORT = 4611

const DESTINATION = '0x742d35cc6634c0532925a3b844bc9e7595f5be91'
// A raw ECDSA signature: the embedded-EOA case, and the shortest the API accepts.
const RAW_SIGNATURE = `0x${'11'.repeat(65)}`
// An ERC-6492 wrapper embeds the account's factory + factoryData, so it is far
// longer than 65 bytes. The proxy must relay it byte-for-byte — truncating or
// re-encoding it would make an undeployed smart account unverifiable upstream.
const WRAPPED_SIGNATURE = `0x${'ab'.repeat(700)}`

interface UpstreamCall {
  method: string
  pathname: string
  apiKey: string | null
  body: string
}

let calls: UpstreamCall[] = []
let upstream: ReturnType<typeof Bun.serve>
let proxy: ReturnType<typeof Bun.spawn>

const REFUNDED = {
  message: 'Deposit refunded',
  transactionHash: `0x${'cd'.repeat(32)}`,
  amount: '200000',
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
        apiKey: req.headers.get('x-api-key'),
        body: await req.text(),
      })
      if (url.pathname === '/deposits/recover' && req.method === 'POST') {
        return Response.json(REFUNDED)
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

function recover(body: unknown) {
  return fetch(`http://localhost:${PROXY_PORT}/deposits/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('signed deposit recovery', () => {
  test('forwards POST /deposits/recover with the API key injected', async () => {
    calls = []
    const body = {
      depositId: '2551',
      destination: DESTINATION,
      signature: RAW_SIGNATURE,
    }

    const res = await recover(body)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(REFUNDED)
    expect(calls).toEqual([
      {
        method: 'POST',
        pathname: '/deposits/recover',
        apiKey: 'test-key',
        body: JSON.stringify(body),
      },
    ])
  })

  test('relays a long ERC-6492 signature byte-for-byte', async () => {
    // The whole point of accepting variable-length signatures: an undeployed smart
    // account's wrapper carries its factory and factoryData, and the processor
    // verifies those bytes exactly.
    calls = []

    await recover({
      depositId: '2551',
      destination: DESTINATION,
      signature: WRAPPED_SIGNATURE,
    })

    expect(JSON.parse(calls[0]!.body).signature).toBe(WRAPPED_SIGNATURE)
  })

  test('needs no secret and no opt-in to be registered', async () => {
    // Unlike the refund route it replaces, which was gated on REFUND_TOKEN_SECRET
    // and therefore enabled nowhere. The recipient's signature is the
    // authorization, so there is nothing for a caller to gain from reaching this
    // route without one — the proxy is started here with no extra configuration
    // beyond the key and upstream, and the route answers.
    const res = await recover({
      depositId: '1',
      destination: DESTINATION,
      signature: RAW_SIGNATURE,
    })

    expect(res.status).not.toBe(404)
  })

  test('does not proxy POST /deposits/refund', async () => {
    // Deliberate: a refund takes a destination from whoever asks, and this proxy
    // authenticates nobody. Recovery is safe here precisely because it does not.
    const res = await fetch(`http://localhost:${PROXY_PORT}/deposits/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'eip155:8453', destination: DESTINATION }),
    })

    expect(res.status).toBe(404)
  })
})
