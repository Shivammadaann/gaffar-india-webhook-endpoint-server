const fs = require('fs');
const path = require('path');

const storePath = path.resolve(process.cwd(), 'automations.json');

const defaultPhonePaths = [
  'body.billing.phone',
  'body.shipping.phone',
  'body.customer.phone',
  'body.customer_phone',
  'body.phone',
  'body.data.customer_phone',
  'body.data.phone',
  'body.order.customer_phone',
  'body.consignee_phone',
  'body.awb_data.customer_phone',
];

const defaultAutomations = {
  version: 1,
  rules: [
    {
      id: 'woocommerce-sync-customer',
      name: 'WooCommerce - sync customer to WATI',
      description: 'Adds or updates the WooCommerce customer as a WATI contact when order events arrive.',
      enabled: true,
      source: 'woocommerce',
      eventTypes: ['order.created', 'order.updated'],
      conditions: [],
      actions: [
        {
          id: 'add-wati-contact',
          type: 'wati_contact',
          enabled: true,
          phonePaths: defaultPhonePaths,
          namePaths: ['body.billing.first_name', 'body.billing.last_name'],
          customParams: [
            { name: 'platform', value: 'WooCommerce' },
            { name: 'order_id', path: 'body.id' },
            { name: 'order_number', path: 'body.number' },
            { name: 'order_status', path: 'body.status' },
            { name: 'email', path: 'body.billing.email' },
          ],
        },
      ],
    },
    {
      id: 'woocommerce-order-created-message',
      name: 'WooCommerce - order created WhatsApp template',
      description: 'Sends a WATI template when a WooCommerce order is created. Enable after adding your approved template name.',
      enabled: true,
      source: 'woocommerce',
      eventTypes: ['order.created'],
      conditions: [],
      actions: [
        {
          id: 'send-order-created-template',
          type: 'wati_template',
          enabled: false,
          templateName: '',
          broadcastName: 'WooCommerce Order Created {{body.id}}',
          phonePaths: defaultPhonePaths,
          parameters: [
            { name: 'customer_name', paths: ['body.billing.first_name', 'body.shipping.first_name'], fallback: 'Customer' },
            { name: 'order_id', paths: ['body.number', 'body.id'] },
            { name: 'order_total', path: 'body.total' },
          ],
        },
      ],
    },
    {
      id: 'woocommerce-order-updated-message',
      name: 'WooCommerce - order status update WhatsApp template',
      description: 'Sends a WATI template when WooCommerce order status changes. Enable after adding your approved template name.',
      enabled: true,
      source: 'woocommerce',
      eventTypes: ['order.updated'],
      conditions: [],
      actions: [
        {
          id: 'send-order-updated-template',
          type: 'wati_template',
          enabled: false,
          templateName: '',
          broadcastName: 'WooCommerce Order Updated {{body.id}}',
          phonePaths: defaultPhonePaths,
          parameters: [
            { name: 'customer_name', paths: ['body.billing.first_name', 'body.shipping.first_name'], fallback: 'Customer' },
            { name: 'order_id', paths: ['body.number', 'body.id'] },
            { name: 'order_status', path: 'body.status' },
          ],
        },
      ],
    },
    {
      id: 'woocommerce-abandoned-cart-message',
      name: 'WooCommerce - abandoned cart WhatsApp template',
      description: 'Handles abandoned cart events when an abandoned-cart plugin posts them to this app.',
      enabled: true,
      source: 'woocommerce',
      eventTypes: ['cart.abandoned', 'abandoned_cart', 'abandoned.cart'],
      conditions: [],
      actions: [
        {
          id: 'send-abandoned-cart-template',
          type: 'wati_template',
          enabled: false,
          templateName: '',
          broadcastName: 'WooCommerce Abandoned Cart {{body.id}}',
          phonePaths: defaultPhonePaths,
          parameters: [
            { name: 'customer_name', paths: ['body.billing.first_name', 'body.customer.first_name'], fallback: 'Customer' },
            { name: 'cart_total', paths: ['body.total', 'body.cart_total'] },
            { name: 'checkout_url', paths: ['body.checkout_url', 'body.recover_url'] },
          ],
        },
      ],
    },
    {
      id: 'woocommerce-product-inventory',
      name: 'WooCommerce - product inventory event',
      description: 'Captures product changes for inventory workflows. Add a template or HTTP action if you want this to trigger something.',
      enabled: true,
      source: 'woocommerce',
      eventTypes: ['product.created', 'product.updated', 'product.deleted'],
      conditions: [],
      actions: [],
    },
    {
      id: 'shiprocket-out-for-delivery',
      name: 'Shiprocket - out for delivery WhatsApp template',
      description: 'Sends a WATI template when a shipment goes out for delivery. Enable after adding your approved template name.',
      enabled: true,
      source: 'shipping',
      eventTypes: [],
      conditions: [
        {
          paths: ['body.status', 'body.current_status', 'body.shipment_status', 'body.awb_status', 'body.data.status'],
          operator: 'containsAny',
          value: ['out for delivery', 'ofd'],
        },
      ],
      actions: [
        {
          id: 'send-out-for-delivery-template',
          type: 'wati_template',
          enabled: false,
          templateName: '',
          broadcastName: 'Shiprocket Out For Delivery {{body.awb}}',
          phonePaths: defaultPhonePaths,
          parameters: [
            { name: 'customer_name', paths: ['body.customer_name', 'body.data.customer_name'], fallback: 'Customer' },
            { name: 'order_id', paths: ['body.order_id', 'body.data.order_id'] },
            { name: 'awb', paths: ['body.awb', 'body.awb_code', 'body.data.awb'] },
            { name: 'tracking_url', paths: ['body.tracking_url', 'body.data.tracking_url'] },
          ],
        },
      ],
    },
    {
      id: 'shiprocket-failed-delivery',
      name: 'Shiprocket - failed delivery/NDR/RTO WhatsApp template',
      description: 'Sends a WATI template when Shiprocket flags failed delivery, NDR, or RTO. Enable after adding your approved template name.',
      enabled: true,
      source: 'shipping',
      eventTypes: [],
      conditions: [
        {
          paths: ['body.status', 'body.current_status', 'body.shipment_status', 'body.awb_status', 'body.data.status'],
          operator: 'containsAny',
          value: ['failed delivery', 'undelivered', 'ndr', 'rto'],
        },
      ],
      actions: [
        {
          id: 'send-failed-delivery-template',
          type: 'wati_template',
          enabled: false,
          templateName: '',
          broadcastName: 'Shiprocket Failed Delivery {{body.awb}}',
          phonePaths: defaultPhonePaths,
          parameters: [
            { name: 'customer_name', paths: ['body.customer_name', 'body.data.customer_name'], fallback: 'Customer' },
            { name: 'order_id', paths: ['body.order_id', 'body.data.order_id'] },
            { name: 'awb', paths: ['body.awb', 'body.awb_code', 'body.data.awb'] },
            { name: 'status', paths: ['body.status', 'body.current_status', 'body.data.status'] },
          ],
        },
      ],
    },
  ],
};

function cloneDefaults() {
  return JSON.parse(JSON.stringify(defaultAutomations));
}

function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.rules)) {
    return cloneDefaults();
  }

  return {
    version: Number(config.version) || 1,
    updatedAt: config.updatedAt || null,
    rules: config.rules.map((rule) => ({
      ...rule,
      id: String(rule.id || '').trim() || `rule-${Date.now()}`,
      name: String(rule.name || 'Untitled automation'),
      enabled: rule.enabled !== false,
      source: String(rule.source || '*').trim().toLowerCase(),
      eventTypes: Array.isArray(rule.eventTypes) ? rule.eventTypes : [],
      conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
      actions: Array.isArray(rule.actions) ? rule.actions : [],
    })),
  };
}

function loadAutomations() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    return cloneDefaults();
  }
}

function saveAutomations(config) {
  const normalized = normalizeConfig({
    ...config,
    updatedAt: new Date().toISOString(),
  });

  fs.writeFileSync(storePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function resetAutomations() {
  return saveAutomations(cloneDefaults());
}

module.exports = {
  cloneDefaults,
  loadAutomations,
  resetAutomations,
  saveAutomations,
};
