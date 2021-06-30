# Envisalink

Example code to interface with an Envisalink 4. This has only been tested on Honeywell Vista 20p security system.

Supports MQTT publish, REST APIs and webhooks.

## Environment Variables

### Envisalink
```
ENVISALINK_USER - Username of Envisalink Telnet connection
ENVISALINK_IP - IP Address of Envisalink for telnet
ENVISALINK_PORT - Port of Envisalink module
```

### MQTT
```
MQTT_PASSWORD - (Optional) Password for MQTT
MQTT_USERNAME - (Optional) Username for MQTT
MQTT_HOST - (Optional) Host of MQTT. Ensure to include the protocol. If this is not set, MQTT will not be used.
MQTT_TOPIC - (Optional, defaults to "envisalink/") MQTT Topic prefix.
```

### Webhook
```
WEBHOOK_HOSTNAME - (Optional) Hostname of webhook server. If this is not set, webhooks won't work.
WEBHOOK_PORT - (Optional, defaults to 1880) port of webhook server.
WEBHOOK_HTTP - (Optional, defaults to false) If set, use http instead of https
WEBHOOK_ROUTE - (Optional, defaults to "/"). Route on webhook server
WEBHOOK_QUERYSTRING - (Optional) Query string to place onto end of URL. If set, "?" is prepended automatically.
WEBHOOK_HTTP - (Optional, defaults to false). If set, will use http instead of https when calling the webhook.
WEBHOOK_METHOD - (Optional, defaults to "POST"). HTTP method when calling the webhook
WEBHOOK_USERNAME - (Optional) Basic Auth username to use when calling webhook
WEBHOOK_PASSWORD - (Optional) Basic Auth password to use when calling webhook
```

### REST API
```
PORT - (Optional, defaults to 3000) Port to listen to requests on
INTERFACE - (Optional, defaults to all interfaces "0.0.0.0") Interface to listen to requests on
BASIC_USERNAME - (Optional) If set, require all incoming requests to have this username and/or password in auth header
BASIC_PASSWORD - (Optional) If set, require all incoming requests to have this username and/or password in auth header
```

## Examples
```
MQTT_PASSWORD=password123 MQTT_USERNAME=envisalinkmqtt MQTT_HOST=mqtt://192.168.1.10 ENVISALINK_USER=user ENVISALINK_IP=192.168.1.11 ENVISALINK_PORT=4025 node index.js
```
