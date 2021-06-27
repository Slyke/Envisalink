/*
Usage:
const Invisalink = require('./envisalink');

const onData = (data) => {
  console.log('got data', data);
}

const onError = (err) => {
  console.log('got err', err);
}

const invisalink = Invisalink({
  network: {
    host: '192.168.1.5',
    port: 4025 // Optional
  },
  authentication: {
    user: 'user'
  },
  callbacks: {
    onError, // Mandatory, for handling errors
    onRawData, // onRawData for handling raw packet data. (Params: { commandData, dataBuffer, bufferIndex })
    zoneUpdateCb,
    keypadUpdateCb,
    partitionUpdateCb,
    realTimeCidCb,
    zoneTimerDumpCb
  },
  runningOptions: { // For debugging, all optional
    printDebug: true,
    printCommandData: true,
    printSendPacket: true
  }
});

invisalink.connect();
if (invisalink.isConnected) {
  invisalink.sendCommand({ data: '01,00,', includeSentinels: false, includeChecksum: false });
}

invisalink.getZonesState()
invisalink.getPartitionState()
invisalink.printDebug()


// */

const nwTcp = require('net');

const Invisalink = ({
  network,
  authentication,
  defaultCallbackHandlers = {},
  callbacks,
  runningOptions
} = {}) => {
  const retr = {};

  const connectionOptions = {
    ...network
  };

  const auth = {
    ...authentication
  };

  const parsedCallbacks = {
    ...callbacks
  };

  const options = {
    ...runningOptions
  };
  let zones = {};
  const partitions = {};

  const historyLimit = 5;
  const historyLog = {};

  const partitionStateFields = {
    alarm: false,
    alarmInMemory: false,
    armedAway: false,
    acPresent: false,
    bypassed: false,
    chime: false,
    notUsed1: null,
    armedZeroDelay: false,
    fireZoneAlarm: false,
    systemTrouble: false,
    notUsed2: null,
    notUsed3: null,
    ready: false,
    fire: false,
    lowBattery: false,
    armedStay: false
  };

  const bitfieldMap = [
    'alarm',
    'alarmInMemory',
    'armedAway',
    'acPresent',
    'bypassed',
    'chime',
    'notUsed1',
    'armedZeroDelay',
    'fireZoneAlarm',
    'systemTrouble',
    'notUsed2',
    'notUsed3',
    'ready',
    'fire',
    'lowBattery',
    'armedStay'
  ];

  const keypadBeeps = {
    '00' : 'off',
    '01' : 'beep 1 time',
    '02' : 'beep 2 times',
    '03' : 'beep 3 times',
    '04' : 'continous fast beep',
    '05' : 'continuous slow beep'
  };

  let shouldReconnect = true;
  let activeConnection = null;
  let pollTimer = null;
  let cbs = {};
  
  const printDebug = (message) => {
    if (options.printDebug) {
      console.log(message);
    }
  };

  const appendHistory = ({ commandType, data }) => {
    if (!Array.isArray(historyLog[commandType])) {
      historyLog[commandType] = [];
    }

    historyLog[commandType].unshift({
      eventTime: retr.returnFriendlyTime(),
      data: data
    })

    if (historyLog[commandType].length > historyLimit) {
      historyLog[commandType].splice(historyLimit, historyLog[commandType].length);
    }
  };

  const printReceivePacket = (packetData) => {
    if (options.printReceivePacket) {
      console.log(packetData);
    }
  };

  const printSendPacket = (packetData) => {
    if (options.printSendPacket) {
      console.log(packetData);
    }
  };

  const printCommandData = (packetData) => {
    if (options.printCommandData) {
      console.log(packetData);
    }
  };

  const connOnError = (err) => {
    console.log(err);
  };
  
  const connOnEnd = (param) => {
    console.log('End', param);
  };
  
  const connOnClose = (hadErr) => {
    clearInterval(pollTimer);
    console.log('Closed', hadErr);
    setTimeout(() => {
      if (shouldReconnect && (!activeConnection || activeConnection.destroyed)) {
        retr.connect()
      }
    }, 5000);
  };
  
  const loginResponse = (data) => {
    printDebug(`[Debug] [loginResponse()]: Processing Login...`);
    const loginStatus = data;
    if (loginStatus === 'FAILED') {
      printDebug(`[Debug] [loginResponse()]: Login Failed: 'Bad Password'`);
      throw new Error(JSON.stringify({
        error: 'login failed',
        reason: 'bad credentials'
      }));
    } else if (loginStatus === 'OK') {
      printDebug(`[Debug] [loginResponse()]: Login Success`);
      retr.sendCommand({ data: '001' })
      clearInterval(pollTimer);
      pollTimer = setInterval(function () {
        retr.sendCommand({ data: '000' });
      }, 60000);
    } else if (loginStatus === 'Timed Out!') {
      printDebug(`[Debug] [loginResponse()]: Login Failed: 'Password timeout'`);
      throw new Error(JSON.stringify({
        error: 'login failed',
        reason: 'password not entered in time'
      }));
    } else if (loginStatus === 'Login:') {
      printDebug(`[Debug] [loginResponse()]: Sending authentication credentials`);
      retr.sendCommand({ data: auth.user })
    }
  };
  
  const connOnData = (data) => {
    const dataBuffer = data.toString().replace(/[\n\r]/g, '|').split('|');
    printDebug(`[Debug] [connOnData()]: Commands received: '${dataBuffer.length}'`);
    printReceivePacket(`Data received: '${dataBuffer}'`);

    for (let i = 0; i < dataBuffer.length; i++) {
      const commandData = dataBuffer[i];
      if (commandData !== '') {
        retr.parseIncoming({ commandData });

        if (typeof(parsedCallbacks.onRawData) === 'function') {
          parsedCallbacks.onRawData({ commandData, dataBuffer, bufferIndex: i });
        }
      
        printCommandData(`Command data: '${commandData}'`);
        if (commandData) { // TODO: Add protocol checking
          if (commandData === '' || commandData === 0) {
          } else {
            if (commandData.trim() === 'Login:') {
              loginResponse(commandData);
            } else {
              // console.log('datarec:', commandData);
            }
          }
        }
      }
    }
  };

  retr.sendCommand = ({ data, includeChecksum = false, includeSentinels = false }) => {
    return new Promise((resolve, reject) => {
      if (retr.isConnected()) {
        let checksum = 0
        for (let i = 0; i < data.length; i++) {
          checksum += data.charCodeAt(i);
        }
      
        checksum = checksum.toString(16).slice(-2).toUpperCase();
        let sendData = data;

        if (includeSentinels) {
          sendData = '^' + sendData + '$';
        }

        if (includeChecksum) {
          sendData += checksum;
        }
      
        printSendPacket(`Data sent: '${sendData}\\r\\n'`);
        sendData += '\r\n';
        activeConnection.write(sendData);
        return resolve(sendData);
      }

      return reject(new Error(JSON.stringify({
        error: 'No connection',
        reason: 'Not connected to any remote host.',
        data: { destroyed: activeConnection ? activeConnection.destroyed : undefined }
      })));
    });

  };
  
  retr.isConnected = () => {
    if (activeConnection && !activeConnection.destroyed) {
      return true;
    }

    return false
  }

  const connectToInvisalink = (netCon, cbs) => {
    const port = netCon.port || '4025';
    if (Number.isNaN(Number.parseInt(port))
      || port < 1
      || port > 65535) {
      throw new Error(JSON.stringify({
        error: 'Bad port',
        reason: 'Port number is not valid',
        data: port
      }));
    }

    activeConnection = nwTcp.createConnection({ port: port || '4025', host: netCon.host });

    printDebug(`[Debug] [connectToInvisalink()]: TCP link established to port '${netCon.port}'`);
  
    activeConnection.on('error', cbs.onErrCb);
    activeConnection.on('close', cbs.onCloseCb);
    activeConnection.on('end', cbs.onEndCb);
    activeConnection.on('data', cbs.onDataCb);
    printDebug(`[Debug] [connectToInvisalink()]: Callbacks registered`);
  };

  retr.connect = () => {
    if (!activeConnection || activeConnection.destroyed) {
      connectToInvisalink(connectionOptions, cbs);
    }
  };

  const init = () => {
    cbs = {
      onErrCb: connOnError,
      onCloseCb: connOnClose,
      onEndCb: connOnEnd,
      onDataCb: connOnData,
      ...defaultCallbackHandlers
    };

    shouldReconnect = connectionOptions.shouldReconnect === null || connectionOptions.shouldReconnect === undefined ? true : shouldReconnect;
  
    if (!connectionOptions.host) {
      throw new Error(JSON.stringify({
        error: 'Bad host',
        reason: 'Host is not valid',
        data: connectionOptions.host
      }));
    }

    if (!authentication.user) {
      throw new Error(JSON.stringify({
        error: 'Bad user',
        reason: 'user is not valid'
      }));
    }

    if (typeof(cbs.onErrCb) !== 'function') {
      throw new Error(JSON.stringify({
        error: 'Bad parameter',
        reason: 'Default callback: onErrCb is not a function',
        data: typeof(cbs.onErrCb)
      }));
    }

    if (typeof(cbs.onCloseCb) !== 'function') {
      throw new Error(JSON.stringify({
        error: 'Bad parameter',
        reason: 'Default callback: onCloseCb is not a function',
        data: typeof(cbs.onCloseCb)
      }));
    }

    if (typeof(cbs.onEndCb) !== 'function') {
      throw new Error(JSON.stringify({
        error: 'Bad parameter',
        reason: 'Default callback: onEndCb is not a function',
        data: typeof(cbs.onEndCb)
      }));
    }

    if (typeof(parsedCallbacks.onError) !== 'function') {
      throw new Error(JSON.stringify({
        error: 'Bad callback',
        reason: 'Callback: onError is not a function',
        data: typeof(parsedCallbacks.onError)
      }));
    }
  };

  // let lastZoneCount = 0;
  retr.printDebug = () => {
    const zoneArr = Object.keys(zones);
    // lastZoneCount = zoneArr.length;
    // for (let i = 0; i < lastZoneCount + 1; i++) {
      // https://stackoverflow.com/questions/10585683/how-do-you-edit-existing-text-and-move-the-cursor-around-in-the-terminal
      // process.stdout.write('\x1b[1A\r');
    // }
    process.stdout.write('Zone:              Last Update:\r\n');
    Object.keys(zones).forEach((zone) => {
      process.stdout.write(`${zone.padStart(2, 0)}              ${zones[zone].lastUpdate.padStart(4, 0)}\r\n`);
    });
    console.log(partitions);
  };

  retr.getPartitionState = () => {
    return JSON.parse(JSON.stringify(partitions));
  };

  retr.getZonesState = () => {
    return JSON.parse(JSON.stringify(zones));
  };

  retr.updateState = (newState, partition) => {
    const binaryState = (parseInt(newState, 16).toString(2)).padStart(16, '0');
    partitions[partition] = {
      ...partitionStateFields
    }

    bitfieldMap.forEach((field, index) => {
      if (partitions[partition][field] === true || partitions[partition][field] === false) {
        partitions[partition][field] = binaryState[index] === '1';
      }
    });
  }

  retr.splitDumpToZones = (data) => {
    let zoneTimerData = data.split(',')[1];
    if (zoneTimerData[zoneTimerData.length - 1] === '$') {
      zoneTimerData = zoneTimerData.slice(0, -1);
    }

    const zoneTimes = zoneTimerData.match(/.{1,4}/g);
    const zonesWithDetails = {};

    let foundEnd = false;
    for (let i = zoneTimes.length - 1; i >= 0; i--) {
      const zoneTime = zoneTimes[i];

      if (zoneTime !== '0000') {
        foundEnd = true;
      }

      if (foundEnd) {
        const reverseEndian = zoneTime.match(/[a-fA-F0-9]{2}/g).reverse().join('');
        const differenceIn5Seconds = parseInt(0xFFFF - parseInt(reverseEndian, 16)) * 5;
        zonesWithDetails[i + 1] = { zone: i + 1, lastUpdate: reverseEndian, secondsAgo: differenceIn5Seconds };
      }
    }

    zones = zonesWithDetails;
  };

  retr.returnFriendlyTime = (givenTime) => {
    if (givenTime) {
      return new Date(givenTime).toISOString().replace(/T/, ' ').replace(/\..+/, '');
    }

    return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  }

  // Login
  retr.handleLoginPrompt = (data) => {
    console.log(retr.returnFriendlyTime(), '|', 'Attempting Login...');
  };

  // OK
  retr.handleLoggedIn = (data) => {
    console.log(retr.returnFriendlyTime(), '|', 'Login Successful');
  };

  // Failure
  retr.handleLogInFailure = (data) => {
    console.log(retr.returnFriendlyTime(), '|', 'Login Failed');
  };

  // Timed Out!
  retr.handleConnTimeout = (data) => {
    console.log(retr.returnFriendlyTime(), '|', 'Connection Timeout');
  };

  // %00
  retr.handleKeypadUpdate = (data) => {
    zoneStateChangeData = data.split(',');
    retr.updateState(zoneStateChangeData[2], zoneStateChangeData[1]);
    if (typeof(parsedCallbacks.keypadUpdateCb) === 'function') {
      parsedCallbacks.keypadUpdateCb({
        raw: data,
        command: zoneStateChangeData[0],
        partition: zoneStateChangeData[1],
        state: zoneStateChangeData[2],
        event: zoneStateChangeData[3],
        beeps: zoneStateChangeData[4],
        text: zoneStateChangeData[5].replace(/\$/g,'').trim()
      });
    }
  };

  // %01
  retr.handleZoneStateChange = (data) => {
    const zoneStateChangeData = data.split(',')[1];
    const zone = zoneStateChangeData.substring(0, 2);
    const zoneStateChange = {
      zone,
      zoneBinary: (parseInt(zone, 16).toString(2)).padStart(8, '0')
    };
    if (typeof(parsedCallbacks.zoneUpdateCb) === 'function') {
      parsedCallbacks.zoneUpdateCb({
        raw: data,
        ...zoneStateChange
      });
    }
  };

  // %02
  retr.handlePartitionStateChange = (data) => {
    if (typeof(parsedCallbacks.partitionUpdateCb) === 'function') {
      console.log('Not implemented');
      parsedCallbacks.partitionUpdateCb({
        raw: data,
        command: null,
        partition: null
      });
    }
  };

  // %03
  retr.handleRealtimeCidEvent = (data) => {
    if (typeof(parsedCallbacks.realTimeCidCb) === 'function') {
      console.log('Not implemented');
      parsedCallbacks.realTimeCidCb({
        raw: data,
        command: null,
        partition: null
      });
    }
  };

  // ^01
  retr.handleChangeDefaultPartition = (data) => {
    // console.log(retr.returnFriendlyTime(), '|', `Get Zone Timer Dump: ${data}`);
  };

  // ^02
  retr.handleGetZoneTimerDump = (data) => {
    // console.log(retr.returnFriendlyTime(), '|', `Get Zone Timer Dump: ${data}`);
  };

  // ^0A
  retr.handleInvalidCommandResponseReceived = (data) => {
    console.log(retr.returnFriendlyTime(), '|', `Invalid Command Received: ${data}`);
  };

  // ^0C
  retr.handleInvalidCommand = (data) => {
    console.log(retr.returnFriendlyTime(), '|', `Invalid Command Given: ${data}`);
  };

  // %FF
  retr.handleZoneTimerDump = (data) => {
    const zoneTimerData = data.split(',')[1];
    retr.splitDumpToZones(data);
    if (typeof(parsedCallbacks.zoneTimerDumpCb) === 'function') {
      parsedCallbacks.zoneTimerDumpCb({
        raw: data,
        zones
      });
    }
  };

  retr.getHistory = () => {
    return JSON.parse(JSON.stringify(historyLog));
  };

  retr.parseIncoming = (message) => {
    const commandData = message.commandData;
    const commandType = commandData.split(',');
    appendHistory({ commandType: commandType[0], data: commandData });

    switch (commandType[0]) {
      case 'Login:':
        retr.handleLoginPrompt(commandData);
        break
      case 'Failure':
        retr.handleLogInFailure(commandData);
        break
      case 'Timed Out!':
        retr.handleConnTimeout(commandData);
        break
      case 'OK':
        retr.handleLoggedIn(commandData);
        break
      case '%00':
        retr.handleKeypadUpdate(commandData);
        break
      case '%01':
        retr.handleZoneStateChange(commandData);
        break
      case '%02':
        retr.handlePartitionStateChange(commandData);
        break
      case '%03':
        retr.handleRealTimeCidEvent(commandData);
        break

      case '%FF':
        retr.handleZoneTimerDump(commandData);
        break

      case '^01':
        retr.handleChangeDefaultPartition(commandData);
        break

      case '^02':
        retr.handleGetZoneTimerDump(commandData);
        break

      case '^03':
        retr.handleSendKeypress(commandData);
        break

      case '^0A':
        retr.handleInvalidCommandResponseReceived(commandData);
        break

      case '^0C':
        retr.handleInvalidCommand(commandData);
        break

      default:
        console.error(`Unknown Event: '${commandType}'. Will not process`);
    }
  };


  init();

  return retr;
};

module.exports = Invisalink;
