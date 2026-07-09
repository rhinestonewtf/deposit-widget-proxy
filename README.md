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
| `PORT` | no | `4000` |

`WIDGET_BACKEND_URL` is only used for `GET /tokens` (the static QR-flow token
catalog is served by deposit-widget-backend, not the processor). The default
derivation works when both run on the same host; override it otherwise.

## Proxied routes

`POST /setup-account`, `POST /register`, `POST /quotes/preview`,
`POST /safe/withdraw`, `POST /polymarket/withdraw`,
`POST /onramp/swapped/widget-url`, `POST /onramp/swapped/connect-url`,
`GET /check/:address`, `GET /portfolio/:address`, `GET /portfolio/solana/:address`,
`GET /deposits`, `GET /liquidity`, `GET /prices`, `GET /setup`, `GET /tokens`,
`GET /onramp/swapped/connect-exchanges`, `GET /onramp/swapped/status/:smartAccount`,
`GET /health`.

Clients call these without an API key — the proxy injects it. `GET /tokens` is
forwarded to `WIDGET_BACKEND_URL`; everything else goes to `DEPOSIT_SERVICE_URL`.

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
