'use strict';

const mqtt = require('mqtt');

const { parsePositiveInteger } = require('./config');
const {
  buildGenericPanelCommand,
  buildInstallerKeypadCommand,
  buildKeypadCommand,
  buildMasterKeypadCommand,
  buildNamedPanelCommand,
  buildPanicCommand,
  buildPanelCommandResponseMatcher,
  buildPartitionCommand,
  buildPartitionOutputCommand,
  buildRawPanelCommand,
  formatPanelCommandLabel,
  getPanelCommandValidationError
} = require('./panel-commands');
const { joinTopic } = require('./panel-topics');

const normalizeStringInput = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return '';
};

const createMqttIntegration = ({
  config,
  topics,
  controller,
  logging = {}
} = {}) => {
  const generateLog = typeof logging.generateLog === 'function'
    ? logging.generateLog
    : () => {};
  const generateError = typeof logging.generateError === 'function'
    ? logging.generateError
    : () => {};
  const trace = config?.trace ?? {};

  const mqttConfig = config.mqtt ?? {};

  let client = null;
  let connected = false;

  const buildMqttStatePayload = (reason = null, err = null) => ({
    timestamp: new Date().toISOString(),
    connected,
    reason,
    host: mqttConfig.host,
    parentTopic: topics.root,
    commandTopic: topics.cmndRoot,
    ackTopic: topics.ackRoot,
    statTopic: topics.statRoot,
    error: err
      ? {
          errorKey: err.errorKey ?? null,
          reason: err.reason ?? err.message ?? 'Unknown error'
        }
      : null
  });

  const publishTopic = (topic, payload, { retain = false } = {}) => {
    if (!client || !connected || !topic) {
      return;
    }

    if (trace.mqttEvents) {
      generateLog({
        level: 'debug',
        caller: 'mqttIntegration::publishTopic',
        message: 'Publishing MQTT message',
        context: {
          topic,
          retain,
          payload
        }
      });
    }

    client.publish(topic, JSON.stringify(payload), { retain }, (err) => {
      if (err) {
        generateError({
          caller: 'mqttIntegration::publishTopic',
          reason: 'Failed to publish MQTT message',
          errorKey: 'MQTT_INTEGRATION_PUBLISH_FAILED',
          err,
          includeStackTrace: true,
          context: {
            topic
          }
        });
      }
    });
  };

  const publishCommandAck = (payload) => {
    publishTopic(topics.ackCommand, payload);

    const ackTopic = normalizeStringInput(payload?.source?.ackTopic);
    if (ackTopic && ackTopic !== topics.ackCommand) {
      publishTopic(ackTopic, payload);
    }
  };

  const publishPanelConnectionSnapshot = () => {
    const connectionState = controller?.getConnectionSnapshot?.()?.connectionState;
    if (!connectionState) {
      return;
    }

    publishTopic(topics.statConnection, connectionState, { retain: true });
  };

  const publishZoneState = (zone, payload, { retain = true } = {}) => {
    if (zone === undefined || zone === null || payload === undefined) {
      return;
    }

    publishTopic(joinTopic(topics.statZone, zone), payload, { retain });
  };

  const publishEvent = (event) => {
    switch (event?.kind) {
      case 'raw':
        publishTopic(topics.statRaw, event.payload);
        break;

      case 'zone':
        publishTopic(topics.statZone, event.payload);
        if (event.payload?.zone !== undefined && event.payload?.zone !== null) {
          publishZoneState(event.payload.zone, event.payload?.state ?? event.payload);
        }
        break;

      case 'partition':
        publishTopic(topics.statPartition, event.payload);
        if (event.payload?.partition) {
          publishTopic(joinTopic(topics.statPartition, event.payload.partition), event.payload?.state ?? event.payload, { retain: true });
        }
        break;

      case 'system':
        publishTopic(topics.statSystem, event.payload?.state ?? event.payload, { retain: true });
        break;

      case 'keypad':
        publishTopic(topics.statKeypad, event.payload);
        break;

      case 'zoneTimerDump':
        publishTopic(topics.statZoneTimerDump, event.payload);
        Object.entries(event.payload?.zones ?? {}).forEach(([zoneKey, zoneState]) => {
          publishZoneState(zoneState?.zone ?? zoneKey, zoneState);
        });
        break;

      case 'zoneBypass':
        publishTopic(topics.statZoneBypass, event.payload);
        if (Array.isArray(event.payload?.updates)) {
          event.payload.updates.forEach((update) => {
            if (update?.zone === undefined || update?.zone === null) {
              return;
            }

            publishZoneState(
              update.zone,
              event.payload?.zones?.[String(update.zone)] ?? update
            );
          });
        }
        break;

      case 'panelEvent':
        publishTopic(topics.statPanelEvent, event.payload);
        break;

      case 'connection':
        publishTopic(topics.statConnection, event.payload, { retain: true });
        break;

      case 'cid':
        publishTopic(topics.statCid, event.payload);
        break;

      case 'commandAck':
        publishCommandAck(event.payload);
        break;

      default:
        break;
    }
  };

  const parsePayload = (messageBuffer) => {
    const text = normalizeStringInput(messageBuffer?.toString?.('utf8') ?? '');
    if (!text) {
      return '';
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      return text;
    }
  };

  const getExecutionOptions = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        lockId: '',
        timeout: 500
      };
    }

    return {
      lockId: normalizeStringInput(payload.lockId),
      timeout: Math.min(
        parsePositiveInteger(
          payload.timeoutMs ?? payload.timeout ?? payload.responseTimeoutMs,
          500
        ),
        mqttConfig.commandTimeoutMaxMs ?? 5000
      )
    };
  };

  const resolveCommandFromTopic = ({ topic, payload }) => {
    const relativeTopic = topic.startsWith(`${topics.cmndRoot}/`)
      ? topic.slice(topics.cmndRoot.length + 1)
      : '';
    const segments = relativeTopic.split('/').filter(Boolean);

    if (segments.length === 0) {
      return {
        error: 'MQTT command topic requires a command suffix'
      };
    }

    const commandRoot = segments[0];
    const secondSegment = segments[1] ?? '';
    const thirdSegment = segments[2] ?? '';
    const fourthSegment = segments[3] ?? '';

    if (commandRoot === 'command') {
      return {
        panelCommand: buildGenericPanelCommand(payload, {}, {
          masterCode: config.panel.masterCode
        })
      };
    }

    if (commandRoot === 'raw') {
      return {
        panelCommand: buildRawPanelCommand(payload)
      };
    }

    if (commandRoot === 'keypad' && secondSegment === 'master') {
      return {
        panelCommand: buildMasterKeypadCommand(payload, {
          masterCode: config.panel.masterCode
        })
      };
    }

    if (commandRoot === 'keypad' && secondSegment === 'installer') {
      return {
        panelCommand: buildInstallerKeypadCommand(payload, {
          installerCode: config.panel.installerCode
        })
      };
    }

    if (commandRoot === 'keypad') {
      return {
        panelCommand: buildKeypadCommand(payload)
      };
    }

    if (commandRoot === 'panic') {
      return {
        panelCommand: buildPanicCommand(secondSegment || payload?.type || payload)
      };
    }

    if (commandRoot === 'time') {
      return {
        panelCommand: buildNamedPanelCommand({
          command: 'setTime',
          params: payload
        })
      };
    }

    if (commandRoot === 'broadcast' && secondSegment === 'time') {
      return {
        panelCommand: buildNamedPanelCommand({
          command: 'setTimeBroadcast',
          params: payload?.enabled ?? payload
        })
      };
    }

    if (commandRoot === 'broadcast' && secondSegment === 'temperature') {
      return {
        panelCommand: buildNamedPanelCommand({
          command: 'setTemperatureBroadcast',
          params: payload?.enabled ?? payload
        })
      };
    }

    if (commandRoot === 'partition') {
      const partition = secondSegment;
      if (!partition) {
        return {
          error: 'Partition command topic requires a partition number'
        };
      }

      if (thirdSegment === 'arm' && fourthSegment === 'away') {
        return {
          panelCommand: buildPartitionCommand({
            command: 'armAway',
            partition,
            code: payload?.code ?? payload
          })
        };
      }

      if (thirdSegment === 'arm' && fourthSegment === 'stay') {
        return {
          panelCommand: buildPartitionCommand({
            command: 'armStay',
            partition,
            code: payload?.code ?? payload
          })
        };
      }

      if (thirdSegment === 'arm' && fourthSegment === 'no-entry') {
        return {
          panelCommand: buildPartitionCommand({
            command: 'armNoEntryDelay',
            partition,
            code: payload?.code ?? payload
          })
        };
      }

      if (thirdSegment === 'arm' && fourthSegment === 'with-code') {
        return {
          panelCommand: buildPartitionCommand({
            command: 'armWithCode',
            partition,
            code: payload?.code ?? payload
          })
        };
      }

      if (thirdSegment === 'disarm') {
        return {
          panelCommand: buildPartitionCommand({
            command: 'disarmWithCode',
            partition,
            code: payload?.code ?? payload
          })
        };
      }

      if (thirdSegment === 'output' && fourthSegment) {
        return {
          panelCommand: buildPartitionOutputCommand({
            partition,
            output: fourthSegment,
            code: payload?.code ?? payload
          })
        };
      }

      if (thirdSegment === 'program' && fourthSegment === 'user-code') {
        return {
          panelCommand: buildNamedPanelCommand({
            command: 'enterUserCodeProgrammingMode',
            params: {
              partition
            }
          })
        };
      }

      if (thirdSegment === 'program' && fourthSegment === 'user') {
        return {
          panelCommand: buildNamedPanelCommand({
            command: 'enterUserProgramingMode',
            params: {
              partition
            }
          })
        };
      }

      if (thirdSegment === 'keep-alive') {
        return {
          panelCommand: buildNamedPanelCommand({
            command: 'keepAlive',
            params: {
              partition
            }
          })
        };
      }
    }

    return {
      panelCommand: buildNamedPanelCommand({
        command: commandRoot,
        params: payload
      })
    };
  };

  const emitRejectedCommandAck = ({
    source,
    panelCommand = null,
    error,
    status = 'rejected',
    details = {}
  }) => {
    controller.emitCommandAck(controller.buildCommandAckPayload({
      panelCommand,
      source,
      success: false,
      status,
      details,
      error: error instanceof Error
        ? error
        : {
            reason: error
          }
    }));
  };

  const handleCommandMessage = async (topic, messageBuffer) => {
    const payload = parsePayload(messageBuffer);
    if (trace.mqttEvents) {
      generateLog({
        level: 'debug',
        caller: 'mqttIntegration::handleCommandMessage',
        message: 'Received MQTT command message',
        context: {
          topic,
          payloadType: Array.isArray(payload) ? 'array' : typeof payload
        }
      });
    }

    const source = {
      type: 'mqtt',
      route: `mqtt:${topic}`,
      topic,
      ackTopic: topics.ackTopicForCommandTopic(topic) ?? topics.ackCommand
    };

    const executionOptions = getExecutionOptions(payload);
    const resolvedCommand = resolveCommandFromTopic({
      topic,
      payload
    });

    if (resolvedCommand.error) {
      emitRejectedCommandAck({
        source,
        error: resolvedCommand.error,
        status: 'invalid'
      });
      return;
    }

    const panelCommand = resolvedCommand.panelCommand;
    const validationError = getPanelCommandValidationError(panelCommand);
    if (validationError) {
      emitRejectedCommandAck({
        source,
        panelCommand,
        error: validationError,
        status: 'invalid'
      });
      return;
    }

    if (!panelCommand) {
      emitRejectedCommandAck({
        source,
        error: 'Command payload is required',
        status: 'invalid'
      });
      return;
    }

    try {
      const result = await controller.runExclusivePanelCommand({
        route: `mqtt:${topic}`,
        panelCommand,
        timeout: executionOptions.timeout,
        lockId: executionOptions.lockId || null,
        source,
        responseMatcher: buildPanelCommandResponseMatcher(panelCommand),
        buildSuccessResponse: ({ matchedPacket }) => ({
          result: matchedPacket ?? null,
          command: formatPanelCommandLabel(panelCommand)
        }),
        buildTimeoutResponse: () => ({
          command: formatPanelCommandLabel(panelCommand),
          error: `No reply before timeout (${executionOptions.timeout}ms)`
        })
      });

      if (result.statusCode >= 400) {
        emitRejectedCommandAck({
          source,
          panelCommand,
          error: result.body?.error ?? 'Command rejected',
          status: result.statusCode === 429 ? 'busy' : 'rejected',
          details: {
            result: result.body,
            statusCode: result.statusCode
          }
        });
      }
    } catch (err) {
      generateError({
        caller: 'mqttIntegration::handleCommandMessage',
        reason: 'Unhandled error while executing MQTT command',
        errorKey: 'MQTT_INTEGRATION_INBOUND_COMMAND_FAILED',
        err,
        includeStackTrace: true,
        context: {
          topic,
          panelCommand: formatPanelCommandLabel(panelCommand)
        }
      });

      emitRejectedCommandAck({
        source,
        panelCommand,
        error: err,
        status: 'error'
      });
    }
  };

  const connect = () => {
    if (!mqttConfig.enabled) {
      return null;
    }

    client = mqtt.connect(mqttConfig.host, {
      username: mqttConfig.username,
      password: mqttConfig.password,
      rejectUnauthorized: mqttConfig.tlsRejectUnauthorized,
      will: {
        topic: topics.statMqtt,
        payload: JSON.stringify({
          ...buildMqttStatePayload('brokerDisconnect'),
          connected: false
        }),
        retain: true
      }
    });

    client.on('connect', () => {
      connected = true;
      generateLog({
        level: 'info',
        caller: 'mqttIntegration::connect',
        message: 'MQTT connected',
        context: {
          mqttHost: mqttConfig.host,
          mqttParentTopic: topics.root,
          mqttCommandTopic: topics.cmndRoot
        }
      });

      client.subscribe(topics.cmndWildcard, (err) => {
        if (err) {
          generateError({
            caller: 'mqttIntegration::connect.subscribe',
            reason: 'Failed to subscribe to MQTT command topic',
            errorKey: 'MQTT_INTEGRATION_SUBSCRIBE_FAILED',
            err,
            includeStackTrace: true,
            context: {
              topic: topics.cmndWildcard
            }
          });
          return;
        }

        publishTopic(topics.statMqtt, buildMqttStatePayload('connect'), { retain: true });
        publishPanelConnectionSnapshot();
      });
    });

    client.on('reconnect', () => {
      connected = false;
      generateLog({
        level: 'info',
        caller: 'mqttIntegration::reconnect',
        message: 'MQTT reconnecting',
        context: {
          mqttHost: mqttConfig.host
        }
      });
    });

    client.on('offline', () => {
      connected = false;
      generateLog({
        level: 'warn',
        caller: 'mqttIntegration::offline',
        message: 'MQTT client is offline',
        context: {
          mqttHost: mqttConfig.host
        }
      });
    });

    client.on('close', () => {
      connected = false;
      generateLog({
        level: 'warn',
        caller: 'mqttIntegration::close',
        message: 'MQTT connection closed',
        context: {
          mqttHost: mqttConfig.host
        }
      });
    });

    client.on('disconnect', () => {
      connected = false;
      generateLog({
        level: 'warn',
        caller: 'mqttIntegration::disconnect',
        message: 'MQTT disconnected',
        context: {
          mqttHost: mqttConfig.host
        }
      });
    });

    client.on('error', (err) => {
      generateError({
        caller: 'mqttIntegration::error',
        reason: 'MQTT client error',
        errorKey: 'MQTT_INTEGRATION_CLIENT_ERROR',
        err,
        includeStackTrace: true,
        context: {
          mqttHost: mqttConfig.host
        }
      });
    });

    client.on('message', (topic, messageBuffer) => {
      handleCommandMessage(topic, messageBuffer);
    });

    return client;
  };

  const stop = () => {
    if (!client) {
      return;
    }

    client.end(true);
    client = null;
    connected = false;
  };

  const getSnapshot = () => ({
    enabled: mqttConfig.enabled,
    connected,
    host: mqttConfig.host,
    parentTopic: topics.root,
    cmndRoot: topics.cmndRoot,
    ackRoot: topics.ackRoot,
    statRoot: topics.statRoot
  });

  return {
    connect,
    getSnapshot,
    handleEvent: publishEvent,
    publishTopic,
    stop
  };
};

module.exports = {
  createMqttIntegration
};
