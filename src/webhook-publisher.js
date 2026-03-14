'use strict';

const http = require('http');
const https = require('https');

const eventTypeMap = {
  raw: 'raw',
  zone: 'zoneUpdate',
  keypad: 'keypadUpdate',
  partition: 'partitionUpdate',
  zoneTimerDump: 'zoneTimerDump',
  zoneBypass: 'zoneBypassUpdate',
  system: 'systemUpdate',
  panelEvent: 'panelEvent',
  connection: 'connection',
  cid: 'realtimeCid',
  commandAck: 'commandAck'
};

const createWebhookPublisher = ({
  webhook = {},
  logging = {}
} = {}) => {
  const generateLog = typeof logging.generateLog === 'function'
    ? logging.generateLog
    : () => {};
  const generateError = typeof logging.generateError === 'function'
    ? logging.generateError
    : () => {};

  const httpExec = webhook.useHttp ? http : https;
  const enabled = Boolean(webhook.hostname && webhook.port && webhook.route);

  let webhookAuth = null;
  if (webhook.username || webhook.password) {
    webhookAuth = Buffer.from(`${webhook.username ?? ''}:${webhook.password ?? ''}`).toString('base64');
  }

  const sendWebhook = ({ eventType, payload }) => {
    if (!enabled || !eventType) {
      return;
    }

    const packetData = JSON.stringify(payload);
    const options = {
      hostname: webhook.hostname,
      port: webhook.port,
      path: `${webhook.route}${eventType}${webhook.queryString ? `?${webhook.queryString}` : ''}`,
      method: webhook.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(packetData)
      }
    };

    if (webhookAuth) {
      options.headers.Authorization = `Basic ${webhookAuth}`;
    }

    const req = httpExec.request(options, (res) => {
      const isErrorStatus = Number(res.statusCode) >= 400;
      generateLog({
        level: isErrorStatus ? 'warn' : 'info',
        caller: 'webhookPublisher::sendWebhook.response',
        message: 'Webhook response received',
        errorKey: isErrorStatus ? 'WEBHOOK_PUBLISHER_BAD_RESPONSE' : null,
        context: {
          eventType,
          statusCode: res.statusCode,
          webhookHost: webhook.hostname,
          webhookPort: webhook.port,
          webhookRoute: webhook.route,
          webhookMethod: webhook.method
        }
      });
    });

    req.on('error', (err) => {
      generateError({
        caller: 'webhookPublisher::sendWebhook.request',
        reason: 'Webhook request failed',
        errorKey: 'WEBHOOK_PUBLISHER_REQUEST_FAILED',
        err,
        includeStackTrace: true,
        context: {
          eventType,
          webhookHost: webhook.hostname,
          webhookPort: webhook.port,
          webhookRoute: webhook.route,
          webhookMethod: webhook.method
        }
      });
    });

    req.end(packetData);
  };

  const handleEvent = (event) => {
    if (!enabled) {
      return;
    }

    const eventType = eventTypeMap[event?.kind];
    if (!eventType) {
      return;
    }

    sendWebhook({
      eventType,
      payload: event.payload
    });
  };

  return {
    enabled,
    handleEvent
  };
};

module.exports = {
  createWebhookPublisher
};
