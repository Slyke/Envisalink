'use strict';

const { createBasicAuth } = require('./auth');
const { parsePositiveInteger } = require('./config');
const {
  buildGenericPanelCommand,
  buildKeypadCommand,
  buildMasterKeypadCommand,
  buildNamedPanelCommand,
  buildPanicCommand,
  buildPanelCommandResponseMatcher,
  buildPartitionCommand,
  buildPartitionOutputCommand,
  buildRawPanelCommand,
  formatPanelCommandLabel,
  getPanelCommandValidationError,
  normalizeStringInput
} = require('./panel-commands');

const createHttpRoutes = ({
  controller,
  config,
  mqttIntegration = null,
  logging = {}
} = {}) => {
  const generateError = typeof logging.generateError === 'function'
    ? logging.generateError
    : () => {};

  const auth = createBasicAuth({
    username: config.auth.username,
    password: config.auth.password,
    logging
  });

  const getTimeoutMs = (request) =>
    parsePositiveInteger(request?.body?.timeoutMs ?? request?.query?.timeoutMs, 500);

  const getEventLimit = (request) =>
    Math.min(parsePositiveInteger(request?.query?.limit, 10), 50);

  const getLockId = (request) =>
    normalizeStringInput(request?.body?.lockId ?? request?.query?.lockId);

  const getEventKinds = (request) => {
    const queryKinds = normalizeStringInput(request?.query?.kinds);
    if (!queryKinds) {
      return null;
    }

    return queryKinds
      .split(',')
      .map((kind) => normalizeStringInput(kind))
      .filter(Boolean);
  };

  const validatePanelCommand = (panelCommand, missingMessage) => {
    const validationError = getPanelCommandValidationError(panelCommand);
    if (validationError) {
      return {
        statusCode: 400,
        body: {
          error: validationError
        }
      };
    }

    if (!panelCommand) {
      return {
        statusCode: 400,
        body: {
          error: missingMessage
        }
      };
    }

    return null;
  };

  const replyWithResult = (reply, result) =>
    reply.status(result.statusCode).send(result.body);

  const runCommand = async ({
    reply,
    request,
    route,
    panelCommand,
    lockId = getLockId(request) || null,
    timeout = getTimeoutMs(request),
    prepareWaitState = null,
    isResponseReady = null,
    buildSuccessResponse = null,
    buildTimeoutResponse = null
  }) => {
    const result = await controller.runExclusivePanelCommand({
      route,
      panelCommand,
      timeout,
      lockId,
      source: {
        type: 'http',
        route
      },
      responseMatcher: buildPanelCommandResponseMatcher(panelCommand),
      prepareWaitState,
      isResponseReady,
      buildSuccessResponse: buildSuccessResponse ?? (({ matchedPacket }) => ({
        result: matchedPacket ?? null,
        command: formatPanelCommandLabel(panelCommand)
      })),
      buildTimeoutResponse: buildTimeoutResponse ?? (() => ({
        command: formatPanelCommandLabel(panelCommand),
        error: `No reply before timeout (${timeout}ms)`
      }))
    });

    return replyWithResult(reply, result);
  };

  const authorize = async (request, reply) => {
    if (auth.validateRequest(request)) {
      return true;
    }

    await auth.sendUnauthorized(reply);
    return false;
  };

  const plugin = async (fastify) => {
    fastify.setErrorHandler((err, request, reply) => {
      generateError({
        caller: 'httpRoutes::setErrorHandler',
        reason: 'Unhandled HTTP route error',
        errorKey: 'HTTP_ROUTES_REQUEST_FAILED',
        err,
        includeStackTrace: true,
        context: {
          method: request?.method,
          url: request?.url
        }
      });

      if (!reply.sent) {
        reply.status(500).send({
          error: 'Internal server error'
        });
      }
    });

    fastify.post('/lock', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      let lastWill = null;
      if (request.body?.lastWill !== undefined) {
        lastWill = buildGenericPanelCommand(request.body.lastWill, {}, {
          masterCode: config.panel.masterCode
        });

        const validationResponse = validatePanelCommand(lastWill, 'lastWill must contain a single command payload');
        if (validationResponse) {
          return replyWithResult(reply, validationResponse);
        }
      }

      const result = controller.acquirePanelLock({
        maxCommands: request.body?.maxCommands,
        lastWill,
        route: '/lock'
      });

      return replyWithResult(reply, result);
    });

    fastify.post('/lock/:lockId/command', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildGenericPanelCommand(request.body, {}, {
        masterCode: config.panel.masterCode
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Command payload is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/lock/:lockId/command',
        panelCommand,
        lockId: request.params.lockId,
        timeout: getTimeoutMs(request),
        buildSuccessResponse: ({ matchedPacket }) => ({
          result: matchedPacket ?? null,
          command: formatPanelCommandLabel(panelCommand)
        }),
        buildTimeoutResponse: () => ({
          command: formatPanelCommandLabel(panelCommand),
          error: `No reply before timeout (${getTimeoutMs(request)}ms)`
        })
      });
    });

    fastify.delete('/lock/:lockId', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const result = controller.releasePanelLockRequest({
        lockId: request.params.lockId,
        route: '/lock/:lockId'
      });

      return replyWithResult(reply, result);
    });

    fastify.get('/zones', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildNamedPanelCommand({
        command: 'dumpZoneTimers'
      });

      return runCommand({
        reply,
        request,
        route: '/zones',
        panelCommand,
        prepareWaitState: () => controller.getVersions().zoneTimerDumpVersion,
        isResponseReady: (startingVersion) => controller.getVersions().zoneTimerDumpVersion > startingVersion,
        buildSuccessResponse: () => controller.getZonesState(),
        buildTimeoutResponse: () => controller.getZonesState()
      });
    });

    fastify.get('/partitions', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildNamedPanelCommand({
        command: 'statusReport'
      });

      return runCommand({
        reply,
        request,
        route: '/partitions',
        panelCommand,
        prepareWaitState: () => controller.getVersions().partitionUpdateVersion,
        isResponseReady: (startingVersion) => controller.getVersions().partitionUpdateVersion > startingVersion,
        buildSuccessResponse: () => controller.getPartitionState(),
        buildTimeoutResponse: () => controller.getPartitionState()
      });
    });

    fastify.get('/system', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      return reply.send(controller.getSystemState());
    });

    fastify.get('/events', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      return reply.send(controller.getEventSnapshots({
        kinds: getEventKinds(request),
        limit: getEventLimit(request)
      }));
    });

    fastify.get('/events/:kind', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const eventSnapshot = controller.getEventSnapshot({
        kind: normalizeStringInput(request.params.kind),
        limit: getEventLimit(request)
      });

      if (!eventSnapshot) {
        return reply.status(404).send({
          error: 'Unknown event kind',
          availableKinds: controller.getEventKinds()
        });
      }

      return reply.send(eventSnapshot);
    });

    fastify.post('/keypad', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildKeypadCommand(request.body);
      const validationResponse = validatePanelCommand(panelCommand, 'Keypad command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/keypad',
        panelCommand
      });
    });

    fastify.get('/keypad/:command', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildKeypadCommand(request.params.command);
      const validationResponse = validatePanelCommand(panelCommand, 'Keypad command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/keypad/:command',
        panelCommand
      });
    });

    fastify.post('/keypad/master', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildMasterKeypadCommand(request.body, {
        masterCode: config.panel.masterCode
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Keypad command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/keypad/master',
        panelCommand
      });
    });

    fastify.get('/keypad/master/:command', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildMasterKeypadCommand(request.params.command, {
        masterCode: config.panel.masterCode
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Keypad command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/keypad/master/:command',
        panelCommand
      });
    });

    fastify.get('/history', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      return reply.send(controller.getHistory());
    });

    fastify.get('/command/:command', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildGenericPanelCommand(request.params.command, {
        command: request.params.command,
        params: request.query?.params
      }, {
        masterCode: config.panel.masterCode
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/command/:command',
        panelCommand
      });
    });

    fastify.post('/command', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildGenericPanelCommand(request.body, {}, {
        masterCode: config.panel.masterCode
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Command payload is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/command',
        panelCommand
      });
    });

    fastify.post('/raw', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildRawPanelCommand(request.body ?? {});
      const validationResponse = validatePanelCommand(panelCommand, 'Body requires data, for example {"data":"008"}');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/raw',
        panelCommand
      });
    });

    fastify.get('/connection', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      return reply.send(controller.getConnectionSnapshot({
        mqtt: mqttIntegration?.getSnapshot?.()
      }));
    });

    fastify.post('/panel/time', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildNamedPanelCommand({
        command: 'setTime',
        params: request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Time payload is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/time',
        panelCommand
      });
    });

    fastify.post('/panel/broadcast/time', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildNamedPanelCommand({
        command: 'setTimeBroadcast',
        params: request.body?.enabled ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Broadcast payload is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/broadcast/time',
        panelCommand
      });
    });

    fastify.post('/panel/broadcast/temperature', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildNamedPanelCommand({
        command: 'setTemperatureBroadcast',
        params: request.body?.enabled ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Broadcast payload is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/broadcast/temperature',
        panelCommand
      });
    });

    fastify.post('/panel/panic/:type', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildPanicCommand(request.params.type);
      const validationResponse = validatePanelCommand(panelCommand, 'Panic type is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/panic/:type',
        panelCommand
      });
    });

    fastify.post('/panel/partition/:partition/arm/away', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildPartitionCommand({
        command: 'armAway',
        partition: request.params.partition,
        code: request.body?.code ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Partition arm command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/partition/:partition/arm/away',
        panelCommand
      });
    });

    fastify.post('/panel/partition/:partition/arm/stay', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildPartitionCommand({
        command: 'armStay',
        partition: request.params.partition,
        code: request.body?.code ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Partition arm command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/partition/:partition/arm/stay',
        panelCommand
      });
    });

    fastify.post('/panel/partition/:partition/arm/no-entry', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildPartitionCommand({
        command: 'armNoEntryDelay',
        partition: request.params.partition,
        code: request.body?.code ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Partition arm command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/partition/:partition/arm/no-entry',
        panelCommand
      });
    });

    fastify.post('/panel/partition/:partition/arm/with-code', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildPartitionCommand({
        command: 'armWithCode',
        partition: request.params.partition,
        code: request.body?.code ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Partition code is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/partition/:partition/arm/with-code',
        panelCommand
      });
    });

    fastify.post('/panel/partition/:partition/disarm', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildPartitionCommand({
        command: 'disarmWithCode',
        partition: request.params.partition,
        code: request.body?.code ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Partition code is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/partition/:partition/disarm',
        panelCommand
      });
    });

    fastify.post('/panel/partition/:partition/output/:output', async (request, reply) => {
      if (!(await authorize(request, reply))) {
        return;
      }

      const panelCommand = buildPartitionOutputCommand({
        partition: request.params.partition,
        output: request.params.output,
        code: request.body?.code ?? request.body
      });
      const validationResponse = validatePanelCommand(panelCommand, 'Partition output command is required');
      if (validationResponse) {
        return replyWithResult(reply, validationResponse);
      }

      return runCommand({
        reply,
        request,
        route: '/panel/partition/:partition/output/:output',
        panelCommand
      });
    });
  };

  return plugin;
};

module.exports = {
  createHttpRoutes
};
