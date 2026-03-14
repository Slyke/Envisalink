'use strict';

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
};

const parsePositiveInteger = (value, defaultValue) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }

  return parsed;
};

const normalizeTopicRoot = (value, fallback = 'DCS_panel') => {
  const normalized = String(value ?? fallback).trim().replace(/^\/+|\/+$/g, '');
  return normalized || fallback;
};

const loadConfig = (env = process.env) => ({
  server: {
    listenPort: env.API_PORT ?? env.PORT ?? '8192',
    listenInterface: env.API_INTERFACE ?? env.INTERFACE ?? '0.0.0.0'
  },
  auth: {
    username: env.BASIC_USERNAME ?? '',
    password: env.BASIC_PASSWORD ?? ''
  },
  mqtt: {
    host: env.MQTT_HOST ?? '',
    username: env.MQTT_USERNAME ?? '',
    password: env.MQTT_PASSWORD ?? '',
    parentTopic: normalizeTopicRoot(env.MQTT_PARENT_TOPIC ?? env.MQTT_TOPIC, 'DCS_panel'),
    enabled: Boolean(env.MQTT_HOST)
  },
  webhook: {
    hostname: env.WEBHOOK_HOSTNAME,
    port: env.WEBHOOK_PORT ?? 80,
    route: env.WEBHOOK_ROUTE ?? '/',
    queryString: env.WEBHOOK_QUERYSTRING ?? '',
    useHttp: parseBoolean(env.WEBHOOK_HTTP, false),
    method: env.WEBHOOK_METHOD ?? 'POST',
    username: env.WEBHOOK_USERNAME,
    password: env.WEBHOOK_PASSWORD
  },
  panel: {
    ip: env.ENVISALINK_IP,
    port: env.ENVISALINK_PORT,
    username: env.ENVISALINK_USER,
    password: env.ENVISALINK_PASSWORD ?? env.ENVISALINK_PASS ?? '',
    masterCode: env.MASTER_CODE ?? ''
  },
  api: {
    panelLockMaxCommandsLimit: parsePositiveInteger(env.API_LOCK_MAX_COMMANDS, 16),
    panelLockIdleTimeoutMs: parsePositiveInteger(env.API_LOCK_IDLE_TIMEOUT_MS, 1000)
  }
});

module.exports = {
  loadConfig,
  normalizeTopicRoot,
  parseBoolean,
  parsePositiveInteger
};
