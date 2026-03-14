# Logger Usage (Portable Setup)

Use this when you’ve copied the logger files into another repo and just need to wire them in.

## 1. Copy required files

Copy these files into your backend project:

- `src/logger.js`
- `err_gen.js`
- `src/errors.json`

## 2. Initialize logger at startup

```js
const fs = require('fs');
const { debugAndErrors } = require('./src/logger');

const errorCodeMap = fs.existsSync('./src/errors.json')
  ? JSON.parse(fs.readFileSync('./src/errors.json', 'utf8'))
  : {};

const { generateLog, generateError, wrapError } = debugAndErrors({
  settings: {
    logging: {
      // Optional: custom text template for non-JSON logs
      // logTextFormat: '[{$timestamp}] {$level} {$caller} {$message}',
      sinks: {
        console: { enabled: true, format: 'text', levels: [] }, // [] = all levels
        file: { enabled: false, format: 'json', path: '', levels: [] },
        http: { enabled: false, url: '', method: 'POST', timeoutMs: 2500 }
      },
      kubernetes: { enabled: false }
    }
  },
  errorCodeMap
});
```

## 3. Log normal events

```js
generateLog({
  level: 'info',
  caller: 'orders::create',
  message: 'Order created',
  correlationId,
  context: { orderId }
});
```

## 4. Generate structured errors

```js
const errObj = generateError({
  caller: 'orders::create',
  reason: 'Failed to create order',
  errorKey: 'ORDER_CREATE_FAILED',
  err, // original error
  includeStackTrace: true,
  correlationId,
  context: { orderId }
});
```

## 5. Wrap and bubble errors (keeps chain)

```js
throw wrapError({
  caller: 'routes::orders',
  reason: 'Order route failed',
  errorKey: 'ORDER_ROUTE_FAILED',
  err: errObj,
  correlationId
});
```

## 6. Add script commands to `package.json`

```json
{
  "scripts": {
    "error-add": "node err_gen.js --action add --error-file ./src/errors.json",
    "error-delete": "node err_gen.js --action delete --error-file ./src/errors.json",
    "error-rm": "node err_gen.js --action delete --error-file ./src/errors.json",
    "error-validate": "node err_gen.js --action validate --error-file ./src/errors.json"
  }
}
```

## 7. Manage error codes

- Add a key:
  ```bash
  npm run error-add -- --error-key ORDER_CREATE_FAILED
  ```
- Delete a key:
  ```bash
  npm run error-delete -- --error-key ORDER_CREATE_FAILED
  ```
- Validate map:
  ```bash
  npm run error-validate
  ```

## 8. Optional environment variables

```env
ERROR_FILE_PATH=./src/errors.json

LOG_TEXT_FORMAT=

LOG_CONSOLE_ENABLED=true
LOG_CONSOLE_FORMAT=text
LOG_CONSOLE_LEVELS=info,warn,error,debug

LOG_FILE_ENABLED=false
LOG_FILE_FORMAT=json
LOG_FILE_PATH=./logs/app.jsonl
LOG_FILE_LEVELS=warn,error

LOG_HTTP_ENABLED=false
LOG_HTTP_URL=
LOG_HTTP_METHOD=POST
LOG_HTTP_TIMEOUT_MS=2500

LOG_K8S_METADATA_ENABLED=false
K8S_POD_NAME=
K8S_DEPLOYMENT=
K8S_NAMESPACE=
K8S_POD_IP=
K8S_POD_IPS=
K8S_NODE_NAME=
```

## Notes

- `generateLog` is for standard events.
- `generateError` creates structured error objects and logs them by default.
- `wrapError` is a convenience wrapper for bubbled errors and preserves prior error chain.
- `errorKey` maps to `errorCode` via `errors.json` (fallback is `ERR_UNKNOWN` if present).
