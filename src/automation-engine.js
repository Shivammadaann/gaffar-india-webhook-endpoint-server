function normalizeSource(source) {
  return String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

function getByPath(root, path) {
  if (!path) return undefined;

  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  return parts.reduce((current, key) => {
    if (current === undefined || current === null) return undefined;
    return current[key];
  }, root);
}

function firstValue(root, paths) {
  const candidates = Array.isArray(paths) ? paths : [paths];

  for (const path of candidates) {
    const value = getByPath(root, path);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return undefined;
}

function stringifyValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function uniqueList(values) {
  return [...new Set(values.map((value) => stringifyValue(value).trim()).filter(Boolean))];
}

function normalizePhone(value, defaultCountryCode) {
  const digits = stringifyValue(value).replace(/\D/g, '');
  if (!digits) return '';

  const countryCode = String(defaultCountryCode || '').replace(/\D/g, '');
  if (countryCode && digits.length === 10) {
    return `${countryCode}${digits}`;
  }

  return digits;
}

function renderTemplate(value, event) {
  return stringifyValue(value).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, path) => {
    const resolved = getByPath(event, path.trim());
    return resolved === undefined || resolved === null ? '' : stringifyValue(resolved);
  });
}

function buildName(action, event) {
  if (action.name) return renderTemplate(action.name, event);

  const paths = Array.isArray(action.namePaths) ? action.namePaths : [action.namePath].filter(Boolean);
  return paths
    .map((path) => firstValue(event, path))
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .join(' ')
    .trim();
}

function buildParameters(definitions, event) {
  if (!Array.isArray(definitions)) return [];

  return definitions
    .map((definition) => {
      const rawValue = definition.value !== undefined
        ? renderTemplate(definition.value, event)
        : firstValue(event, definition.paths || definition.path);

      const value = rawValue === undefined || rawValue === null || String(rawValue).trim() === ''
        ? definition.fallback
        : rawValue;

      if (!definition.name || value === undefined || value === null || String(value).trim() === '') {
        return null;
      }

      return {
        name: String(definition.name),
        value: stringifyValue(value),
      };
    })
    .filter(Boolean);
}

function matchesTextOperator(actualValue, operator, expectedValue) {
  const actual = stringifyValue(actualValue).toLowerCase();
  const expected = Array.isArray(expectedValue)
    ? expectedValue.map((item) => stringifyValue(item).toLowerCase())
    : stringifyValue(expectedValue).toLowerCase();

  switch (operator) {
    case 'exists':
      return actualValue !== undefined && actualValue !== null && actual !== '';
    case 'notExists':
      return actualValue === undefined || actualValue === null || actual === '';
    case 'notEquals':
      return actual !== expected;
    case 'contains':
      return actual.includes(expected);
    case 'containsAny':
      return Array.isArray(expected) && expected.some((item) => actual.includes(item));
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'equals':
    default:
      return actual === expected;
  }
}

function conditionMatches(condition, event) {
  const paths = condition.paths || condition.path || [];
  const candidates = Array.isArray(paths) ? paths : [paths];
  const operator = condition.operator || 'equals';

  if (operator === 'notExists') {
    return candidates.every((path) => matchesTextOperator(getByPath(event, path), operator, condition.value));
  }

  return candidates.some((path) => matchesTextOperator(getByPath(event, path), operator, condition.value));
}

function eventTypeCandidates(event) {
  const body = event && event.body && typeof event.body === 'object' && !Array.isArray(event.body) ? event.body : {};
  const headers = event && event.headers && typeof event.headers === 'object' ? event.headers : {};
  const candidates = uniqueList([
    event && event.eventType,
    event && event.type,
    headers['x-wati-event'],
    headers['x-wc-webhook-topic'],
    headers['x-wc-webhook-event'],
    headers['x-shiprocket-event'],
    body.eventType,
    body.event_type,
    body.event,
    body.topic,
    body.action,
    body.type,
    getByPath(body, 'data.eventType'),
    getByPath(body, 'data.event_type'),
    getByPath(body, 'data.type'),
    getByPath(body, 'message.type'),
  ]);

  const source = normalizeSource(event && event.source);
  const hasMessageText = firstValue(event, [
    'body.text',
    'body.message',
    'body.data.text',
    'body.message.text',
    'body.message.body',
    'body.data.message',
  ]);

  if (source === 'wati' && hasMessageText !== undefined) {
    candidates.push('message', 'newContactMessageReceived');
  }

  return uniqueList(candidates).map((type) => type.toLowerCase());
}

function ruleMatches(rule, event) {
  if (!rule.enabled) return false;

  const source = normalizeSource(rule.source || '*');
  if (source !== '*' && source !== normalizeSource(event.source)) {
    return false;
  }

  const eventTypes = Array.isArray(rule.eventTypes) ? rule.eventTypes.filter(Boolean) : [];
  if (eventTypes.length > 0) {
    const actualTypes = eventTypeCandidates(event);
    const allowedTypes = eventTypes.map((type) => stringifyValue(type).toLowerCase());
    if (!allowedTypes.some((type) => actualTypes.includes(type))) {
      return false;
    }
  }

  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  return conditions.every((condition) => conditionMatches(condition, event));
}

function getWatiBaseUrl(env) {
  return String(env.WATI_API_ENDPOINT || 'https://live-mt-server.wati.io').replace(/\/+$/, '');
}

async function parseResponse(response) {
  const text = await response.text();

  try {
    return {
      status: response.status,
      statusText: response.statusText,
      body: text ? JSON.parse(text) : null,
    };
  } catch (error) {
    return {
      status: response.status,
      statusText: response.statusText,
      body: text.slice(0, 1000),
    };
  }
}

async function executeWatiContact(action, event, options) {
  const token = options.env.WATI_API_TOKEN;
  if (!token) return { status: 'skipped', reason: 'WATI_API_TOKEN is not configured' };

  const phone = normalizePhone(firstValue(event, action.phonePaths || action.phonePath), options.env.DEFAULT_COUNTRY_CODE || '91');
  if (!phone) return { status: 'skipped', reason: 'No phone number found for WATI contact action' };

  const customParams = buildParameters(action.customParams, event);
  const payload = {
    name: buildName(action, event) || null,
    customParams,
  };

  const response = await options.fetch(`${getWatiBaseUrl(options.env)}/api/v1/addContact/${encodeURIComponent(phone)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const parsed = await parseResponse(response);

  return {
    status: response.ok ? 'completed' : 'failed',
    phone,
    request: { customParams },
    response: parsed,
  };
}

async function executeWatiTemplate(action, event, options) {
  const token = options.env.WATI_API_TOKEN;
  if (!token) return { status: 'skipped', reason: 'WATI_API_TOKEN is not configured' };
  if (!action.templateName) return { status: 'skipped', reason: 'Template name is empty' };

  const phone = normalizePhone(firstValue(event, action.phonePaths || action.phonePath), options.env.DEFAULT_COUNTRY_CODE || '91');
  if (!phone) return { status: 'skipped', reason: 'No phone number found for WATI template action' };

  const channelNumber = action.channelNumber || options.env.WATI_CHANNEL_NUMBER || '';
  const payload = {
    template_name: action.templateName,
    broadcast_name: renderTemplate(action.broadcastName || `${action.templateName} ${event.id}`, event),
    parameters: buildParameters(action.parameters, event),
  };

  if (channelNumber) {
    payload.channel_number = channelNumber;
  }

  const response = await options.fetch(`${getWatiBaseUrl(options.env)}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const parsed = await parseResponse(response);

  return {
    status: response.ok ? 'completed' : 'failed',
    phone,
    request: {
      templateName: payload.template_name,
      broadcastName: payload.broadcast_name,
      parameters: payload.parameters,
    },
    response: parsed,
  };
}

async function executeHttpPost(action, event, options) {
  if (!action.url) return { status: 'skipped', reason: 'HTTP URL is empty' };

  const headers = {
    'Content-Type': 'application/json',
    ...(action.headers || {}),
  };
  const payload = action.payload === 'body' ? event.body : event;
  const response = await options.fetch(renderTemplate(action.url, event), {
    method: action.method || 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const parsed = await parseResponse(response);

  return {
    status: response.ok ? 'completed' : 'failed',
    response: parsed,
  };
}

async function executeAction(action, event, options) {
  if (action.enabled === false) {
    return { actionId: action.id, type: action.type, status: 'skipped', reason: 'Action is disabled' };
  }

  try {
    let result;
    if (action.type === 'wati_contact') {
      result = await executeWatiContact(action, event, options);
    } else if (action.type === 'wati_template') {
      result = await executeWatiTemplate(action, event, options);
    } else if (action.type === 'http_post') {
      result = await executeHttpPost(action, event, options);
    } else {
      result = { status: 'skipped', reason: `Unsupported action type: ${action.type}` };
    }

    return {
      actionId: action.id,
      type: action.type,
      ...result,
    };
  } catch (error) {
    return {
      actionId: action.id,
      type: action.type,
      status: 'failed',
      error: error.message,
    };
  }
}

async function runAutomations(event, config, options) {
  const rules = Array.isArray(config && config.rules) ? config.rules : [];
  const matchedRules = rules.filter((rule) => ruleMatches(rule, event));
  const results = [];

  for (const rule of matchedRules) {
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    const actionResults = [];

    for (const action of actions) {
      actionResults.push(await executeAction(action, event, options));
    }

    results.push({
      ruleId: rule.id,
      ruleName: rule.name,
      status: actionResults.some((item) => item.status === 'failed')
        ? 'failed'
        : actionResults.some((item) => item.status === 'completed')
          ? 'completed'
          : 'skipped',
      actions: actionResults,
    });
  }

  return {
    status: results.some((item) => item.status === 'failed')
      ? 'failed'
      : results.some((item) => item.status === 'completed')
        ? 'completed'
        : 'skipped',
    matchedRules: matchedRules.length,
    completedAt: new Date().toISOString(),
    results,
  };
}

module.exports = {
  runAutomations,
};
