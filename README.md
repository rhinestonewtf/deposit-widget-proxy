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
| `PORT` | no | `4000` |

## Proxied routes

`POST /setup-account`, `POST /register`, `POST /safe/withdraw`,
`GET /check/:address`, `GET /portfolio/:address`, `GET /portfolio/solana/:address`,
`GET /deposits`, `GET /liquidity`, `GET /health`.

Clients call these without an API key — the proxy injects it.

## Configuring your client (`/setup`)

One-off admin call to enable gas sponsorship and/or webhook notifications for
your API key. **Optional** — the modal works without it, but users will pay all
fees and no webhooks will fire.

Call the processor directly (not through the proxy — `/setup` isn't proxied
since it's an admin config, not per-user):

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
(`deposit-received`, `bridge-started`, `bridge-complete`, `bridge-failed`,
`post-bridge-swap-*`, `deposit-refunded`, `error`) to that URL. Signed with
HMAC-SHA256 in `X-Webhook-Signature: sha256=<hex>` when `webhookSecret` is set.
Fire-and-forget with 3 retries — your endpoint must be idempotent.

Without `webhookUrl`, no webhooks fire. The modal doesn't need them — it polls
`GET /deposits` directly.
