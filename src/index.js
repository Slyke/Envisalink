'use strict';

const fastify = require('fastify');

const Envisalink = require('./envisalink');
const { loadConfig } = require('./config');
const { createHttpRoutes } = require('./http-routes');
const { generateError, generateLog, wrapError } = require('./logging');
const { createMqttIntegration } = require('./mqtt');
const { createPanelController } = require('./panel-controller');
const { createPanelTopics } = require('./panel-topics');
const { createWebhookPublisher } = require('./webhook-publisher');

const logging = {
  generateError,
  generateLog,
  wrapError
};

const logAuthConfigurationWarnings = (config) => {
  const warningContext = {
    basicUsernameSource: config.auth.usernameSource,
    basicPasswordSource: config.auth.passwordSource,
    basicUsernameConfigured: config.auth.username !== '',
    basicPasswordConfigured: config.auth.password !== ''
  };

  if (config.auth.usernameSource === 'defaulted' || config.auth.passwordSource === 'defaulted') {
    generateLog({
      level: 'warn',
      caller: 'index::logAuthConfigurationWarnings',
      message: 'HTTP Basic Auth env vars are unset; default credentials are active',
      context: warningContext
    });
  }

  if (config.auth.usernameSource === 'empty' || config.auth.passwordSource === 'empty') {
    generateLog({
      level: 'warn',
      caller: 'index::logAuthConfigurationWarnings',
      message: 'HTTP Basic Auth has explicitly empty credential fields',
      context: warningContext
    });
  }
};

const main = async () => {
  try {
    const config = loadConfig();
    logAuthConfigurationWarnings(config);
    const topics = createPanelTopics(config.mqtt.parentTopic);
    const controller = createPanelController({
      config,
      logging
    });

    const mqttIntegration = createMqttIntegration({
      config,
      topics,
      controller,
      logging
    });
    const webhookPublisher = createWebhookPublisher({
      webhook: config.webhook,
      logging
    });

    controller.addEventSink((event) => {
      mqttIntegration.handleEvent(event);
    });
    controller.addEventSink((event) => {
      webhookPublisher.handleEvent(event);
    });

    const panel = Envisalink({
      network: {
        host: config.panel.ip,
        port: config.panel.port
      },
      authentication: {
        user: config.panel.username,
        pass: config.panel.password
      },
      callbacks: controller.callbacks,
      runningOptions: {
        printDebug: config.trace.panelInternalDebug,
        printCommandData: config.trace.parsedPackets,
        printSendPacket: config.trace.sendFrames,
        printReceivePacket: config.trace.rawFrames
      },
      logging
    });

    controller.setPanel(panel);

    const app = fastify({
      logger: true
    });

    await app.register(createHttpRoutes({
      controller,
      config,
      mqttIntegration,
      logging
    }));

    if (config.mqtt.enabled) {
      mqttIntegration.connect();
    }

    setTimeout(() => {
      panel.connect();
    }, 500);

    const address = await app.listen(config.server.listenPort, config.server.listenInterface);
    generateLog({
      level: 'info',
      caller: 'index::main',
      message: 'HTTP server listening',
      context: {
        address,
        listenPort: config.server.listenPort,
        listenInterface: config.server.listenInterface,
        mqttParentTopic: topics.root,
        mqttCommandTopic: topics.cmndRoot,
        mqttAckTopic: topics.ackRoot,
        mqttStatTopic: topics.statRoot
      }
    });
  } catch (err) {
    generateError({
      caller: 'index::main',
      reason: 'Application startup failed',
      errorKey: 'APP_STARTUP_FAILED',
      err,
      includeStackTrace: true
    });
    process.exit(1);
  }
};

main();
