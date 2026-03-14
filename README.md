# Envisalink

Example code to interface with an Envisalink 4 using the DSC TPI protocol.

Application code lives in `src/`. Security-system reference documents are stored in `docs/` as PDFs.

Supports MQTT publish and subscribe, REST APIs, and webhooks.

## Environment Variables
The Docker Compose files load runtime configuration from `.env`. The current application config is split between `src/config.js` and `src/logging.js`.

### Envisalink
```
ENVISALINK_USER - Username of the Envisalink Telnet connection
ENVISALINK_PASSWORD / ENVISALINK_PASS - Envisalink password
ENVISALINK_IP - IP address of the Envisalink module
ENVISALINK_PORT - Port of the Envisalink module
MASTER_CODE - (Optional) Master code used by /keypad/master and some DSC command helpers
```

### MQTT
```
MQTT_PASSWORD - (Optional) Password for MQTT
MQTT_USERNAME - (Optional) Username for MQTT
MQTT_HOST - (Optional) Host of MQTT. Ensure to include the protocol. If this is not set, MQTT will not be used.
MQTT_PARENT_TOPIC - (Optional, defaults to "DCS_panel") Parent topic for all MQTT traffic
MQTT_TOPIC - Legacy fallback for MQTT_PARENT_TOPIC
```

MQTT topic layout:
```
<parent>/CMND/# - inbound commands
<parent>/ACKC/command - outbound command acknowledgements
<parent>/ACKC/... - mirrored acknowledgement topic for MQTT-originated commands
<parent>/STAT/connection - Envisalink connection state
<parent>/STAT/mqtt - MQTT client state
<parent>/STAT/system - DSC system state
<parent>/STAT/partition[/<partition>] - partition events and retained state
<parent>/STAT/zone[/<zone>] - zone events and retained state
<parent>/STAT/zoneBypass - zone bypass bitfield updates
<parent>/STAT/zoneTimerDump - zone timer dumps
<parent>/STAT/keypad - keypad events
<parent>/STAT/raw - raw panel frames
<parent>/STAT/panelEvent - normalized panel events
<parent>/STAT/cid - realtime CID callbacks if they are ever emitted
```

DSC payload notes:
```
<parent>/STAT/keypad - keypad LED events now include decoded `flags` plus `leds` or `flashing`
                      maps for BACKLIGHT/FIRE/PROGRAM/TROUBLE/BYPASS/MEMORY/ARMED/READY,
                      along with `indicators` showing `off` / `on` / `flashing`
<parent>/STAT/partition/<partition> - retained partition state includes `keypadLeds`,
                                      `keypadFlashing`, and `keypadIndicators`
<parent>/STAT/system - verbose trouble status includes `verboseTroubleFlags`
                       (for example `telephoneLineFault`, `acPowerLost`, `lossOfTime`)
```

Example MQTT command topics:
```
<parent>/CMND/statusReport
<parent>/CMND/dumpZoneTimers
<parent>/CMND/keypad
<parent>/CMND/keypad/master
<parent>/CMND/panic/fire
<parent>/CMND/partition/1/arm/away
<parent>/CMND/partition/1/arm/stay
<parent>/CMND/partition/1/arm/no-entry
<parent>/CMND/partition/1/arm/with-code
<parent>/CMND/partition/1/disarm
<parent>/CMND/partition/1/output/2
<parent>/CMND/time
<parent>/CMND/broadcast/time
<parent>/CMND/broadcast/temperature
<parent>/CMND/raw
<parent>/CMND/command
```

Payloads may be blank, a plain string, or JSON depending on the command. Examples:
```json
{"partition":"1","code":"1234"}
{"command":"armAway","params":{"partition":"1","code":"1234"}}
{"data":"02012"}
true
```

### Webhook
```
WEBHOOK_HOSTNAME - (Optional) Hostname of webhook server. If this is not set, webhooks won't work.
WEBHOOK_PORT - (Optional, defaults to 80) Port of webhook server.
WEBHOOK_HTTP - (Optional, defaults to false) If set, use http instead of https
WEBHOOK_ROUTE - (Optional, defaults to "/"). Route on webhook server
WEBHOOK_QUERYSTRING - (Optional) Query string to place onto end of URL. If set, "?" is prepended automatically.
WEBHOOK_METHOD - (Optional, defaults to "POST"). HTTP method when calling the webhook
WEBHOOK_USERNAME - (Optional) Basic Auth username to use when calling webhook
WEBHOOK_PASSWORD - (Optional) Basic Auth password to use when calling webhook
```

### REST API
```
API_PORT / PORT - (Optional, defaults to 8192) Port to listen to requests on
API_INTERFACE / INTERFACE - (Optional, defaults to all interfaces "0.0.0.0") Interface to listen to requests on
BASIC_USERNAME - (Optional) If set, require all incoming requests to have this username and/or password in auth header
BASIC_PASSWORD - (Optional) If set, require all incoming requests to have this username and/or password in auth header
API_LOCK_MAX_COMMANDS - (Optional, defaults to 16) Upper bound for maxCommands accepted by POST /lock
API_LOCK_IDLE_TIMEOUT_MS - (Optional, defaults to 1000) Idle timeout between lock commands before the lock auto-releases
```

### Logging
```
ERROR_FILE_PATH - (Optional, defaults to "./src/errors.json") Error key map used by the structured logger
LOG_TEXT_FORMAT - (Optional) Custom text format for console/file text logs

LOG_CONSOLE_ENABLED - (Optional, defaults to true) Enable console logging
LOG_CONSOLE_FORMAT - (Optional, defaults to "text") Console log format: "text" or "json"
LOG_CONSOLE_LEVELS - (Optional) Comma-separated allowed console levels, blank means all

LOG_FILE_ENABLED - (Optional, defaults to false) Enable file logging
LOG_FILE_FORMAT - (Optional, defaults to "json") File log format: "text" or "json"
LOG_FILE_PATH - (Optional) Path for file sink output
LOG_FILE_LEVELS - (Optional) Comma-separated allowed file levels, blank means all

LOG_HTTP_ENABLED - (Optional, defaults to false) Enable HTTP log sink
LOG_HTTP_URL - (Optional) HTTP log sink URL
LOG_HTTP_METHOD - (Optional, defaults to "POST") HTTP log sink method
LOG_HTTP_TIMEOUT_MS - (Optional, defaults to 2500) HTTP log sink timeout in ms

LOG_K8S_METADATA_ENABLED - (Optional, defaults to false) Attach Kubernetes metadata to each log record
K8S_POD_NAME - (Optional) Kubernetes pod name for log metadata
K8S_DEPLOYMENT - (Optional) Kubernetes deployment name for log metadata
K8S_NAMESPACE - (Optional) Kubernetes namespace for log metadata
K8S_POD_IP - (Optional) Kubernetes pod IP for log metadata
K8S_POD_IPS - (Optional) Comma-separated Kubernetes pod IPs for log metadata
K8S_NODE_NAME - (Optional) Kubernetes node name for log metadata
```

#### API Routes:
```
GET /connection - Get current status
GET /system - Get current DSC system state
GET /events - Get recent event snapshots for raw/keypad/panel/system/etc. Query params: ?limit=10&kinds=raw,keypad,panelEvent
GET /events/<kind> - Get the latest event plus recent history for a single kind
POST /lock - Acquire a panel lock. Body: {"maxCommands":4,"lastWill":{"command":"poll"}}
POST /lock/<lockId>/command - Send one command while holding the panel lock
DELETE /lock/<lockId> - Release a held panel lock
POST /command - Send command to EVL module. Command data can be placed in the request body. Sentinels are injected automatically.
GET /command/<command> - Send command to EVL module. Command data can be placed in the route. Sentinels are injected automatically.
POST /keypad - Send keypad presses via EVL module. Command data can be placed in the request body.
GET /keypad/:command - Send keypad presses via EVL module. Command data can be placed in the route.
POST /keypad/master - Send keypad presses prefixed with MASTER_CODE
GET /keypad/master/:command - Send keypad presses prefixed with MASTER_CODE
GET /history - Get a list of data sent by the EVL module.
GET /partitions - Get details on known partitions
GET /zones - Get details on known zones
POST /raw - Send a raw command payload
POST /panel/time - Set DSC panel time, or pass "now"
POST /panel/broadcast/time - Enable or disable time broadcasts
POST /panel/broadcast/temperature - Enable or disable temperature broadcasts
POST /panel/panic/:type - Trigger fire, ambulance, or police panic
POST /panel/partition/:partition/arm/away - Arm away, optionally with {"code":"1234"}
POST /panel/partition/:partition/arm/stay - Arm stay, optionally with {"code":"1234"}
POST /panel/partition/:partition/arm/no-entry - Arm with no entry delay, optionally with {"code":"1234"}
POST /panel/partition/:partition/arm/with-code - Arm with partition plus explicit code
POST /panel/partition/:partition/disarm - Disarm with partition plus explicit code
POST /panel/partition/:partition/output/:output - Trigger a command output, optionally with {"code":"1234"}
```

## Examples
```
MQTT_PASSWORD=password123 MQTT_USERNAME=envisalinkmqtt MQTT_HOST=mqtt://192.168.1.10 MQTT_PARENT_TOPIC=DCS_panel ENVISALINK_USER=user ENVISALINK_PASSWORD=password ENVISALINK_IP=192.168.1.11 ENVISALINK_PORT=4025 node src/index.js
```

Minimal `.env` example:
```env
ENVISALINK_IP=192.168.1.11
ENVISALINK_PORT=4025
ENVISALINK_USER=user
ENVISALINK_PASSWORD=password

MQTT_HOST=mqtt://mqtt:1883
MQTT_PARENT_TOPIC=DCS_panel

API_PORT=8192
API_INTERFACE=0.0.0.0

LOG_CONSOLE_ENABLED=true
LOG_CONSOLE_FORMAT=text
LOG_K8S_METADATA_ENABLED=false
```
