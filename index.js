const https = require('https');
const http = require('http');
const mqtt = require('mqtt')
const { Readable } = require('stream');
const fastify = require('fastify')({
  logger: true
});

const Invisalink = require('./envisalink');

let listenPort = process.env.PORT ?? '3000';
let listenInterface = process.env.INTERFACE ?? '0.0.0.0';

let username = process.env.BASIC_USERNAME ?? '';
let password = process.env.BASIC_PASSWORD ?? '';

let mqttUsername = process.env.MQTT_USERNAME ?? '';
let mqttPassword = process.env.MQTT_PASSWORD ?? '';
let mqttHost = process.env.MQTT_HOST ?? '';
let mqttTopic = process.env.MQTT_TOPIC ?? 'envisalink';

let webhookHost = process.env.WEBHOOK_HOSTNAME;
let webhookPort = process.env.WEBHOOK_PORT ?? 80;
let webhookRoute = process.env.WEBHOOK_ROUTE ?? '/';
let webhookQueryString = process.env.WEBHOOK_QUERYSTRING ?? '';
let webhookUseHttp = process.env.WEBHOOK_HTTP === 'true' ? true : false;
let webhookMethod = process.env.METHOD ?? 'POST';
let webhookUsername = process.env.USERNAME;
let webhookPassword = process.env.PASSWORD;

const httpExec = webhookUseHttp ? http : https;
let webhookAuth;
if (webhookUsername || webhookPassword) {
  webhookAuth = Buffer.from(webhookUsername + ':' + webhookPassword).toString('base64');
}

let invisalinkIp = process.env.INVISALINK_IP;
let invisalinkPort = process.env.INVISALINK_PORT;
let invisalinkUsername = process.env.INVISALINK_USER;

let mqttConnected = false;
let mqttClient = null;

let lastDataReceived = '';
let newReceiveData = false;

const returnFriendlyTime = (givenTime) => {
  if (givenTime) {
    return new Date(givenTime).toISOString().replace(/T/, ' ').replace(/\..+/, '');
  }

  return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
}

const validateAuth = ({ request }) => {
  try {
    if (!request?.headers?.authorization) {
      return true;
    }
    const decodedAuth = Buffer.from(request.headers.authorization.split(" ")[1], 'base64').toString();
    const decodedUsername = decodedAuth?.split(':')[0] ?? '';
    const decodedPassword = decodedAuth?.split(':')[1] ?? '';

    if (username || password) {
      if (decodedUsername === username && password === decodedPassword) {
        return true;
      }
      return false;
    }

    return true;
  } catch (err) {
    console.error(err);
    return false;
  }

  return false;
};

const onError = (err) => {
  console.log('Got err', err);
};

const sendWebhook = ({ packetData, type }) => {
  const contentLength = Buffer.byteLength(packetData);
  const options = {
    hostname: webhookHost,
    port: webhookPort,
    path: `${webhookRoute}${type}${webhookQueryString ? '?' + webhookQueryString : ''}`,
    method: webhookMethod,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': contentLength
    }
  };

  if (webhookAuth) {
    options.headers['Authorization'] = `Basic ${webhookAuth}`;
  }

  const req = httpExec.request(options, (res) => {
    console.log(`${returnFriendlyTime()} | Response statusCode: ${res.statusCode}`);
  });

  const stream = Readable.from(packetData);

  stream.on('data', (data) => {
    if (req.write(data) === false) {
      stream.pause();
    }
  });

  req.on('error', (error) => {
    console.error(returnFriendlyTime(), error);
  });

  req.on('drain', (error) => {
    stream.resume();
  });

  stream.on('end', (data) => {
    (() => {
      req.end();
    })();
  });
};

const onRawData = (data) => {
  lastDataReceived = data;
  newReceiveData = true;
  if (webhookHost && webhookPort && webhookRoute) {
    sendWebhook({ packetData: JSON.stringify(data), type: 'raw'})
  }
  if (mqttConnected || mqttClient) {
    mqttClient.publish(`${mqttTopic}/raw`, JSON.stringify(data));
  }
};

const zoneUpdateCb = (data) => {
  if (webhookHost && webhookPort && webhookRoute) {
    sendWebhook({ packetData: JSON.stringify(data), type: 'zoneUpdate'})
  }
  if (mqttConnected || mqttClient) {
    mqttClient.publish(`${mqttTopic}/zoneUpdate`, JSON.stringify(data));
  }
};

const keypadUpdateCb = (data) => {
  if (webhookHost && webhookPort && webhookRoute) {
    sendWebhook({ packetData: JSON.stringify(data), type: 'keypadUpdate'})
  }
  if (mqttConnected || mqttClient) {
    mqttClient.publish(`${mqttTopic}/keypadUpdate`, JSON.stringify(data));
  }
};

const zoneTimerDumpCb = (data) => {
  if (webhookHost && webhookPort && webhookRoute) {
    sendWebhook({ packetData: JSON.stringify(data), type: 'zoneTimerDump'})
  }
  if (mqttConnected || mqttClient) {
    mqttClient.publish(`${mqttTopic}/zoneTimerDump`, JSON.stringify(data));
  }
};

const invisalink = Invisalink({
  network: {
    host: invisalinkIp,
    port: invisalinkPort
  },
  authentication: {
    user: invisalinkUsername
  },
  callbacks: {
    onError,
    onRawData,
    zoneUpdateCb,
    keypadUpdateCb,
    zoneTimerDumpCb
  },
  runningOptions: {
    printDebug: false,
    printCommandData: false,
    printSendPacket: false,
    printReceivePacket: false
  }
});

setTimeout(() => {
  invisalink.connect();
}, 500)

fastify.listen(listenPort, listenInterface, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`server listening on ${address}`);
});

if (mqttHost) {
  mqttClient = mqtt.connect(mqttHost, {
    username: mqttUsername,
    password: mqttPassword
  });

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log(`${returnFriendlyTime()} | MQTT connected ${mqttHost}`);
  });

  mqttClient.on('reconnect', () => {
    mqttConnected = true;
    console.log(`${returnFriendlyTime()} | MQTT reconnected ${mqttHost}`);
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    console.log(`${returnFriendlyTime()} | MQTT disconnected ${mqttHost}`);
  });

  mqttClient.on('disconnect', () => {
    mqttConnected = false;
    console.log(`${returnFriendlyTime()} | MQTT disconnected ${mqttHost}`);
  });

  // mqttClient.on('message', function (topic, message) {
  // message is Buffer
  //   console.log(message.toString())
  //   client.end()
  // });
}

// if (process.stdin.isTTY) {
//   process.stdin.setRawMode(true);
// }
// process.stdin.setEncoding('utf8');
// process.stdin.on('data', function (chunk) {
//   chunk = chunk.trim();
//   if (chunk === 'c' || chunk.name === 'c') {
//     process.exit();
//   }

//   if ( chunk === '\u0003' ) {
//     process.exit();
//   }
//   if (invisalink.isConnected()) {
//     if (chunk === 'z') {
//       invisalink.sendCommand({ data: '02,', includeSentinels: true });
//       console.log(invisalink.getZonesState());
//     }

//     if (chunk === 'p') {
//       console.log(invisalink.getPartitionState());
//     }

//     if (chunk === 's') {
//       const includeSentinels = true;
//       invisalink.sendCommand({ data: '00,', includeSentinels: true });
//       // invisalink.sendCommand({ data: '63', includeSentinels });
//     }
//   } else {
//     console.log('not connected');
//   }
// });
// process.stdin.resume();

fastify.get('/zones', (req, res) => {
  if (!validateAuth({ request: req })) {
    setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    invisalink.sendCommand({ data: '02,', includeSentinels: true });
    return res.send(invisalink.getZonesState());
  }
});

fastify.get('/partitions', (req, res) => {
  if (!validateAuth({ request: req })) {
    setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    return res.send(invisalink.getPartitionState());
  }
});

fastify.post('/keypad', (req, res) => {
  if (!validateAuth({ request: req })) {
    return setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    newReceiveData = false;
    invisalink.sendCommand({ data: req.body }).then(() => {
      let timeout = 500;
      const intervalPoll = 50;

      let timeoutPollCheck = 0;
      (function waitNewData () {
          if (timeoutPollCheck > timeout) {
            return res.send({
              command: req.body,
              error: `No reply before timeout (${timeout}ms)`
            });
          }
          timeoutPollCheck += intervalPoll;
          if (newReceiveData) {
            return res.send({
              result: lastDataReceived,
              command: req.body
            });
          } else {
            setTimeout(waitNewData, intervalPoll);
          }
      })();
    });
  }
});

fastify.get('/keypad/:command', (req, res) => {
  if (!validateAuth({ request: req })) {
    setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    newReceiveData = false;
    invisalink.sendCommand({ data: req.params.command }).then(() => {
      let timeout = 500;
      const intervalPoll = 50;

      let timeoutPollCheck = 0;
      (function waitNewData () {
          if (timeoutPollCheck > timeout) {
            return res.send({
              command: req.params.command,
              error: `No reply before timeout (${timeout}ms)`
            });
          }
          timeoutPollCheck += intervalPoll;
          if (newReceiveData) {
            return res.send({
              result: lastDataReceived,
              command: req.params.command
            });
          } else {
            setTimeout(waitNewData, intervalPoll);
          }
      })();
    });
  }
});

fastify.get('/history', (req, res) => {
  if (!validateAuth({ request: req })) {
    setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    return res.send({ ...invisalink.getHistory() });
  }
});

fastify.get('/command/:command', (req, res) => {
  if (!validateAuth({ request: req })) {
    return setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    newReceiveData = false;
    invisalink.sendCommand({ data: req.params.command, includeSentinels: true }).then(() => {
      let timeout = 500;
      const intervalPoll = 50;

      let timeoutPollCheck = 0;
      (function waitNewData () {
          if (timeoutPollCheck > timeout) {
            return res.send({
              command: req.params.command,
              error: `No reply before timeout (${timeout}ms)`
            });
          }
          timeoutPollCheck += intervalPoll;
          if (newReceiveData) {
            return res.send({
              result: lastDataReceived,
              command: req.params.command
            });
          } else {
            setTimeout(waitNewData, intervalPoll);
          }
      })();
    });
  }
});

fastify.post('/command', (req, res) => {
  if (!validateAuth({ request: req })) {
    return setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    newReceiveData = false;
    invisalink.sendCommand({ data: req.body, includeSentinels: true }).then(() => {
      let timeout = 500;
      const intervalPoll = 50;

      let timeoutPollCheck = 0;
      (function waitNewData () {
          if (timeoutPollCheck > timeout) {
            return res.send({
              command: req.body,
              error: `No reply before timeout (${timeout}ms)`
            });
          }
          timeoutPollCheck += intervalPoll;
          if (newReceiveData) {
            return res.send({
              result: lastDataReceived,
              command: req.body
            });
          } else {
            setTimeout(waitNewData, intervalPoll);
          }
      })();
    });
  }
});

fastify.get('/connection', (req, res) => {
  if (!validateAuth({ request: req })) {
    setTimeout(() => {
      return res.status(401).send('Unauthorised');
    }, 500);
  } else {
    const objToSend = {
      connected: invisalink.isConnected(),
      ip: invisalinkIp,
      port: invisalinkPort,
    }

    if (mqttConnected || mqttClient) {
      objToSend.mqttConnected = mqttConnected;
      objToSend.mqttHost = mqttHost;
      objToSend.mqttTopic = mqttTopic;
    }
    return res.send(objToSend);
  }
});
