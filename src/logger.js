'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const interpolate = (template, values, fallback = '') => {
  if (!template || typeof template !== 'string') return '';
  const isArr = Array.isArray(values);
  const pattern = isArr ? /{#([1-9][0-9]*|n)}/g : /{\$\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}/g;
  let idx = 0;

  return template.replace(pattern, (match, key) => {
    let val;
    if (isArr) {
      if (key === 'n') {
        val = values[idx];
        idx += 1;
      } else {
        val = values[Number.parseInt(key, 10) - 1];
      }
    } else {
      val = values[key];
    }
    if (val !== undefined && val !== null) return val;
    if (val === null) return '';
    return fallback === true ? match : fallback;
  });
};

const parseJsonSafe = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return value;
  }
};

const toStackString = (value) => {
  if (!value) return null;
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return String(value);
  }
};

const serializeMessage = (message) => {
  if (Array.isArray(message)) {
    const arr = message.map((item) => {
      if (typeof item === 'string') return item;
      if (item === undefined || item === null) return '';
      try {
        return JSON.stringify(item);
      } catch (_e) {
        return String(item);
      }
    });
    return { text: arr.join(' '), parts: arr };
  }

  if (typeof message === 'string') return { text: message, parts: [message] };
  if (message === undefined || message === null) return { text: '', parts: [''] };
  try {
    const str = JSON.stringify(message);
    return { text: str, parts: [str] };
  } catch (_e) {
    const str = String(message);
    return { text: str, parts: [str] };
  }
};

const ensureDir = (targetPath) => {
  if (!targetPath) return;
  const dir = path.dirname(targetPath);
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
};

const appendTextLine = (filePath, text) => {
  if (!filePath) return;
  ensureDir(filePath);
  const sanitizedMessage = String(text || '').replace(/(?<!\\)\n/g, ' ');
  fs.appendFileSync(filePath, `${sanitizedMessage}\n`);
};

const appendJsonLine = (filePath, objectValue) => {
  if (!filePath) return;
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(objectValue)}\n`);
};

const levelAllowed = (level, allowed) => {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(level);
};

const withTimeout = async (ms, fn) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const stableHex = (input, length) => {
  return crypto.createHash('sha256').update(String(input)).digest('hex').toUpperCase().slice(0, length);
};

const buildDefaultLogTextFormat = () => '[{$timestamp}] {$level} {$caller} {$correlationId} {$errorCode} {$errorKey} {$message}{$rootCause}{$errorStack}';

const debugAndErrors = ({ settings = {}, errorCodeMap = {} }) => {
  const logging = settings.logging ?? settings ?? {};
  const sinks = logging.sinks ?? {};
  const kubernetesSettings = logging.kubernetes ?? {};
  const unknownErrorCode = errorCodeMap.ERR_UNKNOWN ?? null;

  const kubernetesMeta = (() => {
    if (!kubernetesSettings.enabled) return null;
    const meta = {};
    const setIfValue = (key, value) => {
      if (!value) return;
      meta[key] = value;
    };
    setIfValue('podName', kubernetesSettings.podName);
    setIfValue('deployment', kubernetesSettings.deployment);
    setIfValue('namespace', kubernetesSettings.namespace);
    setIfValue('podIp', kubernetesSettings.podIp);
    if (Array.isArray(kubernetesSettings.podIPs) && kubernetesSettings.podIPs.length > 0) {
      meta.podIPs = kubernetesSettings.podIPs.filter(Boolean);
    }
    setIfValue('nodeName', kubernetesSettings.nodeName);
    return Object.keys(meta).length > 0 ? meta : null;
  })();

  const getErrorCode = (errorKey) => {
    if (!errorKey) return unknownErrorCode;
    const code = errorCodeMap[errorKey];
    if (code) return code;
    return unknownErrorCode;
  };

  const toRootCause = (err, rootCause) => {
    if (rootCause !== undefined && rootCause !== null) return rootCause;
    if (!err) return null;
    if (err.rootCause !== undefined && err.rootCause !== null) return err.rootCause;
    if (err instanceof Error) return err.message;
    return parseJsonSafe(err);
  };

  const normalizeErrorChain = (err) => {
    if (!err || !Array.isArray(err.errorChain)) return [];
    return err.errorChain
      .filter(Boolean)
      .map((item) => ({
        errorKey: item.errorKey || null,
        errorCode: item.errorCode || null,
        caller: item.caller || null,
        reason: item.reason || null,
        timestamp: item.timestamp || null
      }));
  };

  const postToHttpSink = async (payload, sink) => {
    if (!sink?.enabled || !sink?.url) return;
    const timeoutMs = Number.isFinite(sink.timeoutMs) ? sink.timeoutMs : 2500;
    try {
      await withTimeout(timeoutMs, (signal) =>
        fetch(sink.url, {
          method: sink.method || 'POST',
          headers: {
            'content-type': 'application/json',
            ...(sink.headers || {})
          },
          body: JSON.stringify(payload),
          signal
        })
      );
    } catch (e) {
      const errorText = toStackString(e) || 'unknown';
      console.error(`HTTP log sink failed: ${errorText}`);
    }
  };

  const logMessage = ({ level, caller, message, correlationId, errorStack, rootCause, errorCode, errorKey, errorChain, context }) => {
    const timestamp = new Date().toISOString();
    const serialized = serializeMessage(message);
    const safeLevel = level || 'info';
    const chain = Array.isArray(errorChain) ? errorChain : [];

    const logObject = {
      level: safeLevel,
      message: serialized.text,
      timestamp,
      errorKey: errorKey || undefined,
      correlationId: correlationId || undefined,
      caller: caller || 'unknown',
      rootCause: rootCause ?? undefined,
      errorStack: errorStack ?? undefined,
      errorCode: errorCode ?? undefined,
      errorChain: chain,
      context: context || undefined,
      kubernetes: kubernetesMeta || undefined
    };

    const sinkConsole = sinks.console ?? {};
    const sinkFile = sinks.file ?? {};
    const sinkHttp = sinks.http ?? {};

    const textTemplate = logging.logTextFormat || buildDefaultLogTextFormat();
    const textLine = interpolate(
      textTemplate,
      {
        ...logObject,
        correlationId: logObject.correlationId ? `[${logObject.correlationId}]` : '',
        errorCode: logObject.errorCode ? `[${logObject.errorCode}]` : '',
        errorKey: logObject.errorKey ? `[${logObject.errorKey}]` : '',
        rootCause: logObject.rootCause ? ` | rootCause=${toStackString(logObject.rootCause)}` : '',
        errorStack: logObject.errorStack ? ` | stack=${toStackString(logObject.errorStack)}` : ''
      },
      ''
    );

    if (sinkConsole.enabled && levelAllowed(safeLevel, sinkConsole.levels)) {
      if (sinkConsole.format === 'json') {
        console.log(JSON.stringify(logObject));
      } else {
        console.log(textLine);
      }
    }

    if (sinkFile.enabled && levelAllowed(safeLevel, sinkFile.levels)) {
      if (sinkFile.format === 'json') {
        appendJsonLine(sinkFile.path, logObject);
      } else {
        appendTextLine(sinkFile.path, textLine);
      }
    }

    void postToHttpSink(logObject, sinkHttp);
  };

  const generateError = ({
    caller,
    reason,
    errorKey,
    type = 'raised',
    rootCause = null,
    includeStackTrace = false,
    correlationId = null,
    level = 'error',
    err = null,
    log = true,
    context = null
  }) => {
    const errorCode = getErrorCode(errorKey);
    const priorChain = normalizeErrorChain(err);
    const entryTimestamp = new Date().toISOString();
    const currentChainEntry = {
      errorKey: errorKey || null,
      errorCode: errorCode || null,
      caller: caller || null,
      reason: reason || null,
      timestamp: entryTimestamp
    };

    const finalRootCause = toRootCause(err, rootCause);
    const stackValue = includeStackTrace ? toStackString(err) : null;

    const error = {
      rootCause: finalRootCause,
      caller: caller || 'unknown',
      reason: reason || '',
      type,
      correlationId,
      errorKey: errorKey || null,
      errorCode: errorCode || null,
      errorStack: stackValue,
      errorChain: [...priorChain, currentChainEntry],
      context: context || null,
      timestamp: entryTimestamp
    };

    if (log) {
      logMessage({
        level,
        caller,
        message: reason || '',
        correlationId,
        errorStack: error.errorStack,
        rootCause: error.rootCause,
        errorCode,
        errorKey: errorKey || null,
        errorChain: error.errorChain,
        context: error.context
      });
    }

    return error;
  };

  const wrapError = (options) => {
    return generateError({
      type: 'bubbled',
      ...options
    });
  };

  const generateLog = ({
    caller,
    message,
    level = 'debug',
    correlationId = null,
    errorKey = null,
    context = null
  }) => {
    const errorCode = errorKey ? getErrorCode(errorKey) : null;
    logMessage({
      level,
      caller,
      message,
      correlationId,
      errorCode,
      errorKey,
      errorChain: [],
      context
    });
  };

  return {
    generateError,
    wrapError,
    generateLog,
    errorCodeMap
  };
};

module.exports = { debugAndErrors, stableHex };
