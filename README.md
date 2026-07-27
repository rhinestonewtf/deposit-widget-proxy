# deposit-widget-proxy

Minimal Bun + Hono proxy that forwards deposit modal requests to the Rhinestone
deposit-service-processor. Keeps your API key server-side and adds it as
`x-api-key` to every upstream call.

## Setup

```bash
bun install
RHINESTONE_API_KEY=your-key bun run dev
```

Env vars:

| Name | Required | Default |
|---|---|---|
| `RHINESTONE_API_KEY` | yes | — |
| `DEPOSIT_SERVICE_URL` | no | `https://v1.orchestrator.rhinestone.dev/deposit-processor` |
| `WIDGET_BACKEND_URL` | no | `DEPOSIT_SERVICE_URL` with `/deposit-processor` → `/deposit-widget` |
| `REFUND_TOKEN_SECRET` | no | — (unset disables self-service refunds entirely) |
| `PORT` | no | `4000` |

`WIDGET_BACKEND_URL` is only used for `GET /tokens` (the static QR-flow token
catalog is served by deposit-widget-backend, not the processor). The default
derivation works when both run on the same host; override it otherwise.

`REFUND_TOKEN_SECRET` opts into [self-service refunds](#self-service-refunds)
and is inert until you set it.

## Proxied routes

`POST /setup-account`, `POST /register`, `POST /register-managed`,
`POST /quotes/preview`,
`POST /safe/withdraw`, `POST /polymarket/withdraw`,
`POST /onramp/swapped/widget-url`, `POST /onramp/swapped/connect-url`,
`GET /check/:address`, `GET /portfolio/:address`, `GET /portfolio/solana/:address`,
`GET /deposits`, `GET /liquidity`, `GET /prices`, `GET /setup`, `GET /tokens`,
`GET /onramp/swapped/connect-exchanges`, `GET /onramp/swapped/status/:smartAccount`,
`GET /health`.

Clients call these without an API key — the proxy injects it. `GET /tokens` is
forwarded to `WIDGET_BACKEND_URL`; everything else goes to `DEPOSIT_SERVICE_URL`.

`POST /deposits/refund` is also available, but **only when `REFUND_TOKEN_SECRET`
is set** — see below.

## Self-service refunds

Lets a user recover a `failed` or `rejected` deposit themselves, instead of
raising a support ticket. **Opt-in**: without `REFUND_TOKEN_SECRET` the route is
never registered and nothing changes.

### Why your app has to be involved

Deposit accounts are owned by the Rhinestone service, so there is no user wallet
that can sign for a refund — and when the deposit came from an exchange, the
sender can't sign either. Whether a given deposit belongs to a given user is
something **only your app knows**: it authenticated them, and it chose the
`recipient` it passed to the modal.

So your app vouches, by minting a short-lived token. This proxy verifies it,
confirms the deposit really does belong to that recipient, and only then spends
your API key.

### Minting a token

Sign an HS256 JWT with `REFUND_TOKEN_SECRET` from an endpoint that requires a
logged-in session. Every claim is required:

| Claim | Meaning |
|---|---|
| `recipient` | The user's in-app recipient — what the deposit is checked against. **Not** where the money goes. |
| `destination` | Where the refunded funds are sent, on the deposit's source chain. |
| `chain`, `txHash`, `account`, `token` | Identify the deposit, as returned by `GET /deposits`. |
| `exp` | Required. Keep it short — 60s is plenty. |

```ts
import { sign } from "hono/jwt";

// e.g. app/api/refund-token/route.ts
export async function POST(req: Request) {
  const session = await getSession(req);          // your auth, not ours
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { chain, txHash, account, token, destination } = await req.json();

  return Response.json({
    token: await sign(
      {
        recipient: session.depositRecipient,      // the one YOU passed the modal
        destination,
        chain,
        txHash,
        account,
        token,
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      process.env.REFUND_TOKEN_SECRET!,
      "HS256",
    ),
  });
}
```

The browser then calls `POST /deposits/refund` on this proxy with the token in
`x-user-token`. **The request body is ignored** — every field of the refund comes
from the signed token, so the browser presents a credential rather than
describing a refund it would like to happen.

Responses: `401` (missing/invalid/expired token), `403` (the deposit isn't that
recipient's), `404` (refunds not enabled), otherwise the processor's own response.

### Notes

- Bind the token to one specific refund, as above. A token carrying only an
  identity is a bearer credential that can be spent on any destination.
- Replay is handled upstream: the refund atomically claims the deposit out of
  `failed`/`rejected`, so a replayed token finds nothing refundable rather than
  paying twice.
- `x-user-token` is sent only on this route, so clients on an older proxy see no
  change to any other request's CORS preflight.
- A user with a live token can refund to any destination they name. If your
  threat model includes attacker-run JavaScript on your own page, gate unusual
  destinations behind whatever step-up your auth stack already has — this proxy
  can't tell the difference.

## Configuring your client (`/setup`)

One-off admin call to enable gas sponsorship and/or webhook notifications for
your API key. **Optional** — the modal works without it, but users will pay all
fees and no webhooks will fire.

Only the write (`POST /setup`) goes to the processor directly — it rotates the
webhook secret and sponsorship rules, so it must not sit behind the browser-facing
proxy. (The read, `GET /setup`, *is* proxied so the modal can load your config;
it never returns the signing secret, only `hasWebhookSecret`.)

```bash
curl -X POST https://v1.orchestrator.rhinestone.dev/deposit-processor/setup \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RHINESTONE_API_KEY" \
  -d '{
    "params": {
      "webhookUrl": "https://yourapp.com/api/rhinestone-webhook",
      "webhookSecret": "shared-secret-for-hmac",
      "sponsorship": {
        "eip155:8453": { "gas": "all", "swap": "all", "bridging": "all" },
        "eip155:10":   { "gas": "deployed", "swap": "none", "bridging": "all" }
      }
    }
  }'
```

Field values:

- `gas`: `"all" | "none" | "deployed"` (`deployed` = only sponsor if smart account is already deployed)
- `swap`, `bridging`: `"all" | "none"`
- Chain keys: CAIP-2 (`"eip155:<chainId>"`)
- `webhookUrl`, `webhookSecret`: optional; set both to receive HMAC-signed events

### Webhook delivery

If `webhookUrl` is set, the processor POSTs every deposit event
(`deposit-received`, `bridge-started`, `bridge-delayed`, `bridge-complete`,
`bridge-failed`, `deposit-rejected`, `deposit-refunded`, `error`) to that URL.
Signed with HMAC-SHA256 in
`X-Webhook-Signature: sha256=<hex>` when `webhookSecret` is set.
Fire-and-forget with 3 retries — your endpoint must be idempotent.

Without `webhookUrl`, no webhooks fire. The modal doesn't need them — it polls
`GET /deposits` directly.
