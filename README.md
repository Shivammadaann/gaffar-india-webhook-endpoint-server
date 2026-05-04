# Webhook Relay

A lightweight Express webhook relay server that captures events from multiple sources and provides a live admin dashboard at `/admin`.

## Features

- `POST /webhooks/{source}` accepts events from any source (e.g., `/webhooks/woocommerce`, `/webhooks/meta`)
- Stores recent event history in memory and local persistence file `events.json`
- `/admin` dashboard shows incoming events live from all sources
- `/events/stream` provides server-sent events for live updates

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

4. Start the server:

```bash
npm start
```

5. Open the admin UI:

```text
http://localhost:3000/admin
```

## Webhook URLs

Configure your webhook sources to post to:

```
https://api.gaffarindia.in/webhooks/{source}
```

Examples:
- `https://api.gaffarindia.in/webhooks/woocommerce`
- `https://api.gaffarindia.in/webhooks/shiprocket`
- `https://api.gaffarindia.in/webhooks/meta`
- `https://api.gaffarindia.in/webhooks/wati`

```text
http://localhost:3000/admin
```

## WATI webhook status

The admin UI shows incoming events live. Webhook configuration is managed in WATI's dashboard.

- Configure webhooks in WATI's UI with your relay URL: `https://api.gaffarindia.in/webhooks/wati`
- The admin panel displays received events in real-time

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
- The event store persists to `events.json` for restart resiliency.
