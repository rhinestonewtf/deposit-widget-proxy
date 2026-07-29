# deposit-widget-proxy

The Rhinestone deposit widget runs in the browser, so it can't hold your
Rhinestone API key. Every request it makes goes to a proxy **you** run, which
attaches the key and forwards to the deposit processor.

This is the proxy Rhinestone runs, packaged so you can deploy it as-is. It is a
single Bun + Hono process: an explicit route table, a fresh upstream header set
with `x-api-key` attached, and nothing else. If you'd rather write your own, the
[minimal recipe](https://docs.rhinestone.dev/deposits/widget/backend) is about
forty lines.

New to the widget? Start with the
[quickstart](https://docs.rhinestone.dev/deposits/widget/quickstart). This README
covers only how to run and configure this service.

## Quick start

```bash
bun install
RHINESTONE_API_KEY=your-key bun run dev
```

Or build the image — a compiled binary on distroless, no Bun in the final layer:

```bash
docker build -t deposit-widget-proxy .
docker run -p 4000:4000 -e RHINESTONE_API_KEY=your-key deposit-widget-proxy
```

Point the modal's `backendUrl` at it and check `GET /health`.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RHINESTONE_API_KEY` | yes | — | Attached as `x-api-key` upstream. The process exits if it's unset |
| `DEPOSIT_SERVICE_URL` | no | `https://v1.orchestrator.rhinestone.dev/deposit-processor` | The upstream processor |
| `PORT` | no | `4000` | |
| `REFUND_TOKEN_SECRET` | no | — | Opts into [self-service refunds](#self-service-refunds). Unset, that route does not exist |
| `TRUSTED_COUNTRY_HEADER` | no | — | See [regional payment methods](#regional-payment-methods) |
| `TRUSTED_PROXY_HOPS` | no | — | See [regional payment methods](#regional-payment-methods) |
| `TRUSTED_PROXY_CIDRS` | no | — | Required by either of the two above |

## Routes

Callers reach these without an API key — the proxy injects it. Everything goes to
`DEPOSIT_SERVICE_URL`; there is one upstream.

| Method | Route |
|---|---|
| `POST` | `/register-managed`, `/setup-account`, `/register` |
| `POST` | `/quotes/preview` |
| `POST` | `/safe/withdraw`, `/polymarket/withdraw` |
| `POST` | `/onramp/swapped/widget-url`, `/onramp/swapped/connect-url` |
| `POST` | `/positions/:address/unwind` |
| `GET` | `/check/:address` |
| `GET` | `/positions/:address` |
| `GET` | `/portfolio/:address`, `/portfolio/solana/:address` |
| `GET` | `/deposits` |
| `GET` | `/liquidity`, `/prices` |
| `GET` | `/setup` |
| `GET` | `/qr/tokens` |
| `GET` | `/onramp/swapped/payment-methods`, `/onramp/swapped/connect-exchanges`, `/onramp/swapped/status/:smartAccount` |
| `GET` | `/health` — liveness, answered locally |
| `POST` | `/deposits/refund` — only when `REFUND_TOKEN_SECRET` is set |

`POST /positions/:address/unwind` needs an API key carrying the `deposits:write`
scope. A read-only key still serves `GET /positions/:address`, so the symptom of
the wrong scope is an unwind that 403s while the position list looks healthy.

`GET /tokens` is kept as an alias of `GET /qr/tokens` for modal versions before
0.9.x.

A few deliberate omissions:

- **`POST /setup` is not proxied.** It's an admin write that rotates your webhook
  secret and sponsorship config, so it must not be reachable from a browser. Call
  it directly against the processor — see
  [initial setup](https://docs.rhinestone.dev/deposits/api/initial-setup). The
  read, `GET /setup`, *is* proxied so the modal can load your config; it never
  returns the signing secret, only `hasWebhookSecret`.
- **No wildcard passthrough.** The route table is a security boundary, not
  boilerplate: the proxy attaches your API key to whatever reaches it, so
  `app.all("/*")` would hand the browser every write on the upstream.

Request headers are never copied wholesale. The proxy builds a fresh set and
relays only `origin`, `referer`, and `x-deposit-modal-version` — so a browser
cannot inject `x-api-key`, or any of the trusted headers below.

## Regional payment methods

Fiat on-ramp methods vary by country, and this proxy is the only component that
can see the end user: the processor sits behind it and only ever observes this
proxy's address.

You do **not** need a GeoIP database — the processor owns the lookup. This proxy
only names what it observed, which takes one of two variables.

**Behind a CDN that already resolves country** (Cloudflare, Vercel, CloudFront,
Fastly, GCP), forward its header:

```
TRUSTED_COUNTRY_HEADER=cf-ipcountry      # or x-vercel-ip-country,
TRUSTED_PROXY_CIDRS=<your ingress CIDRs> # cloudfront-viewer-country, ...
```

**Otherwise**, say how many trusted proxies sit in front of this process and it
relays the client IP for the processor to resolve:

```
TRUSTED_PROXY_HOPS=1                     # 0 = nothing in front of this process
TRUSTED_PROXY_CIDRS=<your ingress CIDRs>
```

`TRUSTED_PROXY_CIDRS` is why both variables require it: without an allowlist of
the peers permitted to set forwarding headers, any browser could send
`x-forwarded-for` or `cf-ipcountry` and choose its own region. The process
**refuses to start** if you set either without it.

Set neither and nothing is relayed — the modal shows a generic method set.

Two properties worth knowing before you tune this:

- Hops are counted from the **right**, which is what makes a forged header inert.
  A browser can prepend anything to `x-forwarded-for`; your ingress appends the
  address it actually saw.
- A malformed chain resolves to nothing rather than being repaired. Dropping an
  entry shifts hop positions and could promote an attacker-controlled address
  into the client slot.

Getting the configuration wrong costs you localization, never correctness: every
path fails closed to the generic method set. Resolved country and IP are relayed
upstream but never logged.

## Self-service refunds

Lets a user recover a `failed` or `rejected` deposit themselves. **Opt-in**:
without `REFUND_TOKEN_SECRET` the route is never registered — a registration gate
rather than a 401 inside the handler, so bumping the proxy version cannot
silently expose an endpoint that spends your API key.

Whether a deposit belongs to a given user is something only your app knows, so
your app vouches for it by minting a short-lived token; this proxy verifies it,
confirms the deposit really does belong to that recipient, and only then spends
your API key. For the reasoning, the modal props, and a worked example, see
[claim modal](https://docs.rhinestone.dev/deposits/widget/claim-modal).

The contract this proxy implements: an HS256 JWT signed with
`REFUND_TOKEN_SECRET`, presented in `x-user-token`. Every claim is required.

| Claim | Meaning |
|---|---|
| `recipient` | The user's in-app recipient — what the deposit is checked against. **Not** where the money goes |
| `destination` | Where the refunded funds are sent, on the deposit's source chain |
| `chain`, `txHash`, `account`, `token` | Identify the deposit, as returned by `GET /deposits` |
| `exp` | Required. Keep it short — 60s is plenty. A token without it is rejected |

**The request body is ignored.** Every field of the upstream refund comes from
the signed token, so the browser presents a credential rather than describing a
refund it would like to happen.

Responses are `401` (missing, invalid, or expired token), `403` (the deposit
isn't that recipient's), `404` (refunds not enabled), otherwise the processor's
own response plus a `destination` field reporting where the funds actually went —
taken from the token, which need not match what the browser asked for.

Two notes:

- Bind each token to one specific refund, as above. A token carrying only an
  identity is a bearer credential spendable on any destination.
- Replay is handled upstream: the refund atomically claims the deposit out of
  `failed`/`rejected`, so a replayed token finds nothing refundable rather than
  paying twice.

## Development

```bash
bun test          # spawns the proxy against a stub upstream; no network or key needed
bun run typecheck
```

The suites run the real process as a subprocess rather than importing the app,
which is what lets them assert on the CORS preflight, the opt-in gates, and
exactly which headers and query strings reach the upstream.

## License

MIT — see [LICENSE](./LICENSE).
