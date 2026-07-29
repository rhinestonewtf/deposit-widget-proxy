/**
 * What the proxy actually relays upstream for regional localization.
 *
 * Runs the real proxy as a subprocess against a stub processor, because the
 * property that matters is a negative one — that a browser cannot talk the proxy
 * into asserting a country — and that lives in the header set the upstream sees,
 * not in any unit-testable return value.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const UPSTREAM_PORT = 4604
const HOPS_PORT = 4605
const CDN_PORT = 4606
const OFF_PORT = 4607

const CLIENT_IP = '203.0.113.7'

interface Relayed {
  country: string | null
  clientIp: string | null
}

let seen: Relayed[] = []
let upstream: ReturnType<typeof Bun.serve>
const procs: ReturnType<typeof Bun.spawn>[] = []

function spawnProxy(port: number, env: Record<string, string>) {
  const proc = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: import.meta.dir.replace(/\/test$/, ''),
    env: {
      ...process.env,
      RHINESTONE_API_KEY: 'test-key',
      DEPOSIT_SERVICE_URL: `http://localhost:${UPSTREAM_PORT}`,
      PORT: String(port),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  procs.push(proc)
  return proc
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

/** Calls a localized route and returns what the upstream was told. */
async function callVia(
  port: number,
  headers: Record<string, string> = {},
): Promise<Relayed> {
  seen = []
  await fetch(`http://localhost:${port}/onramp/swapped/payment-methods`, {
    headers,
  })
  const relayed = seen[0]
  if (!relayed) throw new Error('upstream was never called')
  return relayed
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    fetch(req) {
      seen.push({
        country: req.headers.get('x-user-country'),
        clientIp: req.headers.get('x-client-ip'),
      })
      return Response.json({ country: null, methods: [], recommendedMethod: null })
    },
  })

  // Loopback stands in for the ingress: the proxy's socket peer in these tests is
  // always 127.0.0.1, so trusting that range is what a real deployment does with
  // its own ingress subnets.
  spawnProxy(HOPS_PORT, {
    TRUSTED_PROXY_HOPS: '1',
    TRUSTED_PROXY_CIDRS: '127.0.0.0/8,::1/128',
  })
  spawnProxy(CDN_PORT, {
    TRUSTED_COUNTRY_HEADER: 'cf-ipcountry',
    TRUSTED_PROXY_CIDRS: '127.0.0.0/8,::1/128',
  })
  spawnProxy(OFF_PORT, {})
  await Promise.all([
    waitForHealth(HOPS_PORT),
    waitForHealth(CDN_PORT),
    waitForHealth(OFF_PORT),
  ])
})

afterAll(() => {
  for (const proc of procs) proc.kill()
  upstream?.stop(true)
})

describe('client-IP relay (TRUSTED_PROXY_HOPS)', () => {
  test('relays the forwarded client IP', async () => {
    const relayed = await callVia(HOPS_PORT, { 'x-forwarded-for': CLIENT_IP })

    expect(relayed).toEqual({ country: null, clientIp: CLIENT_IP })
  })

  test('counts hops from the right, so a prepended entry is inert', async () => {
    // A browser can put anything at the front of x-forwarded-for; the ingress
    // appends the address it actually saw. Only the rightmost hops are trusted.
    const relayed = await callVia(HOPS_PORT, {
      'x-forwarded-for': `1.2.3.4, ${CLIENT_IP}`,
    })

    expect(relayed.clientIp).toBe(CLIENT_IP)
  })

  test('strips a browser-supplied x-client-ip', async () => {
    const relayed = await callVia(HOPS_PORT, {
      'x-client-ip': '198.51.100.99',
      'x-forwarded-for': CLIENT_IP,
    })

    expect(relayed.clientIp).toBe(CLIENT_IP)
  })

  test('strips a browser-supplied x-user-country', async () => {
    // The single most important assertion here: a browser must not be able to
    // pick its own payment-method region.
    const relayed = await callVia(HOPS_PORT, {
      'x-user-country': 'PH',
      'x-forwarded-for': CLIENT_IP,
    })

    expect(relayed.country).toBeNull()
  })

  test('relays nothing when the chain is malformed', async () => {
    const relayed = await callVia(HOPS_PORT, {
      'x-forwarded-for': `garbage, ${CLIENT_IP}`,
    })

    expect(relayed).toEqual({ country: null, clientIp: null })
  })

  test('relays nothing when the resolved address is private', async () => {
    const relayed = await callVia(HOPS_PORT, { 'x-forwarded-for': '10.1.2.3' })

    expect(relayed).toEqual({ country: null, clientIp: null })
  })
})

describe('country relay (TRUSTED_COUNTRY_HEADER)', () => {
  test('relays the CDN-resolved country and no IP', async () => {
    const relayed = await callVia(CDN_PORT, { 'cf-ipcountry': 'PH' })

    expect(relayed).toEqual({ country: 'PH', clientIp: null })
  })

  test('ignores a non-country code from the CDN', async () => {
    // Anonymous-proxy / satellite / EU-aggregate codes select no catalog.
    const relayed = await callVia(CDN_PORT, { 'cf-ipcountry': 'XX' })

    expect(relayed.country).toBeNull()
  })

  test('still strips a browser-supplied x-user-country', async () => {
    const relayed = await callVia(CDN_PORT, { 'x-user-country': 'BR' })

    expect(relayed.country).toBeNull()
  })
})

describe('localization off by default', () => {
  test('relays nothing when neither variable is set', async () => {
    const relayed = await callVia(OFF_PORT, {
      'x-forwarded-for': CLIENT_IP,
      'x-user-country': 'PH',
      'x-client-ip': CLIENT_IP,
      'cf-ipcountry': 'PH',
    })

    expect(relayed).toEqual({ country: null, clientIp: null })
  })
})

describe('startup refuses a configuration that would trust the browser', () => {
  test('hops > 0 without an allowlist fails to boot', async () => {
    const proc = spawnProxy(4608, { TRUSTED_PROXY_HOPS: '1' })

    expect(await proc.exited).not.toBe(0)
  })

  test('a country header without an allowlist fails to boot', async () => {
    const proc = spawnProxy(4609, { TRUSTED_COUNTRY_HEADER: 'cf-ipcountry' })

    expect(await proc.exited).not.toBe(0)
  })

  test('reading country from our own upstream header fails to boot', async () => {
    const proc = spawnProxy(4610, {
      TRUSTED_COUNTRY_HEADER: 'x-user-country',
      TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
    })

    expect(await proc.exited).not.toBe(0)
  })

  test('a non-numeric hop count fails to boot', async () => {
    const proc = spawnProxy(4611, {
      TRUSTED_PROXY_HOPS: 'lots',
      TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
    })

    expect(await proc.exited).not.toBe(0)
  })
})
