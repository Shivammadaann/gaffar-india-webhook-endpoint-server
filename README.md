# Webhook Relay

A lightweight Express webhook relay server that captures events from multiple sources and provides a live admin dashboard at `/admin`.

## Features

- `POST /webhooks/{source}` accepts events from any source (e.g., `/webhooks/woocommerce`, `/webhooks/meta`)
- Stores recent event history in memory and local persistence file `events.json`
- `/admin` dashboard shows incoming events live from all sources
- `/events/stream` provides server-sent events for live updates
- Optional forwarding to a global URL or source-specific URLs
- Optional source-specific webhook secrets, including WooCommerce HMAC signature checks
- Built-in automation URLs at `POST /automations/{source}`
- Admin-editable automation rules for WATI contact sync, template sends, and custom HTTP posts
- Approved WATI template fetch in `/admin` using `WATI_API_ENDPOINT` and `WATI_API_TOKEN`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

3. Set `ADMIN_SECRET` to a strong secret for admin operations.

4. (Optional) Add WATI registration settings if you want to register webhooks via the admin panel:

```text
WATI_API_ENDPOINT=https://live-mt-server.wati.io
WATI_API_TOKEN=your_wati_api_token_here
WATI_CHANNEL_NUMBER=919999999999
DEFAULT_COUNTRY_CODE=91
```

**Required WATI API scopes:**
- `webhooks:create` (to register webhooks via API)
- `contacts:write` (to add/update WATI contacts from WooCommerce orders)
- `messagetemplate:read` (to fetch approved WATI templates in the admin panel)
- Template/message sending scope for your WATI account (to send WATI templates)

5. (Optional) Configure forwarding:

```text
# Send every received event to this URL.
WEBHOOK_FORWARD_URL=https://example.com/incoming-webhook-events

# Or send only one source to a URL.
WEBHOOK_FORWARD_WATI_URL=https://example.com/wati-events
WEBHOOK_FORWARD_SHIPROCKET_URL=https://example.com/shiprocket-events
WEBHOOK_FORWARD_WOOCOMMERCE_URL=https://example.com/woocommerce-events
```

By default, forwarded requests use a JSON event envelope with `source`, `headers`, `body`, `rawBody`, and timing metadata. Set `WEBHOOK_FORWARD_FORMAT=raw` to relay the original webhook body instead.

6. (Optional) Configure receiver secrets:

```text
WEBHOOK_SECRET_WATI=your_wati_webhook_secret
WEBHOOK_SECRET_SHIPPING=your_shiprocket_webhook_secret
WEBHOOK_SECRET_WOOCOMMERCE=your_woocommerce_webhook_secret
```

For WATI and Shiprocket, pass the secret as `?secret=...`, `?webhook_secret=...`, `X-Webhook-Secret`, `X-API-Key`, or `Authorization: Bearer ...`.

For WooCommerce, set the same value as the webhook secret in WooCommerce. The server validates the `X-WC-Webhook-Signature` HMAC header when it is present.

7. Start the server:

```bash
npm start
```

8. Open the admin UI:

```text
http://localhost:3000/admin
```

## Webhook URLs

Configure your webhook sources to post to either route. Both receive, store, and run automations:

```
https://api.gaffarindia.in/webhooks/{source}
https://api.gaffarindia.in/automations/{source}
```

Examples:
- WooCommerce: `https://api.gaffarindia.in/automations/woocommerce`
- Shiprocket: `https://api.gaffarindia.in/automations/shipping`
- WATI: `https://api.gaffarindia.in/automations/wati`

## Automations

Open `/admin` and use the Automations section to edit rules. The default rules match this plan:

- WooCommerce `order.created` and `order.updated`: sync customer details into WATI contacts.
- WooCommerce `order.created`: optional WATI template send for order confirmation.
- WooCommerce `order.updated`: optional WATI template send for status changes.
- WooCommerce abandoned cart events: optional WATI template send when an abandoned-cart plugin posts events.
- WooCommerce product events: captured for inventory workflows.
- Shiprocket shipping events: optional WATI template send for out-for-delivery.
- Shiprocket failed delivery/NDR/RTO: optional WATI template send for recovery flows.

Template actions are disabled by default because WATI requires approved template names from your account. Enable a rule action and enter the exact template name in `/admin` after your WATI template is approved.

Use **Approved WATI Templates** in `/admin` to fetch approved templates directly from WATI. The server calls:

```text
GET {WATI_API_ENDPOINT}/api/v2/getMessageTemplates
GET {WATI_API_ENDPOINT}/api/ext/v3/messageTemplates
```

with your configured bearer token, tries v2 first, falls back to ext/v3 when needed, filters approved templates, and never sends the token to the browser.

Automation config is stored in `automations.json`. Keep that file private because it can contain business workflow details.

## WATI webhook registration

If you want to register webhook endpoints directly from the admin panel:

- Configure `WATI_API_ENDPOINT` and `WATI_API_TOKEN` in your `.env`
- Open `/admin` and use the registration form
- The server forwards requests to `POST /api/v2/webhookEndpoints`

## Deployment

- Expose the app to the internet as `api.gaffarindia.in`
- Configure webhook sources to post to `https://api.gaffarindia.in/webhooks/{source}`
- Use a reverse proxy or cloud host with TLS

## Render deployment

This repo includes a `render.yaml` file so Render can deploy it as a Node web service.

1. Connect the repo to Render.
2. Use the existing `render.yaml` or create a new Web Service with:
   - Environment: `Node`
   - Build command: `npm install`
   - Start command: `npm start`
3. Add the following environment variables in Render:
   - `ADMIN_SECRET` (a strong admin secret)
4. If you want WATI to post events to this app, register `https://api.gaffarindia.in/webhooks/wati` in the WATI dashboard.

## Notes

- The dashboard is intentionally simple and runs in the same service.
- If `ADMIN_SECRET` is configured, `/api/events` and `/events/stream` require that secret.
- The event store persists to `events.json` for restart resiliency.
- Local file storage is suitable for a small single-instance service. Use a database or queue for high-volume production traffic.
