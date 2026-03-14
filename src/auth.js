'use strict';

const crypto = require('crypto');

const safeCompare = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ''));
  const rightBuffer = Buffer.from(String(right ?? ''));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const createBasicAuth = ({
  username = '',
  password = '',
  logging = {}
} = {}) => {
  const generateError = typeof logging.generateError === 'function'
    ? logging.generateError
    : () => {};

  const validateRequest = (request) => {
    try {
      const requireUsername = username !== '';
      const requirePassword = password !== '';
      if (!requireUsername && !requirePassword) {
        return true;
      }

      const authHeader = request?.headers?.authorization;
      if (!authHeader) {
        return false;
      }

      const [scheme, encodedCredentials] = authHeader.trim().split(/\s+/, 2);
      if (scheme?.toLowerCase() !== 'basic' || !encodedCredentials) {
        return false;
      }

      const decodedAuth = Buffer.from(encodedCredentials, 'base64').toString();
      const separatorIndex = decodedAuth.indexOf(':');
      const decodedUsername = separatorIndex >= 0 ? decodedAuth.slice(0, separatorIndex) : decodedAuth;
      const decodedPassword = separatorIndex >= 0 ? decodedAuth.slice(separatorIndex + 1) : '';

      if (requireUsername && !safeCompare(decodedUsername, username)) {
        return false;
      }

      if (requirePassword && !safeCompare(decodedPassword, password)) {
        return false;
      }

      return true;
    } catch (err) {
      generateError({
        caller: 'auth::validateRequest',
        reason: 'Failed to validate authorization header',
        errorKey: 'INDEX_AUTH_VALIDATION_FAILED',
        err,
        includeStackTrace: true,
        context: {
          hasAuthorizationHeader: Boolean(request?.headers?.authorization)
        }
      });

      return false;
    }
  };

  const sendUnauthorized = (reply, delayMs = 500) =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(reply.status(401).send('Unauthorised'));
      }, delayMs);
    });

  return {
    sendUnauthorized,
    validateRequest
  };
};

module.exports = {
  createBasicAuth,
  safeCompare
};
