/** Contract coverage for the two gasless token-authorization routes. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const UPSTREAM_PORT = 4620
const PROXY_PORT = 4621

interface UpstreamCall {
  pathname: string
  method: string
  apiKey: string | null
  body: string
}

let calls: UpstreamCall[] = []
let upstream: ReturnType<typeof Bun.serve>
let proxy: ReturnType<typeof Bun.spawn>

async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://localhost:${PROXY_PORT}/health`)).ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error('permit proxy never became healthy')
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    async fetch(req) {
      const url = new URL(req.url)
      calls.push({
        pathname: url.pathname,
        method: req.method,
        apiKey: req.headers.get('x-api-key'),
        body: await req.text(),
      })
      if (url.pathname === '/deposits/permit/prepare') {
        return Response.json({
          available: true,
          authorization: {
            kind: 'erc3009',
            nonce: `0x${'12'.repeat(32)}`,
            validAfter: '0',
            validBefore: '1900000000',
            typedData: {},
          },
        })
      }
      if (url.pathname === '/deposits/permit') {
        return Response.json(
          { depositId: '42', txHash: `0x${'ab'.repeat(32)}`, status: 'processing' },
          { status: 202 },
        )
      }
      return new Response('not found', { status: 404 })
    },
  })

  proxy = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: import.meta.dir.replace(/\/test$/, ''),
    env: {
      ...process.env,
      RHINESTONE_API_KEY: 'processor-key',
      DEPOSIT_SERVICE_URL: `http://localhost:${UPSTREAM_PORT}`,
      PORT: String(PROXY_PORT),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitForHealth()
})

afterAll(() => {
  proxy?.kill()
  upstream?.stop(true)
})

async function post(pathname: string, body: unknown) {
  return fetch(`http://localhost:${PROXY_PORT}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'browser-must-not-win',
    },
    body: JSON.stringify(body),
  })
}

describe('gasless permit routes', () => {
  test('forwards prepare and submit bodies with the configured API key', async () => {
    calls = []
    const route = {
      account: '0x2222222222222222222222222222222222222222',
      sourceChain: 'eip155:8453',
      token: '0x3333333333333333333333333333333333333333',
      amount: '1000000',
      owner: '0x1111111111111111111111111111111111111111',
      kind: 'auto',
    }

    const prepared = await post('/deposits/permit/prepare', route)
    expect(prepared.status).toBe(200)

    const submitted = await post('/deposits/permit', {
      ...route,
      kind: 'erc3009',
      nonce: `0x${'12'.repeat(32)}`,
      validAfter: '0',
      validBefore: '1900000000',
      signature: '0x1234',
    })
    expect(submitted.status).toBe(202)

    expect(calls).toEqual([
      {
        pathname: '/deposits/permit/prepare',
        method: 'POST',
        apiKey: 'processor-key',
        body: JSON.stringify(route),
      },
      {
        pathname: '/deposits/permit',
        method: 'POST',
        apiKey: 'processor-key',
        body: JSON.stringify({
          ...route,
          kind: 'erc3009',
          nonce: `0x${'12'.repeat(32)}`,
          validAfter: '0',
          validBefore: '1900000000',
          signature: '0x1234',
        }),
      },
    ])
  })
})
