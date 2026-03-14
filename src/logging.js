'use strict';

const fs = require('fs');
const path = require('path');

const { debugAndErrors } = require('./logger');

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

const parseInteger = (value, defaultValue) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

const parseList = (value) => {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const errorFilePath = path.resolve(process.cwd(), process.env.ERROR_FILE_PATH || './src/errors.json');
const errorCodeMap = fs.existsSync(errorFilePath)
  ? JSON.parse(fs.readFileSync(errorFilePath, 'utf8'))
  : {};

const { generateLog, generateError, wrapError } = debugAndErrors({
  settings: {
    logging: {
      logTextFormat: process.env.LOG_TEXT_FORMAT,
      sinks: {
        console: {
          enabled: parseBoolean(process.env.LOG_CONSOLE_ENABLED, true),
          format: process.env.LOG_CONSOLE_FORMAT || 'text',
          levels: parseList(process.env.LOG_CONSOLE_LEVELS)
        },
        file: {
          enabled: parseBoolean(process.env.LOG_FILE_ENABLED, false),
          format: process.env.LOG_FILE_FORMAT || 'json',
          path: process.env.LOG_FILE_PATH || '',
          levels: parseList(process.env.LOG_FILE_LEVELS)
        },
        http: {
          enabled: parseBoolean(process.env.LOG_HTTP_ENABLED, false),
          url: process.env.LOG_HTTP_URL || '',
          method: process.env.LOG_HTTP_METHOD || 'POST',
          timeoutMs: parseInteger(process.env.LOG_HTTP_TIMEOUT_MS, 2500)
        }
      },
      kubernetes: {
        enabled: parseBoolean(process.env.LOG_K8S_METADATA_ENABLED, false),
        podName: process.env.K8S_POD_NAME,
        deployment: process.env.K8S_DEPLOYMENT,
        namespace: process.env.K8S_NAMESPACE,
        podIp: process.env.K8S_POD_IP,
        podIPs: parseList(process.env.K8S_POD_IPS),
        nodeName: process.env.K8S_NODE_NAME
      }
    }
  },
  errorCodeMap
});

module.exports = {
  errorCodeMap,
  errorFilePath,
  generateError,
  generateLog,
  wrapError
};
