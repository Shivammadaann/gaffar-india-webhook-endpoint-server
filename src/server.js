const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const fetch = require('cross-fetch');
const { loadEvents, saveEvents } = require('./events-store');

require('dotenv').config();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const FORWARD_URL = process.env.FORWARD_URL || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const EVENTS_MAX = parseInt(process.env.EVENTS_MAX, 10) || 500;
const LOG_LEVEL = process.env.LOG_LEVEL || 'dev';
const WATI_API_ENDPOINT = (process.env.WATI_API_ENDPOINT || 'https://api.wati.io').replace(/\/+$/, '');
const WATI_API_TOKEN = process.env.WATI_API_TOKEN || '';

const app = express();
let forwardUrl = FORWARD_URL;
const eventHistory = loadEvents(EVENTS_MAX);
const sseClients = new Set();

function addEvent(event) {
  eventHistory.push(event);
  while (eventHistory.length > EVENTS_MAX) {
    eventHistory.shift();
  }
  saveEvents(eventHistory);
  publishEvent(event);
}

function publishEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function parseRawBody(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    data += chunk;
  });
  req.on('end', () => {
    req.rawBody = data || '';
    next();
  });
}

async function sendForward(targetUrl, event) {
  try {
    const payload = event.rawBody || JSON.stringify(event.body);
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': event.contentType || 'application/json',
        'X-Wati-Webhooks-Relay': 'wati-incoming-webhook',
        'X-Original-Event-Id': event.id,
        'X-Original-Event-Time': event.receivedAt,
      },
      body: payload,
    });

    const text = await response.text();
    return {
      forwarded: true,
      forwardResponse: {
        status: response.status,
        statusText: response.statusText,
        body: text.slice(0, 500),
      },
    };
  } catch (error) {
    return {
      forwarded: false,
      forwardResponse: {
        error: error.message,
      },
    };
  }
}

const maybeFetch = global.fetch || (async (...args) => {
  const nodeFetch = require('node-fetch');
  return nodeFetch(...args);
});

app.use(morgan(LOG_LEVEL));
app.use(cors());
app.use(parseRawBody);
app.use(express.json({ limit: '10mb', strict: false }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isAdminAuthorized(req) {
  if (!ADMIN_SECRET) return true;
  const token = req.headers['x-admin-secret'] || req.query.secret;
  return token === ADMIN_SECRET;
}

app.post('/webhook', async (req, res) => {
  const receivedAt = new Date().toISOString();
  const sourceIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const contentType = req.headers['content-type'] || '';
  let body = req.body;

  if ((body === undefined || body === null || body === '') && req.rawBody) {
    try {
      body = JSON.parse(req.rawBody);
    } catch (error) {
      body = req.rawBody;
    }
  }

  const event = {
    id: makeId(),
    receivedAt,
    sourceIp,
    contentType,
    headers: {
      'x-wati-event': req.headers['x-wati-event'] || null,
      'user-agent': req.headers['user-agent'] || null,
      'x-forwarded-for': req.headers['x-forwarded-for'] || null,
    },
    body,
    rawBody: req.rawBody,
    forwarded: false,
    forwardResponse: null,
  };

  addEvent(event);

  if (forwardUrl) {
    const result = await sendForward(forwardUrl, event);
    event.forwarded = result.forwarded;
    event.forwardResponse = result.forwardResponse;
    saveEvents(eventHistory);
    publishEvent(event);
  }

  res.json({ success: true, eventId: event.id, forwarded: event.forwarded });
});

app.get('/api/events', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || EVENTS_MAX;
  const items = eventHistory.slice(-limit).reverse();
  res.json({ events: items });
});

app.get('/api/config', (req, res) => {
  res.json({
    forwardUrl,
    hasAdminSecret: Boolean(ADMIN_SECRET),
    eventsMax: EVENTS_MAX,
  });
});

app.post('/api/forward', (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url = req.body.forwardUrl;
  if (typeof url !== 'string') {
    return res.status(400).json({ error: 'forwardUrl is required' });
  }

  forwardUrl = url.trim();
  res.json({ forwardUrl });
});

app.post('/api/wati/register', async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!WATI_API_TOKEN) {
    return res.status(500).json({ error: 'WATI_API_TOKEN is not configured' });
  }

  const webhooks = Array.isArray(req.body) ? req.body : req.body.webhooks;
  if (!Array.isArray(webhooks) || webhooks.length === 0) {
    return res.status(400).json({ error: 'Request body must be an array of webhook endpoint objects' });
  }

  const payload = webhooks.map((item) => ({
    phoneNumber: item.phoneNumber,
    status: Number(item.status),
    url: item.url,
    eventTypes: Array.isArray(item.eventTypes) ? item.eventTypes : [],
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

app.get('/api/wati/webhooks', async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!WATI_API_TOKEN) {
    return res.status(500).json({ error: 'WATI_API_TOKEN is not configured' });
  }

  try {
    const response = await fetch(`${WATI_API_ENDPOINT}/api/v2/webhookEndpoints`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch WATI webhooks', details: data });
    }

    return res.json(data);
  } catch (error) {
    return res.status(502).json({ error: 'Failed to reach WATI API', details: error.message });
  }
});

app.get('/events/stream', (req, res) => {
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

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function start() {
  app.listen(PORT, () => {
    console.log(`WATI webhook relay running on port ${PORT}`);
    if (forwardUrl) {
      console.log(`Forwarding incoming events to: ${forwardUrl}`);
    }
  });
}

start();
