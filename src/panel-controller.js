'use strict';

const crypto = require('crypto');

const {
  buildNamedPanelCommand,
  formatPanelCommandLabel,
  getPanelCommandCode
} = require('./panel-commands');

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const normalizeStringInput = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return '';
};

const panelErrorResponses = {
  '000': { retry: false, message: 'No error' },
  '001': { retry: true, message: 'Receive buffer overrun' },
  '002': { retry: true, message: 'Receive buffer overflow' },
  '003': { retry: false, message: 'Transmit buffer overflow' },
  '010': { retry: true, message: 'Keybus transmit buffer overrun' },
  '011': { retry: false, message: 'Keybus transmit time timeout' },
  '012': { retry: false, message: 'Keybus transmit mode timeout' },
  '013': { retry: false, message: 'Keybus transmit keystring timeout' },
  '014': { retry: false, message: 'Keybus interface not functioning' },
  '015': { retry: false, message: 'Keybus busy while code-required command is running' },
  '016': { retry: false, message: 'Keybus busy due to keypad lockout' },
  '017': { retry: false, message: 'Keybus busy due to installer mode' },
  '018': { retry: false, message: 'Keybus busy for requested partition' },
  '020': { retry: false, message: 'API command syntax error' },
  '021': { retry: false, message: 'API command partition error' },
  '022': { retry: false, message: 'API command not supported' },
  '023': { retry: false, message: 'System not armed' },
  '024': { retry: false, message: 'System not ready to arm' },
  '025': { retry: false, message: 'API command invalid length' },
  '026': { retry: false, message: 'API user code not required' },
  '027': { retry: false, message: 'API invalid characters in command' }
};

const createPanelController = ({
  config,
  logging = {}
} = {}) => {
  const retr = {};

  const generateLog = typeof logging.generateLog === 'function'
    ? logging.generateLog
    : () => {};
  const generateError = typeof logging.generateError === 'function'
    ? logging.generateError
    : (payload = {}) => payload.err ?? new Error(payload.reason || 'Unknown error');
  const wrapError = typeof logging.wrapError === 'function'
    ? logging.wrapError
    : (payload = {}) => generateError(payload);

  let panel = null;
  let rawDataVersion = 0;
  let zoneTimerDumpVersion = 0;
  let partitionUpdateVersion = 0;
  let systemUpdateVersion = 0;
  let lastDataReceived = null;
  let activePanelRequest = null;
  let activePanelLock = null;
  let pendingCodeRequest = null;
  const eventSnapshotLimit = 50;
  const trace = config?.trace ?? {};
  let connectionState = {
    connected: false,
    reason: 'init',
    host: config?.panel?.ip ?? null,
    port: config?.panel?.port ?? null,
    updatedAt: new Date().toISOString()
  };

  const eventSinks = new Set();
  const eventSnapshots = {
    cid: { latest: null, recent: [] },
    commandAck: { latest: null, recent: [] },
    connection: { latest: null, recent: [] },
    keypad: { latest: null, recent: [] },
    panelEvent: { latest: null, recent: [] },
    partition: { latest: null, recent: [] },
    raw: { latest: null, recent: [] },
    system: { latest: null, recent: [] },
    zone: { latest: null, recent: [] },
    zoneBypass: { latest: null, recent: [] },
    zoneTimerDump: { latest: null, recent: [] }
  };

  const cloneValue = (value) => {
    if (value === undefined) {
      return undefined;
    }

    return JSON.parse(JSON.stringify(value));
  };

  const rememberEvent = (event) => {
    if (!event?.kind) {
      return;
    }

    if (!eventSnapshots[event.kind]) {
      eventSnapshots[event.kind] = {
        latest: null,
        recent: []
      };
    }

    const entry = {
      timestamp: new Date().toISOString(),
      payload: cloneValue(event.payload)
    };

    eventSnapshots[event.kind].latest = entry;
    eventSnapshots[event.kind].recent.unshift(entry);
    if (eventSnapshots[event.kind].recent.length > eventSnapshotLimit) {
      eventSnapshots[event.kind].recent.splice(eventSnapshotLimit);
    }
  };

  const shouldTraceEvent = (kind) => {
    switch (kind) {
      case 'raw':
        return trace.rawEvents;
      case 'keypad':
        return trace.keypadEvents;
      case 'zone':
        return trace.zoneEvents;
      case 'partition':
        return trace.partitionEvents;
      case 'system':
        return trace.systemEvents;
      case 'zoneBypass':
        return trace.zoneBypassEvents;
      case 'zoneTimerDump':
        return trace.zoneTimerDumpEvents;
      case 'panelEvent':
        return trace.panelEvents;
      case 'connection':
        return trace.connectionEvents;
      case 'commandAck':
        return trace.commandAckEvents;
      case 'cid':
        return trace.cidEvents;
      default:
        return false;
    }
  };

  const traceEvent = (event) => {
    if (!event?.kind || !shouldTraceEvent(event.kind)) {
      return;
    }

    generateLog({
      level: 'debug',
      caller: `panelController::trace.${event.kind}`,
      message: 'Panel controller emitted event',
      context: {
        kind: event.kind,
        payload: event.payload
      }
    });
  };

  const parsePacketData = (panelPacket) => {
    const commandData = normalizeStringInput(panelPacket?.commandData);
    if (!commandData || commandData.length < 5) {
      return {
        commandData,
        commandType: null,
        commandParam: null,
        commandChecksum: null
      };
    }

    return {
      commandData,
      commandType: commandData.slice(0, 3),
      commandParam: commandData.slice(3, -2),
      commandChecksum: commandData.slice(-2)
    };
  };

  const parseCommandAckDetails = (panelPacket) => {
    const packet = parsePacketData(panelPacket);
    if (!packet.commandType) {
      return {
        ...packet,
        responseMessage: null,
        retrySuggested: false
      };
    }

    if (packet.commandType === '500') {
      return {
        ...packet,
        responseMessage: 'Command acknowledged',
        retrySuggested: false
      };
    }

    if (packet.commandType === '501') {
      return {
        ...packet,
        responseMessage: 'Command checksum rejected',
        retrySuggested: true
      };
    }

    if (packet.commandType === '502') {
      const errorDetails = panelErrorResponses[packet.commandParam] ?? null;
      return {
        ...packet,
        responseMessage: errorDetails?.message ?? 'Panel returned an unspecified system error',
        retrySuggested: Boolean(errorDetails?.retry)
      };
    }

    if (packet.commandType === '912') {
      return {
        ...packet,
        responseMessage: 'Command output pressed',
        retrySuggested: false
      };
    }

    return {
      ...packet,
      responseMessage: null,
      retrySuggested: false
    };
  };

  const emitEvent = (event) => {
    rememberEvent(event);
    traceEvent(event);

    eventSinks.forEach((sink) => {
      try {
        sink(event);
      } catch (err) {
        generateError({
          caller: 'panelController::emitEvent',
          reason: 'Event sink failed while processing a panel event',
          errorKey: 'PANEL_CONTROLLER_EVENT_SINK_FAILED',
          err,
          includeStackTrace: true,
          level: 'warn',
          context: {
            kind: event?.kind ?? null
          }
        });
      }
    });
  };

  const buildActivePanelLockContext = () => {
    if (!activePanelLock) {
      return {};
    }

    return {
      maxCommandsRequested: activePanelLock.maxCommands,
      commandsLeft: Math.max(0, activePanelLock.maxCommands - activePanelLock.commandsSent),
      maxTimeLeftMs: activePanelLock.commandInFlight
        ? activePanelLock.idleTimeoutMs
        : Math.max(0, activePanelLock.expiresAt - Date.now()),
      commandInFlight: activePanelLock.commandInFlight,
      acquiredAt: activePanelLock.acquiredAt,
      hasLastWill: Boolean(activePanelLock.lastWill)
    };
  };

  const buildPanelBusyPayload = () => {
    const payload = {
      error: activePanelLock ? 'Panel lock active' : 'Panel interface busy',
      activeRoute: activePanelRequest?.route ?? null
    };

    if (activePanelLock) {
      Object.assign(payload, buildActivePanelLockContext());
    }

    return payload;
  };

  const clearPanelLockTimer = () => {
    if (!activePanelLock?.timeoutHandle) {
      return;
    }

    clearTimeout(activePanelLock.timeoutHandle);
    activePanelLock.timeoutHandle = null;
  };

  const isActivePanelLockOwner = (lockId) => {
    const normalizedLockId = normalizeStringInput(lockId);
    if (!activePanelLock || !normalizedLockId) {
      return false;
    }

    return activePanelLock.lockId === normalizedLockId;
  };

  const buildCommandAckPayload = ({
    panelCommand = null,
    source = {},
    matchedPacket = null,
    success = false,
    status = null,
    error = null,
    details = {}
  } = {}) => {
    const ackDetails = parseCommandAckDetails(matchedPacket);

    return {
      timestamp: new Date().toISOString(),
      source: {
        type: source.type ?? 'unknown',
        route: source.route ?? null,
        topic: source.topic ?? null,
        ackTopic: source.ackTopic ?? null
      },
      command: panelCommand
        ? {
            type: panelCommand.type,
            name: panelCommand.command ?? null,
            code: getPanelCommandCode(panelCommand),
            label: formatPanelCommandLabel(panelCommand)
          }
        : null,
      success,
      status: status ?? (success ? 'completed' : 'failed'),
      matchedPacket: matchedPacket ?? null,
      responseType: ackDetails.commandType,
      responsePayload: ackDetails.commandParam,
      responseMessage: ackDetails.responseMessage,
      retrySuggested: ackDetails.retrySuggested,
      error: error
        ? {
            errorKey: error.errorKey ?? null,
            reason: error.reason ?? error.message ?? 'Unknown error'
          }
        : null,
      ...details
    };
  };

  const emitCommandAck = (payload) => {
    emitEvent({
      kind: 'commandAck',
      payload
    });
  };

  const clearPendingCodeRequest = () => {
    pendingCodeRequest = null;
  };

  const queuePendingCodeRequest = ({ code, panelCommand, source }) => {
    const normalizedCode = normalizeStringInput(code);
    if (!normalizedCode) {
      return;
    }

    pendingCodeRequest = {
      code: normalizedCode,
      requestedAt: new Date().toISOString(),
      requestedByCommand: formatPanelCommandLabel(panelCommand),
      source
    };

    generateLog({
      level: 'info',
      caller: 'panelController::queuePendingCodeRequest',
      message: 'Cached code for DSC follow-up prompt',
      context: {
        command: formatPanelCommandLabel(panelCommand),
        sourceType: source?.type ?? 'unknown'
      }
    });
  };

  const sendPendingCodeIfNeeded = ({ prompt }) => {
    if (!pendingCodeRequest?.code) {
      return;
    }

    const pendingCode = pendingCodeRequest;
    clearPendingCodeRequest();

    const followupCommand = buildNamedPanelCommand({
      command: 'enterCode',
      params: pendingCode.code
    });

    if (!followupCommand || followupCommand.type === 'invalid') {
      generateError({
        caller: 'panelController::sendPendingCodeIfNeeded',
        reason: 'Cached follow-up code is invalid and cannot be sent',
        errorKey: 'PANEL_CONTROLLER_PENDING_CODE_SEND_FAILED',
        context: {
          promptEvent: prompt?.event ?? null,
          requestedByCommand: pendingCode.requestedByCommand
        }
      });
      return;
    }

    retr.executePanelCommand({
      panelCommand: followupCommand,
      source: {
        type: 'internal',
        route: pendingCode.source?.route ?? null,
        topic: pendingCode.source?.topic ?? null,
        ackTopic: pendingCode.source?.ackTopic ?? null
      }
    }).catch((err) => {
      generateError({
        caller: 'panelController::sendPendingCodeIfNeeded',
        reason: 'Failed to send cached follow-up code to the panel',
        errorKey: 'PANEL_CONTROLLER_PENDING_CODE_SEND_FAILED',
        err,
        includeStackTrace: true,
        context: {
          promptEvent: prompt?.event ?? null,
          requestedByCommand: pendingCode.requestedByCommand
        }
      });
    });
  };

  const executePanelLockLastWill = async ({ reason } = {}) => {
    if (!activePanelLock?.lastWill) {
      return;
    }

    const cleanupCommand = activePanelLock.lastWill;
    const cleanupLabel = formatPanelCommandLabel(cleanupCommand);
    try {
      await retr.executePanelCommand({
        panelCommand: cleanupCommand,
        source: {
          type: 'lockLastWill',
          route: activePanelLock.route ?? null
        }
      });

      emitCommandAck(buildCommandAckPayload({
        panelCommand: cleanupCommand,
        source: {
          type: 'lockLastWill',
          route: activePanelLock.route ?? null
        },
        success: true,
        status: 'dispatched',
        details: {
          reason
        }
      }));

      generateLog({
        level: 'info',
        caller: 'panelController::executePanelLockLastWill',
        message: 'Panel lock last will command executed',
        context: {
          reason,
          cleanupCommand: cleanupLabel
        }
      });
    } catch (err) {
      generateError({
        caller: 'panelController::executePanelLockLastWill',
        reason: 'Failed to execute panel lock last will command',
        errorKey: 'INDEX_PANEL_LOCK_LAST_WILL_FAILED',
        err,
        level: 'warn',
        context: {
          reason,
          cleanupCommand: cleanupLabel
        }
      });

      emitCommandAck(buildCommandAckPayload({
        panelCommand: cleanupCommand,
        source: {
          type: 'lockLastWill',
          route: activePanelLock.route ?? null
        },
        success: false,
        status: 'error',
        error: err,
        details: {
          reason
        }
      }));
    }
  };

  const releasePanelLock = ({ lockId, reason, route = null } = {}) => {
    if (!activePanelLock || (lockId && !isActivePanelLockOwner(lockId))) {
      return false;
    }

    const lockContext = buildActivePanelLockContext();
    clearPanelLockTimer();
    activePanelLock = null;

    generateLog({
      level: reason === 'idleTimeout' ? 'warn' : 'info',
      caller: 'panelController::releasePanelLock',
      message: 'Panel lock released',
      context: {
        route,
        reason,
        ...lockContext
      }
    });

    return true;
  };

  const schedulePanelLockTimer = ({ lockId }) => {
    if (!activePanelLock || !isActivePanelLockOwner(lockId)) {
      return;
    }

    clearPanelLockTimer();
    activePanelLock.commandInFlight = false;
    activePanelLock.expiresAt = Date.now() + activePanelLock.idleTimeoutMs;

    activePanelLock.timeoutHandle = setTimeout(() => {
      const timedOutLockId = activePanelLock?.lockId;
      if (!timedOutLockId) {
        return;
      }

      if (activePanelLock) {
        activePanelLock.commandInFlight = true;
      }

      Promise.resolve(executePanelLockLastWill({ reason: 'idleTimeout' }))
        .finally(() => {
          releasePanelLock({
            lockId: timedOutLockId,
            reason: 'idleTimeout'
          });
        });
    }, activePanelLock.idleTimeoutMs);
  };

  const ensurePanelLockAccess = ({ lockId = null, requireLock = false } = {}) => {
    if (!activePanelLock) {
      if (!requireLock) {
        return null;
      }

      return {
        statusCode: 404,
        body: {
          error: 'Panel lock not found'
        }
      };
    }

    if (lockId && isActivePanelLockOwner(lockId)) {
      return null;
    }

    return {
      statusCode: 429,
      body: buildPanelBusyPayload()
    };
  };

  const startLockedPanelCommand = ({ lockId, route }) => {
    if (!activePanelLock || !isActivePanelLockOwner(lockId)) {
      return false;
    }

    clearPanelLockTimer();
    activePanelLock.commandInFlight = true;
    activePanelLock.commandsSent += 1;

    generateLog({
      level: 'info',
      caller: 'panelController::startLockedPanelCommand',
      message: 'Panel lock command started',
      context: {
        route,
        ...buildActivePanelLockContext()
      }
    });

    return true;
  };

  const finishLockedPanelCommand = async ({ lockId, route, releaseReason = null } = {}) => {
    if (!activePanelLock || !isActivePanelLockOwner(lockId)) {
      return;
    }

    if (activePanelLock.commandsSent >= activePanelLock.maxCommands) {
      await executePanelLockLastWill({
        reason: releaseReason ?? 'maxCommandsReached'
      });

      releasePanelLock({
        lockId,
        reason: releaseReason ?? 'maxCommandsReached',
        route
      });
      return;
    }

    schedulePanelLockTimer({ lockId });

    generateLog({
      level: 'info',
      caller: 'panelController::finishLockedPanelCommand',
      message: 'Panel lock command finished',
      context: {
        route,
        ...buildActivePanelLockContext()
      }
    });
  };

  const acquirePanelRequest = ({ route, source = {}, responseMatcher = null, panelCommand = null } = {}) => {
    if (activePanelRequest) {
      return null;
    }

    const token = Symbol(route || 'panelRequest');
    activePanelRequest = {
      token,
      route,
      source,
      startedAt: new Date().toISOString(),
      responseMatcher,
      matchedPacket: null,
      panelCommand
    };

    return token;
  };

  const releasePanelRequest = ({ token }) => {
    if (activePanelRequest?.token === token) {
      activePanelRequest = null;
    }
  };

  const getPanelConnectionError = ({ panelCommand, source }) =>
    wrapError({
      caller: 'panelController::executePanelCommand',
      reason: 'Envisalink client is not initialized',
      errorKey: panelCommand?.type === 'raw'
        ? 'ENVISALINK_SEND_RAW_COMMAND_NO_CONNECTION'
        : 'ENVISALINK_SEND_COMMAND_NO_CONNECTION',
      context: {
        command: formatPanelCommandLabel(panelCommand),
        sourceType: source?.type ?? 'unknown'
      }
    });

  retr.addEventSink = (sink) => {
    if (typeof sink !== 'function') {
      return () => {};
    }

    eventSinks.add(sink);
    return () => {
      eventSinks.delete(sink);
    };
  };

  retr.setPanel = (nextPanel) => {
    panel = nextPanel;
    return panel;
  };

  retr.getPanel = () => panel;

  retr.isPanelConnected = () => Boolean(panel?.isConnected?.());

  retr.getLastDataReceived = () => {
    if (!lastDataReceived) {
      return null;
    }

    return JSON.parse(JSON.stringify(lastDataReceived));
  };

  retr.getZonesState = () => panel?.getZonesState?.() ?? {};

  retr.getPartitionState = () => panel?.getPartitionState?.() ?? {};

  retr.getSystemState = () => panel?.getSystemState?.() ?? {};

  retr.getHistory = () => panel?.getHistory?.() ?? {};

  retr.getEventKinds = () => Object.keys(eventSnapshots);

  retr.getEventSnapshot = ({ kind, limit = 10 } = {}) => {
    const snapshot = eventSnapshots[kind];
    if (!snapshot) {
      return null;
    }

    return {
      kind,
      latest: cloneValue(snapshot.latest),
      recent: cloneValue(snapshot.recent.slice(0, limit))
    };
  };

  retr.getEventSnapshots = ({ kinds = null, limit = 10 } = {}) => {
    const availableKinds = retr.getEventKinds();
    const selectedKinds = Array.isArray(kinds) && kinds.length > 0
      ? kinds.filter((kind) => availableKinds.includes(kind))
      : availableKinds;

    const snapshots = {};
    selectedKinds.forEach((kind) => {
      snapshots[kind] = retr.getEventSnapshot({ kind, limit });
    });

    return {
      limit,
      availableKinds,
      events: snapshots
    };
  };

  retr.getActivePanelLockContext = () => buildActivePanelLockContext();

  retr.buildPanelBusyPayload = () => buildPanelBusyPayload();

  retr.buildCommandAckPayload = buildCommandAckPayload;

  retr.emitCommandAck = emitCommandAck;

  retr.executePanelCommand = async ({ panelCommand, source = {} } = {}) => {
    if (!panel) {
      throw getPanelConnectionError({ panelCommand, source });
    }

    let result;
    if (panelCommand?.type === 'raw') {
      result = await panel.sendRawCommand({
        data: panelCommand.data,
        includeChecksum: panelCommand.includeChecksum,
        includeTerminators: panelCommand.includeTerminators
      });
    } else {
      result = await panel.sendCommand({
        command: panelCommand?.command,
        params: panelCommand?.params
      });
    }

    if (panelCommand?.followupCode) {
      queuePendingCodeRequest({
        code: panelCommand.followupCode,
        panelCommand,
        source
      });
    }

    return result;
  };

  retr.acquirePanelLock = ({ maxCommands, lastWill = null, route = '/lock' } = {}) => {
    const parsedMaxCommands = Number.parseInt(maxCommands, 10);
    if (!Number.isFinite(parsedMaxCommands) || parsedMaxCommands < 1) {
      return {
        statusCode: 400,
        body: {
          error: 'Body requires a positive integer maxCommands'
        }
      };
    }

    if (parsedMaxCommands > config.api.panelLockMaxCommandsLimit) {
      return {
        statusCode: 400,
        body: {
          error: `maxCommands exceeds configured limit of ${config.api.panelLockMaxCommandsLimit}`
        }
      };
    }

    if (activePanelLock || activePanelRequest) {
      return {
        statusCode: 429,
        body: buildPanelBusyPayload()
      };
    }

    const lockId = crypto.randomBytes(16).toString('hex');
    activePanelLock = {
      lockId,
      route,
      maxCommands: parsedMaxCommands,
      commandsSent: 0,
      idleTimeoutMs: config.api.panelLockIdleTimeoutMs,
      commandInFlight: false,
      acquiredAt: new Date().toISOString(),
      expiresAt: Date.now() + config.api.panelLockIdleTimeoutMs,
      timeoutHandle: null,
      lastWill
    };

    schedulePanelLockTimer({ lockId });

    generateLog({
      level: 'info',
      caller: 'panelController::acquirePanelLock',
      message: 'Panel lock acquired',
      context: {
        route,
        ...buildActivePanelLockContext()
      }
    });

    return {
      statusCode: 200,
      body: {
        lockId,
        ...buildActivePanelLockContext()
      }
    };
  };

  retr.releasePanelLockRequest = ({ lockId, route = '/lock/:lockId' } = {}) => {
    const lockAccessResponse = ensurePanelLockAccess({
      lockId,
      requireLock: true
    });
    if (lockAccessResponse) {
      return lockAccessResponse;
    }

    if (activePanelRequest) {
      return {
        statusCode: 429,
        body: buildPanelBusyPayload()
      };
    }

    releasePanelLock({
      lockId,
      reason: 'releasedByClient',
      route
    });

    return {
      statusCode: 200,
      body: {
        released: true
      }
    };
  };

  retr.runExclusivePanelCommand = async ({
    route,
    panelCommand,
    timeout = 500,
    lockId = null,
    source = {},
    responseMatcher = null,
    prepareWaitState = null,
    isResponseReady = null,
    buildSuccessResponse,
    buildTimeoutResponse
  } = {}) => {
    const lockAccessResponse = ensurePanelLockAccess({
      lockId,
      requireLock: Boolean(lockId)
    });
    if (lockAccessResponse) {
      return lockAccessResponse;
    }

    const token = acquirePanelRequest({
      route,
      source,
      responseMatcher,
      panelCommand
    });
    if (!token) {
      return {
        statusCode: 429,
        body: buildPanelBusyPayload()
      };
    }

    const startingRawDataVersion = rawDataVersion;
    const waitState = typeof prepareWaitState === 'function'
      ? prepareWaitState()
      : startingRawDataVersion;

    if (lockId) {
      startLockedPanelCommand({ lockId, route });
    }

    try {
      await retr.executePanelCommand({
        panelCommand,
        source
      });

      const startedAt = Date.now();
      let matchedPacket = null;
      while ((Date.now() - startedAt) <= timeout) {
        matchedPacket = activePanelRequest?.token === token
          ? activePanelRequest.matchedPacket
          : matchedPacket;

        const responseReady = typeof isResponseReady === 'function'
          ? isResponseReady(waitState)
          : typeof responseMatcher === 'function'
            ? Boolean(matchedPacket)
            : rawDataVersion > startingRawDataVersion;

        if (responseReady) {
          await finishLockedPanelCommand({ lockId, route });
          releasePanelRequest({ token });

          emitCommandAck(buildCommandAckPayload({
            panelCommand,
            source,
            matchedPacket,
            success: true
          }));

          return {
            statusCode: 200,
            body: buildSuccessResponse({
              matchedPacket,
              waitState
            })
          };
        }

        await sleep(50);
      }

      matchedPacket = activePanelRequest?.token === token
        ? activePanelRequest.matchedPacket
        : matchedPacket;

      await finishLockedPanelCommand({ lockId, route });
      releasePanelRequest({ token });

      emitCommandAck(buildCommandAckPayload({
        panelCommand,
        source,
        matchedPacket,
        success: false,
        status: 'timeout',
        details: {
          timeoutMs: timeout
        }
      }));

      return {
        statusCode: 200,
        body: buildTimeoutResponse({
          matchedPacket,
          waitState
        })
      };
    } catch (err) {
      await finishLockedPanelCommand({
        lockId,
        route,
        releaseReason: 'commandFailed'
      });
      releasePanelRequest({ token });

      emitCommandAck(buildCommandAckPayload({
        panelCommand,
        source,
        success: false,
        status: 'error',
        error: err
      }));

      if (!['ENVISALINK_SEND_COMMAND_NO_CONNECTION', 'ENVISALINK_SEND_RAW_COMMAND_NO_CONNECTION'].includes(err?.errorKey)) {
        throw err;
      }

      generateError({
        caller: 'panelController::runExclusivePanelCommand',
        reason: 'Failed to send command because the Envisalink connection is unavailable',
        errorKey: 'INDEX_ENVISALINK_CONNECTION_UNAVAILABLE',
        err,
        level: 'warn',
        context: {
          route,
          panelCommand: formatPanelCommandLabel(panelCommand),
          envisalinkConnected: retr.isPanelConnected()
        }
      });

      return {
        statusCode: 503,
        body: {
          error: 'Envisalink connection unavailable',
          service: 'envisalink',
          connected: false
        }
      };
    }
  };

  retr.getConnectionSnapshot = ({ mqtt = null } = {}) => {
    const snapshot = {
      connected: retr.isPanelConnected(),
      ip: config.panel.ip,
      port: config.panel.port,
      connectionState,
      hasMasterCode: Boolean(config.panel.masterCode),
      hasInstallerCode: Boolean(config.panel.installerCode),
      panelRequestInFlight: Boolean(activePanelRequest),
      panelRequestRoute: activePanelRequest?.route ?? null,
      panelRequestStartedAt: activePanelRequest?.startedAt ?? null,
      panelLockActive: Boolean(activePanelLock),
      panelLock: buildActivePanelLockContext()
    };

    if (mqtt?.enabled || mqtt?.host || mqtt?.connected) {
      snapshot.mqttConnected = Boolean(mqtt?.connected);
      snapshot.mqttHost = mqtt?.host ?? '';
      snapshot.mqttParentTopic = mqtt?.parentTopic ?? '';
      snapshot.mqttCommandTopic = mqtt?.cmndRoot ?? '';
    }

    return snapshot;
  };

  retr.callbacks = {
    onError: (err) => {
      generateError({
        caller: 'panelController::callbacks.onError',
        reason: 'Envisalink callback reported an error',
        errorKey: 'INDEX_ENVISALINK_CALLBACK_ERROR',
        err,
        includeStackTrace: true
      });
    },
    onRawData: (data) => {
      rawDataVersion += 1;
      lastDataReceived = data;

      if (activePanelRequest && !activePanelRequest.matchedPacket) {
        const packet = parsePacketData(data);
        const isPanelError = ['501', '502'].includes(packet.commandType);
        const isCommandOutputConfirmation = activePanelRequest.panelCommand?.command === 'commandOutput'
          && packet.commandType === '912';
        const isMatcherMatch = typeof activePanelRequest.responseMatcher === 'function'
          ? activePanelRequest.responseMatcher(data)
          : false;

        if (isPanelError || isCommandOutputConfirmation || isMatcherMatch) {
          activePanelRequest.matchedPacket = data;
        }
      }

      emitEvent({
        kind: 'raw',
        payload: data
      });
    },
    zoneUpdateCb: (data) => {
      emitEvent({
        kind: 'zone',
        payload: data
      });
    },
    keypadUpdateCb: (data) => {
      emitEvent({
        kind: 'keypad',
        payload: data
      });
    },
    partitionUpdateCb: (data) => {
      partitionUpdateVersion += 1;
      emitEvent({
        kind: 'partition',
        payload: data
      });
    },
    zoneTimerDumpCb: (data) => {
      zoneTimerDumpVersion += 1;
      emitEvent({
        kind: 'zoneTimerDump',
        payload: data
      });
    },
    systemUpdateCb: (data) => {
      systemUpdateVersion += 1;
      emitEvent({
        kind: 'system',
        payload: data
      });

      if (['codeRequired', 'masterCodeRequired', 'installerCodeRequired'].includes(data?.event)) {
        sendPendingCodeIfNeeded({
          prompt: data
        });
      }
    },
    zoneBypassUpdateCb: (data) => {
      emitEvent({
        kind: 'zoneBypass',
        payload: data
      });
    },
    panelEventCb: (data) => {
      emitEvent({
        kind: 'panelEvent',
        payload: data
      });
    },
    connectionStateCb: (data) => {
      connectionState = {
        ...connectionState,
        ...data,
        updatedAt: new Date().toISOString()
      };

      emitEvent({
        kind: 'connection',
        payload: connectionState
      });
    },
    realTimeCidCb: (data) => {
      emitEvent({
        kind: 'cid',
        payload: data
      });
    }
  };

  retr.getVersions = () => ({
    rawDataVersion,
    zoneTimerDumpVersion,
    partitionUpdateVersion,
    systemUpdateVersion
  });

  return retr;
};

module.exports = {
  createPanelController
};
