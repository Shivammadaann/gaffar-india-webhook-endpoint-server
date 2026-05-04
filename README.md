# WATI Incoming Webhook Relay

A lightweight Express webhook relay server for WATI that captures all incoming events, forwards them to a configurable target URL, and provides a live admin dashboard at `/admin`.

## Features

- `POST /webhook` accepts all WATI events
- Stores recent event history in memory and local persistence file `events.json`
- Optionally forwards events to `FORWARD_URL`
- `/admin` dashboard shows incoming events live
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

3. Set `FORWARD_URL` to the URL where you want events forwarded.
   - If you want the relay to receive WATI events and also forward them on to a downstream service, set this to that downstream URL.
   - If you only want this app to receive and store events, leave `FORWARD_URL` blank.

4. Add WATI registration settings:

```text
WATI_API_ENDPOINT=https://api.wati.io
WATI_API_TOKEN=your_wati_api_token_here
```

5. Set `ADMIN_SECRET` to a strong secret for admin operations.
   - Enter the same value into the `Admin Secret` field in `/admin` before saving the forward URL or registering WATI webhook endpoints.

6. Start the server:

```bash
npm start
```

7. Open the admin UI:

```text
http://localhost:3000/admin
```

## WATI webhook registration

The admin UI can register webhook endpoints directly in WATI using the official API.

- Configure `WATI_API_ENDPOINT` and `WATI_API_TOKEN`.
- Open `/admin` and submit a phone number, webhook URL, and event types.
- The server forwards the registration request to `POST /api/v2/webhookEndpoints`.

## Deployment

- Expose the app to the internet as `watiwebhooks.gaffarindia.in`
- Route `POST /webhook` from WATI to `https://watiwebhooks.gaffarindia.in/webhook`
- Use a reverse proxy or cloud host with TLS

## Render deployment

This repo includes a `render.yaml` file so Render can deploy it as a Node web service.

1. Connect the repo to Render.
2. Use the existing `render.yaml` or create a new Web Service with:
   - Environment: `Node`
   - Build command: `npm install`
   - Start command: `npm start`
3. Add the following environment variables in Render:
   - `WATI_API_ENDPOINT=https://api.wati.io`
   - `WATI_API_TOKEN` (your WATI bearer token)
   - `ADMIN_SECRET` (a strong admin secret)
   - `FORWARD_URL` (optional downstream forward target, leave blank if you only want to receive and store events)
4. If you want WATI to post events to this app, register `https://watiwebhooks.gaffarindia.in/webhook` in the WATI dashboard.

## Notes

- The dashboard is intentionally simple and runs in the same service.
- The event store persists to `events.json` for restart resiliency.
