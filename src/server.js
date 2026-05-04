const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const fetch = require('cross-fetch');
const { loadEvents, saveEvents } = require('./events-store');

require('dotenv').config();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const EVENTS_MAX = parseInt(process.env.EVENTS_MAX, 10) || 500;
const LOG_LEVEL = process.env.LOG_LEVEL || 'dev';
const WATI_API_ENDPOINT = (process.env.WATI_API_ENDPOINT || 'https://api.wati.io').replace(/\/+$/, '');
const WATI_API_TOKEN = process.env.WATI_API_TOKEN || '';
const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';
const WEBHOOK_FORWARD_URL = (process.env.WEBHOOK_FORWARD_URL || '').trim();
const WEBHOOK_FORWARD_MAP = parseForwardMap(process.env.WEBHOOK_FORWARD_MAP || '');
const WEBHOOK_FORWARD_FORMAT = (process.env.WEBHOOK_FORWARD_FORMAT || 'event').toLowerCase() === 'raw' ? 'raw' : 'event';
const WEBHOOK_FORWARD_TIMEOUT_MS = parseInt(process.env.WEBHOOK_FORWARD_TIMEOUT_MS, 10) || 10000;

const app = express();
const eventHistory = loadEvents(EVENTS_MAX);
const sseClients = new Set();

function addEvent(event) {
  eventHistory.push(event);
  while (eventHistory.length > EVENTS_MAX) {
    eventHistory.shift();
  }
  saveEvents(eventHistory);
  publishEvent('created', event);
}

function updateEvent(eventId, patch) {
  const index = eventHistory.findIndex((item) => item.id === eventId);
  if (index === -1) return;

  eventHistory[index] = {
    ...eventHistory[index],
    ...patch,
  };

  saveEvents(eventHistory);
  publishEvent('updated', eventHistory[index]);
}

function publishEvent(action, event) {
  const payload = `data: ${JSON.stringify({ action, event })}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function parseForwardMap(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).reduce((map, [source, urls]) => {
        map[normalizeSource(source)] = urls;
        return map;
      }, {});
    }
  } catch (error) {
    // Fall back to comma-separated source=url pairs.
  }

  return raw.split(',').reduce((map, pair) => {
    const separator = pair.indexOf('=');
    if (separator === -1) return map;

    const source = normalizeSource(pair.slice(0, separator));
    const url = pair.slice(separator + 1).trim();
    if (source && url) {
      map[source] = url;
    }
    return map;
  }, {});
}

function normalizeSource(source) {
  return String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

function sourceEnvName(source) {
  return normalizeSource(source).replace(/[^a-z0-9]/g, '_').toUpperCase();
}

function appendUrls(targets, value) {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach((item) => appendUrls(targets, item));
    return;
  }

  String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => targets.push(item));
}

function getForwardTargets(source) {
  const targets = [];
  const sourceKey = normalizeSource(source);
  const envKey = `WEBHOOK_FORWARD_${sourceEnvName(source)}_URL`;

  appendUrls(targets, process.env[envKey]);
  appendUrls(targets, WEBHOOK_FORWARD_MAP[sourceKey]);
  appendUrls(targets, WEBHOOK_FORWARD_URL);

  return [...new Set(targets)];
}

function sanitizeHeaders(headers) {
  const redactedPattern = /(authorization|cookie|secret|token|api-key)/i;

  return Object.entries(headers).reduce((safeHeaders, [name, value]) => {
    safeHeaders[name] = redactedPattern.test(name) ? '[redacted]' : value;
    return safeHeaders;
  }, {});
}

function parseWebhookBody(rawBody, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const trimmed = rawBody.trim();

  if (!rawBody) {
    return { body: {}, parseError: null };
  }

  if (type.includes('json') || /^[\[{]/.test(trimmed)) {
    try {
      return { body: JSON.parse(rawBody), parseError: null };
    } catch (error) {
      return { body: rawBody, parseError: error.message };
    }
  }

  if (type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(rawBody);
    const body = {};

    for (const [key, value] of params.entries()) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        body[key] = Array.isArray(body[key]) ? [...body[key], value] : [body[key], value];
      } else {
        body[key] = value;
      }
    }

    return { body, parseError: null };
  }

  return { body: rawBody, parseError: null };
}

function detectEventType(headers, body) {
  if (headers['x-wati-event']) return headers['x-wati-event'];
  if (headers['x-wc-webhook-topic']) return headers['x-wc-webhook-topic'];
  if (headers['x-wc-webhook-event']) return headers['x-wc-webhook-event'];
  if (headers['x-shiprocket-event']) return headers['x-shiprocket-event'];

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body.eventType || body.event_type || body.topic || body.action || body.type || 'JSON';
  }

  return 'Raw';
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getWebhookSecret(source) {
  const envName = sourceEnvName(source);

  return (
    process.env[`WEBHOOK_SECRET_${envName}`] ||
    process.env[`${envName}_WEBHOOK_SECRET`] ||
    process.env.WEBHOOK_SHARED_SECRET ||
    ''
  );
}

function getPresentedWebhookSecret(req) {
  const authorization = req.headers.authorization || '';
  const bearerPrefix = 'Bearer ';

  if (authorization.startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim();
  }

  return (
    req.headers['x-webhook-secret'] ||
    req.headers['x-wati-secret'] ||
    req.headers['x-shiprocket-secret'] ||
    req.query.webhook_secret ||
    req.query.secret ||
    ''
  );
}

function verifyWebhookRequest(req, rawBodyBuffer) {
  const source = normalizeSource(req.params.source);
  const secret = getWebhookSecret(source);

  if (!secret) {
    return { ok: true };
  }

  const wooCommerceSignature = req.headers['x-wc-webhook-signature'];
  if (source === 'woocommerce' || wooCommerceSignature) {
    if (wooCommerceSignature) {
      const digest = crypto
        .createHmac('sha256', secret)
        .update(rawBodyBuffer)
        .digest('base64');

      return secureEquals(wooCommerceSignature, digest)
        ? { ok: true }
        : { ok: false, error: 'Invalid WooCommerce webhook signature' };
    }
  }

  const presentedSecret = getPresentedWebhookSecret(req);
  return presentedSecret && secureEquals(presentedSecret, secret)
    ? { ok: true }
    : { ok: false, error: 'Missing or invalid webhook secret' };
}

function buildForwardRequest(event) {
  if (WEBHOOK_FORWARD_FORMAT === 'raw') {
    return {
      contentType: event.contentType || 'application/octet-stream',
      body: event.rawBody || JSON.stringify(event.body || {}),
    };
  }

  const { forward, ...eventPayload } = event;
  return {
    contentType: 'application/json',
    body: JSON.stringify(eventPayload),
  };
}

async function sendForward(targetUrl, event) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_FORWARD_TIMEOUT_MS);

  try {
    const payload = buildForwardRequest(event);
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': payload.contentType,
        'X-Webhook-Source': event.source,
        'X-Event-Id': event.id,
        'X-Event-Time': event.receivedAt,
      },
      body: payload.body,
      signal: controller.signal,
    });

    const text = await response.text();
    return {
      targetUrl,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: text.slice(0, 500),
    };
  } catch (error) {
    return {
      targetUrl,
      ok: false,
      error: error.name === 'AbortError' ? `Forward request timed out after ${WEBHOOK_FORWARD_TIMEOUT_MS}ms` : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardEvent(event, targets) {
  const results = await Promise.all(targets.map((targetUrl) => sendForward(targetUrl, event)));
  const ok = results.every((result) => result.ok);

  updateEvent(event.id, {
    forward: {
      status: ok ? 'sent' : 'failed',
      completedAt: new Date().toISOString(),
      results,
    },
  });
}

app.use(morgan(LOG_LEVEL));
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isAdminAuthorized(req) {
  if (!ADMIN_SECRET) return true;
  const token = req.headers['x-admin-secret'] || req.query.secret;
  return token === ADMIN_SECRET;
}

app.post('/webhooks/:source', express.raw({ type: '*/*', limit: BODY_LIMIT }), async (req, res) => {
  const receivedAt = new Date().toISOString();
  const source = normalizeSource(req.params.source);
  const sourceIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const contentType = req.headers['content-type'] || '';
  const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const rawBody = rawBodyBuffer.toString('utf8');
  const verification = verifyWebhookRequest(req, rawBodyBuffer);

  if (!verification.ok) {
    return res.status(401).json({ success: false, error: verification.error });
  }

  const parsed = parseWebhookBody(rawBody, contentType);
  const headers = sanitizeHeaders(req.headers);
  const forwardTargets = getForwardTargets(source);
  const event = {
    id: makeId(),
    receivedAt,
    source,
    sourceIp,
    contentType,
    eventType: detectEventType(req.headers, parsed.body),
    headers,
    body: parsed.body,
    rawBody,
    parseError: parsed.parseError,
    forward: {
      status: forwardTargets.length > 0 ? 'pending' : 'disabled',
      targets: forwardTargets,
    },
  };

  addEvent(event);

  if (forwardTargets.length > 0) {
    forwardEvent(event, forwardTargets).catch((error) => {
      updateEvent(event.id, {
        forward: {
          status: 'failed',
          completedAt: new Date().toISOString(),
          results: [{ ok: false, error: error.message }],
        },
      });
    });
  }

  return res.json({
    success: true,
    eventId: event.id,
    source,
    forwardStatus: event.forward.status,
  });
});

app.use(express.json({ limit: BODY_LIMIT, strict: false }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

app.get('/api/events', (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const limit = parseInt(req.query.limit, 10) || EVENTS_MAX;
  const items = eventHistory.slice(-limit).reverse();
  return res.json({ events: items });
});

app.get('/api/config', (req, res) => {
  res.json({
    hasAdminSecret: Boolean(ADMIN_SECRET),
    eventsMax: EVENTS_MAX,
    forwardFormat: WEBHOOK_FORWARD_FORMAT,
    hasGlobalForwardTarget: Boolean(WEBHOOK_FORWARD_URL),
    forwardSources: Object.keys(WEBHOOK_FORWARD_MAP),
  });
});

app.post('/api/wati/register', async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!WATI_API_TOKEN) {
    return res.status(500).json({ error: 'WATI_API_TOKEN is not configured' });
  }

  const requestBody = req.body || {};

  // Handle both single webhook object and array of webhooks.
  let webhooks = [];
  if (Array.isArray(requestBody)) {
    webhooks = requestBody;
  } else if (requestBody.phoneNumber && requestBody.watiUrl) {
    // Single webhook object from UI
    webhooks = [{
      phoneNumber: requestBody.phoneNumber,
      status: requestBody.status,
      url: requestBody.watiUrl,
      eventTypes: requestBody.eventTypes
    }];
  } else if (requestBody.webhooks && Array.isArray(requestBody.webhooks)) {
    webhooks = requestBody.webhooks;
  } else {
    return res.status(400).json({ error: 'Invalid request body. Expected single webhook object or array of webhooks' });
  }

  const payload = webhooks.map((item) => ({
    phoneNumber: item.phoneNumber,
    status: Number(item.status),
    url: item.url,
    eventTypes: Array.isArray(item.eventTypes)
      ? item.eventTypes.map((eventType) => String(eventType).trim()).filter(Boolean)
      : String(item.eventTypes || '').split(',').map((eventType) => eventType.trim()).filter(Boolean),
  }));

  try {
    const response = await fetch(`${WATI_API_ENDPOINT}/api/v2/webhookEndpoints`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: 'WATI registration failed', details: data });
    }

    return res.json(data);
  } catch (error) {
    return res.status(502).json({ error: 'Failed to reach WATI API', details: error.message });
  }
});

app.get('/events/stream', (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', eventsStored: eventHistory.length });
});

app.use((error, req, res, next) => {
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  return next(error);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function start() {
  app.listen(PORT, () => {
    console.log(`Webhook relay running on port ${PORT}`);
    console.log(`Accepting webhooks at /webhooks/{source}`);
  });
}

start();
