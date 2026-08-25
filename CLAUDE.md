# deposit-widget-proxy — Claude Instructions

A ~200-line Bun + Hono process that holds a Rhinestone API key and forwards
deposit-modal requests to `deposit-service-processor`. One upstream, an explicit
route table, and a freshly built header set.

**This repo is public and MIT-licensed, and clients self-host it.** Every change
is a change to someone else's deployment. Read
[Compatibility](#compatibility-what-breaks-someone-elses-deployment) before
touching routes, headers or CORS.

The README is current and integrator-facing. This file covers what it can't: how
Rhinestone deploys it, and the traps.

## Why it exists / what breaks without it

The deposit modal runs in a browser, so it cannot hold an API key. Something
server-side must attach one. Making that a *proxy the integrator runs* — rather
than an endpoint we host — means the key stays theirs and never transits our
infrastructure.

If a given deployment is down, that integrator's deposit flow is down entirely:
the modal's 16 backend calls all go through it and it has no fallback.

## Where it sits in the intent lifecycle

Before an intent exists — this is the deposit funding path:

```
browser (@rhinestone/deposit-modal)
   │  no API key
   ▼
deposit-widget-proxy         ← the integrator's, or one of our two instances
   │  + x-api-key
   │  + origin / referer / x-deposit-modal-version   (relayed)
   │  + x-user-country | x-client-ip                 (set, never relayed)
   ▼
deposit-service-processor
```

**The processor is the only component that sees every integration**, because
clients self-host the proxy. Per-client telemetry must be read there, not here.

## Two Rhinestone tenants, same chart and image

| ArgoCD app | Whose | Envs | Path | Key |
|---|---|---|---|---|
| `deposit-proxy` | **Ours** | dev (+prod) | `/deposit-proxy` | our own |
| `deposit-widget-proxy` | The client **Pred** | prod only | `/deposit-widget-proxy` | theirs |

Pointing anything of ours at Pred's instance spends their key **and** inherits
their client config — including the `depositWhitelist` the QR token picker acts
on, so our demo would render their allowed chains. Never repurpose
`/deposit-widget-proxy`.

`deposit-proxy` sets **`nameOverride: deposit-proxy`**, and it is load-bearing.
`common.fullname` only collapses to the release name when the release name
contains the chart name, so without it the Service renders as
`deposit-proxy-deposit-widget-proxy` (404ing the Traefik route), and
`common.selectorLabels`, the container name, `OTEL_SERVICE_NAME` and the default
`podAntiAffinity` all keep the *chart's* name — merging both tenants into one
Loki stream and one metrics series, and spreading our replicas away from theirs
instead of from each other.

## Ownership

No `CODEOWNERS`. Contributors by commit volume: **Konrad Kopp**, **Ivan Savin**,
**Kai Aldag**, **Aman Raj**.

## Running it

```sh
bun install
RHINESTONE_API_KEY=your-key bun run dev

bun run typecheck     # CI gate
bun test              # CI gate
```

The suites spawn the real proxy as a **subprocess against a stub upstream**, so
they assert what actually reaches the processor — path, injected key, query
string — rather than mocking `fetch`. That's the right pattern here: both bugs
that escaped review in this area lived in the proxy↔processor seam. CI needs no
secrets and runs on forks.

## Key files

| path | what |
|---|---|
| `src/index.ts` | Everything: the `ROUTES` table, CORS, header construction, forwarding |
| `src/geoip.ts` | Trusted-proxy checks and edge-signal resolution |
| `test/*.test.ts` | Subprocess-against-stub suites, one per surface |

## Compatibility — what breaks someone else's deployment

- **Adding a request header the modal sends is a breaking change** for any
  self-hosted proxy with an explicit CORS `allowHeaders` — and this one has one.
  The browser blocks the **whole request** at preflight, not just the new
  header, so every modal call fails, not only the one that wanted it. Deploy
  proxies before releasing a modal that sends a new header. (A bare Hono
  `cors()` is safe: it reflects `Access-Control-Request-Headers` when
  `allowHeaders` is empty.)
- **Adding a route the modal calls means older self-hosted proxies 404 it.**
  How bad that is depends entirely on the route — `/register-managed` missing
  kills registration outright; `/onramp/swapped/payment-methods` missing
  degrades silently to generic payment methods. Decide which you're shipping.
- **A new ORIGIN breaks a narrowed allow-list the same way a new header does.**
  A mobile integration calls from the hosted embed page
  (`https://deposit.rhinestone.dev`, `https://dev.deposit.rhinestone.dev`), not
  from the client's own domain, so a client who replaced `origin: "*"` rejects
  every call at preflight. This deployment is unaffected — `origin: "*"`
  reflects everything — and no telemetry we hold can tell us which clients
  narrowed theirs, so it is outreach, not a query. The README's CORS section is
  the client-facing copy.
- **`GET /tokens` is a legacy alias of `GET /qr/tokens`** for modals before
  0.9.x. It exists precisely because a client can point an old modal at a new
  proxy. Remove it only when no released modal calls `/tokens`.

## Gotchas

- **The route table is a security boundary, not boilerplate.** The proxy
  attaches the API key to whatever reaches it, so `app.all("/*")` would hand the
  browser every write on the upstream. Add routes one at a time, deliberately.
- **`POST /setup` is deliberately not proxied** (it rotates the webhook secret
  and sponsorship config — an admin write). `GET /setup` is, because the
  processor returns only `hasWebhookSecret`, never the secret.
- **`POST /deposits/refund` is deliberately not proxied either.** It takes a
  destination from whoever asks. `POST /deposits/recover` is proxied instead:
  its authorization is the recipient's *signature* over the deposit id and
  destination, so the API key grants a caller nothing.
- **Headers are built fresh, never copied.** Only `origin`, `referer` and
  `x-deposit-modal-version` are relayed. This is why a browser cannot inject
  `x-api-key`, `x-user-country` or `x-client-ip` — and why adding any new
  client→processor signal means editing **both** proxies plus the docs recipe
  for custom proxies.
- **The localization env vars fail closed, at startup.** `TRUSTED_PROXY_HOPS > 0`
  or `TRUSTED_COUNTRY_HEADER` without `TRUSTED_PROXY_CIDRS` **throws and the
  process exits** — without an allowlist any client could forge the header. Hops
  are counted from the **right**, which is what makes a browser-prepended
  `x-forwarded-for` inert; a malformed chain resolves to nothing rather than
  being repaired.
- **Our dev instance sets `TRUSTED_PROXY_HOPS=1`** with the three private EKS
  subnet CIDRs, because Traefik is the single hop in front of the pod. **Pred's
  instance sets neither**, so they get no localization at all — deliberate, and
  the reason a country appears on our traffic but not theirs.
- **The `server` handle is threaded through Hono's env on purpose.**
  `server.requestIP` is the only way to reach the socket peer address, which
  client-IP resolution needs. Drop it and every request looks like it came from
  nowhere.
- **`GeoipService` logs nothing on a successful lookup.** The only evidence
  localization worked is the `onramp.country_source` span attribute
  (`header` / `client_ip` / `none`) on the processor.
- **A merge dispatches `app_name=deposit-proxy`, and the CD pipeline fans that
  out to Pred's prod app too**, so both tenants land on the identical image under
  a single approval. Both names supersede each other in the approval guard —
  otherwise a Pred-only dispatch sitting on an hour-long approval could be
  released *after* a newer fan-out and roll them backwards.
