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
    pass: 'password'
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
  invisalink.sendCommand({ command: 'dumpZoneTimers' });
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
  runningOptions,
  logging = {}
} = {}) => {
  const retr = {};

  const fallbackGenerateLog = () => {};
  const fallbackGenerateError = ({
    caller,
    reason,
    errorKey,
    err,
    context
  } = {}) => {
    const parsedError = err instanceof Error ? err : new Error(reason || 'Unknown error');
    parsedError.caller = parsedError.caller ?? caller;
    parsedError.reason = parsedError.reason ?? reason;
    parsedError.errorKey = parsedError.errorKey ?? errorKey;
    if (context !== undefined) {
      parsedError.context = context;
    }

    return parsedError;
  };
  const fallbackWrapError = (payload = {}) => fallbackGenerateError(payload);

  const generateError = typeof logging.generateError === 'function'
    ? logging.generateError
    : fallbackGenerateError;
  const generateLog = typeof logging.generateLog === 'function'
    ? logging.generateLog
    : fallbackGenerateLog;
  const wrapError = typeof logging.wrapError === 'function'
    ? logging.wrapError
    : fallbackWrapError;

  const connectionOptions = {
    ...network
  };

  const auth = {
    ...authentication
  };
  auth.pass = auth.pass ?? auth.password ?? auth.user ?? null;

  const parsedCallbacks = {
    ...callbacks
  };

  const options = {
    ...runningOptions
  };
  let zones = {};
  const partitions = {};
  const systemState = {};

  const historyLimit = 10;
  const historyLog = {};

  const keypadBeeps = {
    '00': 'off',
    '01': 'beep 1 time',
    '02': 'beep 2 times',
    '03': 'beep 3 times',
    '04': 'continous fast beep',
    '05': 'continuous slow beep'
  };

  const keypadLedDefinitions = [
    { mask: 0x80, key: 'backlight', label: 'Backlight' },
    { mask: 0x40, key: 'fire', label: 'Fire' },
    { mask: 0x20, key: 'program', label: 'Program' },
    { mask: 0x10, key: 'trouble', label: 'Trouble' },
    { mask: 0x08, key: 'bypass', label: 'Bypass' },
    { mask: 0x04, key: 'memory', label: 'Memory' },
    { mask: 0x02, key: 'armed', label: 'Armed' },
    { mask: 0x01, key: 'ready', label: 'Ready' }
  ];

  const zoneEventMap = {
    '601': {
      event: 'alarm',
      message: 'Zone alarm',
      patch: { alarm: true }
    },
    '602': {
      event: 'alarmRestore',
      message: 'Zone alarm restored',
      patch: { alarm: false }
    },
    '603': {
      event: 'tamperAlarm',
      message: 'Zone tamper alarm',
      patch: { tamper: true }
    },
    '604': {
      event: 'tamperRestore',
      message: 'Zone tamper alarm restored',
      patch: { tamper: false }
    },
    '605': {
      event: 'fault',
      message: 'Zone fault',
      patch: { fault: true, open: true }
    },
    '606': {
      event: 'faultRestore',
      message: 'Zone fault restored',
      patch: { fault: false }
    },
    '609': {
      event: 'open',
      message: 'Zone open',
      patch: { open: true }
    },
    '610': {
      event: 'restored',
      message: 'Zone restored',
      patch: { open: false, fault: false }
    },
    '832': {
      event: 'wirelessLowBattery',
      message: 'Wireless zone low battery',
      patch: { lowBattery: true }
    },
    '833': {
      event: 'wirelessLowBatteryRestore',
      message: 'Wireless zone low battery restored',
      patch: { lowBattery: false }
    }
  };

  const partitionArmModeMap = {
    '0': {
      event: 'armedAway',
      message: 'Partition armed away',
      patch: {
        alarm: false,
        armed: true,
        armedAway: true,
        armedStay: false,
        armedNight: false,
        armedZeroDelay: false,
        entryDelay: false,
        exitDelay: false,
        ready: false,
        alpha: 'Arm Away'
      }
    },
    '1': {
      event: 'armedStay',
      message: 'Partition armed stay',
      patch: {
        alarm: false,
        armed: true,
        armedAway: false,
        armedStay: true,
        armedNight: false,
        armedZeroDelay: false,
        entryDelay: false,
        exitDelay: false,
        ready: false,
        alpha: 'Arm Stay'
      }
    },
    '2': {
      event: 'armedAwayZeroDelay',
      message: 'Partition armed away with zero entry delay',
      patch: {
        alarm: false,
        armed: true,
        armedAway: true,
        armedStay: false,
        armedNight: false,
        armedZeroDelay: true,
        entryDelay: false,
        exitDelay: false,
        ready: false,
        alpha: 'Arm Zero Entry Away'
      }
    },
    '3': {
      event: 'armedStayZeroDelay',
      message: 'Partition armed stay with zero entry delay',
      patch: {
        alarm: false,
        armed: true,
        armedAway: false,
        armedStay: true,
        armedNight: true,
        armedZeroDelay: true,
        entryDelay: false,
        exitDelay: false,
        ready: false,
        alpha: 'Arm Zero Entry Stay'
      }
    }
  };

  const partitionEventMap = {
    '650': {
      event: 'ready',
      message: 'Partition ready',
      patch: {
        ready: true,
        armed: false,
        alarm: false,
        exitDelay: false,
        entryDelay: false,
        armFailed: false,
        busy: false,
        armingInProgress: false,
        fire: false,
        panic: false,
        alpha: 'Ready'
      }
    },
    '651': {
      event: 'notReady',
      message: 'Partition not ready',
      patch: {
        ready: false,
        alarm: false,
        alpha: 'Not Ready'
      }
    },
    '653': {
      event: 'forceReady',
      message: 'Partition force ready',
      patch: {
        ready: true,
        forceReady: true,
        alpha: 'Ready - Force Arm'
      }
    },
    '654': {
      event: 'alarm',
      message: 'Partition in alarm',
      patch: {
        alarm: true,
        alpha: 'Alarm'
      }
    },
    '655': {
      event: 'disarmed',
      message: 'Partition disarmed',
      patch: {
        alarm: false,
        armed: false,
        armedAway: false,
        armedNight: false,
        armedStay: false,
        exitDelay: false,
        entryDelay: false,
        keypadLockout: false,
        busy: false,
        forceReady: false,
        armingInProgress: false,
        armedZeroDelay: false,
        fire: false,
        panic: false,
        alpha: 'Disarmed'
      }
    },
    '656': {
      event: 'exitDelay',
      message: 'Partition exit delay',
      patch: {
        exitDelay: true,
        entryDelay: false,
        alpha: 'Exit Delay In Progress'
      }
    },
    '657': {
      event: 'entryDelay',
      message: 'Partition entry delay',
      patch: {
        entryDelay: true,
        exitDelay: false,
        alpha: 'Entry Delay In Progress'
      }
    },
    '658': {
      event: 'keypadLockout',
      message: 'Partition keypad lockout',
      patch: { keypadLockout: true }
    },
    '659': {
      event: 'failedToArm',
      message: 'Keypad failed to arm partition',
      patch: { armFailed: true }
    },
    '660': {
      event: 'pgmOutput',
      message: 'PGM output active',
      patch: { pgmOutput: true }
    },
    '663': {
      event: 'doorChimeEnabled',
      message: 'Door chime enabled',
      patch: { chime: true }
    },
    '664': {
      event: 'doorChimeDisabled',
      message: 'Door chime disabled',
      patch: { chime: false }
    },
    '670': {
      event: 'invalidAccessCode',
      message: 'Invalid access code entered',
      patch: { invalidAccessCode: true }
    },
    '671': {
      event: 'functionUnavailable',
      message: 'Function not available',
      patch: { functionNotAvailable: true }
    },
    '672': {
      event: 'failedToArm',
      message: 'Failed to arm partition',
      patch: { armFailed: true }
    },
    '673': {
      event: 'busy',
      message: 'Partition busy',
      patch: {
        busy: true,
        alpha: 'Busy'
      }
    },
    '674': {
      event: 'armingInProgress',
      message: 'Partition arming in progress',
      patch: {
        armingInProgress: true,
        alpha: 'Arming In Progress'
      }
    },
    '700': {
      event: 'armedByUser',
      message: 'Partition armed by user',
      patch: {}
    },
    '701': {
      event: 'armedSpecial',
      message: 'Partition armed using a special closing',
      patch: {
        armed: true
      }
    },
    '702': {
      event: 'partialClosing',
      message: 'Partition armed with zones bypassed',
      patch: {
        armed: true,
        bypassed: true
      }
    },
    '750': {
      event: 'disarmedByUser',
      message: 'Partition disarmed by user',
      patch: {
        alarm: false,
        armed: false,
        armedAway: false,
        armedNight: false,
        armedStay: false,
        armedZeroDelay: false,
        exitDelay: false,
        entryDelay: false,
        alpha: 'Disarmed'
      }
    },
    '751': {
      event: 'disarmedSpecial',
      message: 'Partition disarmed by special event',
      patch: {
        alarm: false,
        armed: false,
        armedAway: false,
        armedNight: false,
        armedStay: false,
        armedZeroDelay: false,
        exitDelay: false,
        entryDelay: false,
        alpha: 'Disarmed'
      }
    },
    '840': {
      event: 'troubleOn',
      message: 'Trouble LED on',
      patch: { systemTrouble: true, trouble: true }
    },
    '841': {
      event: 'troubleOff',
      message: 'Trouble LED off',
      patch: { systemTrouble: false, trouble: false, acPresent: true }
    },
    '842': {
      event: 'fireTroubleOn',
      message: 'Fire trouble alarm',
      patch: { fireTrouble: true }
    },
    '843': {
      event: 'fireTroubleOff',
      message: 'Fire trouble alarm restored',
      patch: { fireTrouble: false }
    }
  };

  const keypadEventMap = {
    '621': {
      event: 'fireAlarmButton',
      message: 'Fire keypad alarm triggered',
      partitionPatch: { fire: true, alpha: 'Fire Alarm' },
      systemPatch: { fire: true }
    },
    '622': {
      event: 'fireAlarmButtonRestore',
      message: 'Fire keypad alarm restored',
      partitionPatch: { fire: false },
      systemPatch: { fire: false }
    },
    '623': {
      event: 'auxAlarmButton',
      message: 'Auxiliary keypad alarm triggered',
      partitionPatch: { alarm: true, alpha: 'Aux Alarm' },
      systemPatch: { alarm: true }
    },
    '624': {
      event: 'auxAlarmButtonRestore',
      message: 'Auxiliary keypad alarm restored',
      partitionPatch: { alarm: false, alpha: 'Aux Alarm Cleared' },
      systemPatch: { alarm: false }
    },
    '625': {
      event: 'panicAlarmButton',
      message: 'Panic keypad alarm triggered',
      partitionPatch: { panic: true, alpha: 'Panic Alarm' },
      systemPatch: { panic: true }
    },
    '626': {
      event: 'panicAlarmButtonRestore',
      message: 'Panic keypad alarm restored',
      partitionPatch: { panic: false },
      systemPatch: { panic: false }
    },
    '631': {
      event: 'smokeAlarmButton',
      message: 'Smoke alarm triggered',
      partitionPatch: { alarm: true, alpha: 'Smoke Alarm' },
      systemPatch: { alarm: true }
    },
    '632': {
      event: 'smokeAlarmButtonRestore',
      message: 'Smoke alarm restored',
      partitionPatch: { alarm: false, alpha: 'Smoke Alarm Cleared' },
      systemPatch: { alarm: false }
    },
    '800': {
      event: 'lowBatteryTrouble',
      message: 'System low battery trouble',
      partitionPatch: { lowBattery: true, alpha: 'Low Battery' },
      systemPatch: { batTrouble: true }
    },
    '801': {
      event: 'lowBatteryTroubleRestore',
      message: 'System low battery trouble restored',
      partitionPatch: { lowBattery: false, alpha: 'Low Battery Cleared' },
      systemPatch: { batTrouble: false }
    },
    '802': {
      event: 'acPowerLost',
      message: 'AC power lost',
      partitionPatch: { ac: false, acPresent: false, alpha: 'AC Power Lost' },
      systemPatch: { acPresent: false }
    },
    '803': {
      event: 'acPowerRestored',
      message: 'AC power restored',
      partitionPatch: { ac: true, acPresent: true, alpha: 'AC Power Restored' },
      systemPatch: { acPresent: true }
    },
    '806': {
      event: 'systemBellTrouble',
      message: 'System bell trouble',
      partitionPatch: { bellTrouble: true, alpha: 'Bell Trouble' },
      systemPatch: { bellTrouble: true }
    },
    '807': {
      event: 'systemBellTroubleRestore',
      message: 'System bell trouble restored',
      partitionPatch: { bellTrouble: false, alpha: 'Bell Trouble Cleared' },
      systemPatch: { bellTrouble: false }
    },
    '814': {
      event: 'systemTamper',
      message: 'System tamper',
      partitionPatch: { alpha: 'System Tamper' },
      systemPatch: { systemTamper: true }
    },
    '815': {
      event: 'systemTamperRestore',
      message: 'System tamper restored',
      partitionPatch: { alpha: 'System Tamper Restored' },
      systemPatch: { systemTamper: false }
    },
    '816': {
      event: 'systemBufferNearFull',
      message: 'System buffer near full',
      partitionPatch: { alpha: 'Buffer Near Full' },
      systemPatch: { bufferNearFull: true }
    },
    '829': {
      event: 'systemTamper',
      message: 'System tamper',
      partitionPatch: { alpha: 'System Tamper' },
      systemPatch: { systemTamper: true }
    },
    '830': {
      event: 'systemTamperRestore',
      message: 'System tamper restored',
      partitionPatch: { alpha: 'System Tamper Restored' },
      systemPatch: { systemTamper: false }
    }
  };

  const verboseTroubleDefinitions = [
    { bitIndex: 0, key: 'serviceRequired', label: 'Service is Required' },
    { bitIndex: 1, key: 'acPowerLost', label: 'AC Power Lost' },
    { bitIndex: 2, key: 'telephoneLineFault', label: 'Telephone Line Fault' },
    { bitIndex: 3, key: 'failureToCommunicate', label: 'Failure to communicate' },
    { bitIndex: 4, key: 'zoneSensorFault', label: 'Zone/Sensor Fault' },
    { bitIndex: 5, key: 'zoneSensorTamper', label: 'Zone/Sensor Tamper' },
    { bitIndex: 6, key: 'zoneSensorLowBattery', label: 'Zone/Sensor Low Battery' },
    { bitIndex: 7, key: 'lossOfTime', label: 'Loss of time' }
  ];

  let shouldReconnect = true;
  let activeConnection = null;
  let pollTimer = null;
  let cbs = {};
  let receiveBuffer = '';
 
  const notifyError = (error) => {
    if (typeof(parsedCallbacks.onError) === 'function') {
      parsedCallbacks.onError(error);
    }

    return error;
  };

  const toBinaryString = (value, minimumWidth = 8) => {
    const parsed = Number.parseInt(value, 16);
    if (Number.isNaN(parsed)) {
      return null;
    }

    return parsed.toString(2).padStart(minimumWidth, '0');
  };

  const normalizeStringInput = (value) => {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number') {
      return String(value);
    }

    return '';
  };

  const parseReconnectSetting = (value) => {
    if (value === undefined || value === null) {
      return true;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
    }

    return Boolean(value);
  };

  const normalizePartitionId = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return String(value ?? '');
    }

    return String(parsed).padStart(2, '0');
  };

  const normalizeZoneId = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return String(value ?? '');
    }

    return String(parsed);
  };

  const buildDisabledBitState = (definitions) =>
    definitions.reduce((accumulator, definition) => ({
      ...accumulator,
      [definition.key]: false
    }), {});

  const decodeKeypadLedBits = (commandParam) => {
    const normalizedParam = normalizeStringInput(commandParam).toUpperCase();
    const keypadByte = Number.parseInt(normalizedParam, 16);
    const flags = buildDisabledBitState(keypadLedDefinitions);
    const labels = {};

    keypadLedDefinitions.forEach((definition) => {
      labels[definition.key] = definition.label;
      if (!Number.isNaN(keypadByte)) {
        flags[definition.key] = (keypadByte & definition.mask) !== 0;
      }
    });

    return {
      hex: normalizedParam,
      binary: toBinaryString(normalizedParam, 8),
      flags,
      labels
    };
  };

  const buildKeypadIndicators = ({ leds = {}, flashing = {} } = {}) =>
    keypadLedDefinitions.reduce((accumulator, definition) => {
      const ledOn = Boolean(leds?.[definition.key]);
      const ledFlashing = Boolean(flashing?.[definition.key]);

      return {
        ...accumulator,
        [definition.key]: ledFlashing
          ? 'flashing'
          : ledOn
            ? 'on'
            : 'off'
      };
    }, {});

  const decodeVerboseTroubleBits = (commandParam) => {
    const normalizedParam = normalizeStringInput(commandParam).toUpperCase();
    const troubleByte = Number.parseInt(normalizedParam, 16);
    const flags = buildDisabledBitState(verboseTroubleDefinitions);
    const descriptions = [];

    verboseTroubleDefinitions.forEach((definition) => {
      if (!Number.isNaN(troubleByte) && (troubleByte & (1 << definition.bitIndex)) !== 0) {
        flags[definition.key] = true;
        descriptions.push(definition.label);
      }
    });

    return {
      hex: normalizedParam,
      binary: toBinaryString(normalizedParam, 8),
      flags,
      descriptions,
      acPresent: !flags.acPowerLost
    };
  };

  const extractZoneEventDetails = (commandParam) => {
    const normalizedParam = normalizeStringInput(commandParam);
    if (!normalizedParam) {
      return {
        partition: null,
        zone: ''
      };
    }

    const zoneDigits = normalizedParam.slice(-3);
    const partitionDigits = normalizedParam.length > 3 ? normalizedParam.slice(0, normalizedParam.length - 3) : '';

    return {
      partition: partitionDigits || null,
      zone: normalizeZoneId(zoneDigits)
    };
  };

  const extractPartitionEventDetails = ({ commandType, commandParam }) => {
    const normalizedParam = normalizeStringInput(commandParam);
    if (!normalizedParam) {
      return {
        partition: '',
        partitionPayload: '',
        armMode: null,
        user: null
      };
    }

    if (commandType === '652') {
      return {
        partition: normalizePartitionId(normalizedParam[0]),
        partitionPayload: normalizedParam,
        armMode: normalizedParam[1] ?? null,
        user: null
      };
    }

    return {
      partition: normalizePartitionId(normalizedParam[0]),
      partitionPayload: normalizedParam.slice(1),
      armMode: null,
      user: normalizedParam.length > 1 ? normalizedParam.slice(1) : null
    };
  };

  const parseZoneBitfield = (commandParam) => {
    const normalizedParam = normalizeStringInput(commandParam);
    const updates = [];
    if (!normalizedParam || normalizedParam.length % 2 !== 0) {
      return updates;
    }

    for (let byteIndex = 0; byteIndex < normalizedParam.length / 2; byteIndex++) {
      const byteValue = Number.parseInt(normalizedParam.slice(byteIndex * 2, (byteIndex * 2) + 2), 16);
      if (Number.isNaN(byteValue)) {
        continue;
      }

      for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
        const zone = String((byteIndex * 8) + bitIndex + 1);
        const bypassed = (byteValue & (1 << bitIndex)) !== 0;
        const priorZone = zones[zone] ?? {};
        if (priorZone.bypassed !== bypassed) {
          updates.push({
            zone: Number.parseInt(zone, 10),
            bypassed
          });
        }

        updateZoneRecord({
          zone,
          patch: {
            bypassed
          }
        });
      }
    }

    return updates;
  };

  const updateSystemState = ({ patch }) => {
    Object.assign(systemState, patch);
    return {
      ...systemState
    };
  };

  const emitPanelEvent = (payload) => {
    if (typeof(parsedCallbacks.panelEventCb) === 'function') {
      parsedCallbacks.panelEventCb(payload);
    }
  };

  const updateZoneRecord = ({ zone, patch }) => {
    const zoneKey = normalizeZoneId(zone);
    const priorZone = zones[zoneKey] ?? {};
    const zoneValue = Number.parseInt(zoneKey, 10);
    const nextZone = {
      ...priorZone,
      ...patch,
      zone: Number.isNaN(zoneValue) ? zoneKey : zoneValue
    };

    zones[zoneKey] = nextZone;
    return nextZone;
  };

  const updatePartitionRecord = ({ partition, patch }) => {
    const partitionKey = normalizePartitionId(partition);
    const nextPartition = {
      ...partitions[partitionKey],
      partition: partitionKey,
      ...patch
    };

    partitions[partitionKey] = nextPartition;
    return nextPartition;
  };

  const emitKeypadUpdate = ({ commandType, commandParam, commandChecksum, commandData, event, stateType }) => {
    const normalizedParam = normalizeStringInput(commandParam).toUpperCase();
    const isLedBitfield = ['led', 'flash'].includes(stateType);
    const decodedBits = isLedBitfield
      ? decodeKeypadLedBits(normalizedParam)
      : null;
    const partitionKeys = Object.keys(partitions).length > 0 ? Object.keys(partitions) : ['01'];
    let effectiveIndicators = null;

    if (isLedBitfield) {
      partitionKeys.forEach((partitionKey) => {
        const priorPartition = partitions[partitionKey] ?? {};
        const nextKeypadLeds = stateType === 'led'
          ? decodedBits.flags
          : { ...(priorPartition.keypadLeds ?? buildDisabledBitState(keypadLedDefinitions)) };
        const nextKeypadFlashing = stateType === 'flash'
          ? decodedBits.flags
          : { ...(priorPartition.keypadFlashing ?? buildDisabledBitState(keypadLedDefinitions)) };
        const nextIndicators = buildKeypadIndicators({
          leds: nextKeypadLeds,
          flashing: nextKeypadFlashing
        });

        effectiveIndicators = nextIndicators;

        updatePartitionRecord({
          partition: partitionKey,
          patch: {
            ready: nextKeypadLeds.ready,
            armed: nextKeypadLeds.armed,
            alarmInMemory: nextKeypadLeds.memory,
            bypassed: nextKeypadLeds.bypass,
            systemTrouble: nextKeypadLeds.trouble,
            fireZoneAlarm: nextKeypadLeds.fire,
            keypadLeds: nextKeypadLeds,
            keypadFlashing: nextKeypadFlashing,
            keypadIndicators: nextIndicators
          }
        });
      });
    }

    const keypadPayload = {
      raw: commandData,
      commandType,
      commandParam,
      commandChecksum,
      event,
      stateType,
      state: isLedBitfield ? decodedBits.hex : normalizedParam,
      beepText: keypadBeeps[commandParam] ?? null
    };

    if (isLedBitfield) {
      keypadPayload.stateBinary = decodedBits.binary;
      keypadPayload.flags = decodedBits.flags;
      keypadPayload.labels = decodedBits.labels;
      keypadPayload.indicators = effectiveIndicators;
    }

    if (stateType === 'led') {
      keypadPayload.leds = decodedBits.flags;
    }

    if (stateType === 'flash') {
      keypadPayload.flashing = decodedBits.flags;
    }

    if (typeof(parsedCallbacks.keypadUpdateCb) === 'function') {
      parsedCallbacks.keypadUpdateCb(keypadPayload);
    }

    emitPanelEvent({
      ...keypadPayload,
      category: 'keypad',
      beepText: undefined
    });
  };

  const emitZonePanelEvent = ({ commandType, commandParam, commandChecksum, commandData }) => {
    const eventConfig = zoneEventMap[commandType];
    if (!eventConfig) {
      return;
    }

    const eventTimestamp = new Date().toISOString();
    const { partition, zone } = extractZoneEventDetails(commandParam);
    const nextZone = updateZoneRecord({
      zone,
      patch: {
        ...eventConfig.patch,
        partition: partition ? normalizePartitionId(partition) : undefined,
        lastEventCode: commandType,
        lastEvent: eventConfig.event,
        lastEventText: eventConfig.message,
        lastEventAt: eventTimestamp
      }
    });

    if (typeof(parsedCallbacks.zoneUpdateCb) === 'function') {
      parsedCallbacks.zoneUpdateCb({
        raw: commandData,
        commandType,
        commandParam,
        commandChecksum,
        partition: partition ? normalizePartitionId(partition) : null,
        zone,
        event: eventConfig.event,
        eventText: eventConfig.message,
        state: nextZone
      });
    }

    emitPanelEvent({
      raw: commandData,
      commandType,
      commandParam,
      commandChecksum,
      category: 'zone',
      partition: partition ? normalizePartitionId(partition) : null,
      zone,
      event: eventConfig.event,
      eventText: eventConfig.message,
      state: nextZone
    });
  };

  const emitPartitionPanelEvent = ({ commandType, commandParam, commandChecksum, commandData }) => {
    const eventConfig = partitionEventMap[commandType];
    if (!eventConfig) {
      return;
    }

    const eventTimestamp = new Date().toISOString();
    const eventDetails = extractPartitionEventDetails({ commandType, commandParam });
    const partition = eventDetails.partition;
    const extraPatch = {};
    if (eventDetails.user) {
      if (commandType === '700') {
        extraPatch.lastArmedByUser = Number.parseInt(eventDetails.user, 10);
      } else if (commandType === '750') {
        extraPatch.lastDisarmedByUser = Number.parseInt(eventDetails.user, 10);
      } else {
        extraPatch.user = eventDetails.user;
      }
    }

    if (commandType === '652') {
      const armModeConfig = partitionArmModeMap[eventDetails.armMode];
      if (armModeConfig) {
        Object.assign(extraPatch, armModeConfig.patch);
      }
    }

    const nextPartition = updatePartitionRecord({
      partition,
      patch: {
        ...eventConfig.patch,
        ...extraPatch,
        lastEventCode: commandType,
        lastEvent: commandType === '652' && partitionArmModeMap[eventDetails.armMode]
          ? partitionArmModeMap[eventDetails.armMode].event
          : eventConfig.event,
        lastEventText: commandType === '652' && partitionArmModeMap[eventDetails.armMode]
          ? partitionArmModeMap[eventDetails.armMode].message
          : eventConfig.message,
        lastEventAt: eventTimestamp
      }
    });

    if (typeof(parsedCallbacks.partitionUpdateCb) === 'function') {
      parsedCallbacks.partitionUpdateCb({
        raw: commandData,
        commandType,
        commandParam,
        commandChecksum,
        partition,
        event: nextPartition.lastEvent,
        eventText: nextPartition.lastEventText,
        state: nextPartition
      });
    }

    emitPanelEvent({
      raw: commandData,
      commandType,
      commandParam,
      commandChecksum,
      category: 'partition',
      partition,
      event: nextPartition.lastEvent,
      eventText: nextPartition.lastEventText,
      state: nextPartition
    });
  };

  const emitSystemEvent = ({
    commandType,
    commandParam,
    commandChecksum,
    commandData,
    event,
    eventText,
    patch = {},
    metadata = {}
  }) => {
    const nextSystemState = updateSystemState({
      patch: {
        ...patch,
        lastEventCode: commandType,
        lastEvent: event,
        lastEventText: eventText,
        lastEventAt: new Date().toISOString()
      }
    });

    if (typeof(parsedCallbacks.systemUpdateCb) === 'function') {
      parsedCallbacks.systemUpdateCb({
        raw: commandData,
        commandType,
        commandParam,
        commandChecksum,
        event,
        eventText,
        state: nextSystemState,
        ...metadata
      });
    }

    emitPanelEvent({
      raw: commandData,
      commandType,
      commandParam,
      commandChecksum,
      category: 'system',
      event,
      eventText,
      state: nextSystemState,
      ...metadata
    });
  };

  const emitZoneBypassUpdate = ({ commandType, commandParam, commandChecksum, commandData }) => {
    const updates = parseZoneBitfield(commandParam);
    if (typeof(parsedCallbacks.zoneBypassUpdateCb) === 'function') {
      parsedCallbacks.zoneBypassUpdateCb({
        raw: commandData,
        commandType,
        commandParam,
        commandChecksum,
        updates,
        zones: retr.getZonesState()
      });
    }

    emitPanelEvent({
      raw: commandData,
      commandType,
      commandParam,
      commandChecksum,
      category: 'zoneBypass',
      event: 'zoneBypassUpdate',
      eventText: 'Bypassed zones bitfield dump received',
      updates,
      state: retr.getZonesState()
    });
  };

  const emitGeneralKeypadEvent = ({ commandType, commandParam, commandChecksum, commandData }) => {
    const eventConfig = keypadEventMap[commandType];
    if (!eventConfig) {
      return;
    }

    const partitionKeys = Object.keys(partitions).length > 0 ? Object.keys(partitions) : ['01'];
    const updatedPartitions = partitionKeys.map((partitionKey) =>
      updatePartitionRecord({
        partition: partitionKey,
        patch: {
          ...eventConfig.partitionPatch,
          lastEventCode: commandType,
          lastEvent: eventConfig.event,
          lastEventText: eventConfig.message,
          lastEventAt: new Date().toISOString()
        }
      })
    );

    if (typeof(parsedCallbacks.partitionUpdateCb) === 'function') {
      updatedPartitions.forEach((partitionState) => {
        parsedCallbacks.partitionUpdateCb({
          raw: commandData,
          commandType,
          commandParam,
          commandChecksum,
          partition: partitionState.partition,
          event: eventConfig.event,
          eventText: eventConfig.message,
          state: partitionState
        });
      });
    }

    if (typeof(parsedCallbacks.keypadUpdateCb) === 'function') {
      parsedCallbacks.keypadUpdateCb({
        raw: commandData,
        commandType,
        commandParam,
        commandChecksum,
        event: eventConfig.event,
        eventText: eventConfig.message,
        partitions: updatedPartitions
      });
    }

    emitSystemEvent({
      commandType,
      commandParam,
      commandChecksum,
      commandData,
      event: eventConfig.event,
      eventText: eventConfig.message,
      patch: eventConfig.systemPatch
    });
  };

  const printDebug = (message) => {
    if (options.printDebug) {
      generateLog({
        level: 'debug',
        caller: 'envisalink::debug',
        message
      });
    }
  };

  const appendHistory = ({ commandType, data }) => {
    if (!Array.isArray(historyLog['ALL'])) {
      historyLog['ALL'] = [];
    }

    if (!Array.isArray(historyLog[commandType])) {
      historyLog[commandType] = [];
    }

    historyLog[commandType].unshift({
      eventTime: retr.returnFriendlyTime(),
      data: data
    })

    historyLog['ALL'].unshift({
      eventTime: retr.returnFriendlyTime(),
      data: data
    })

    if (historyLog[commandType].length > historyLimit) {
      historyLog[commandType].splice(historyLimit, historyLog[commandType].length);
    }

    if (historyLog['ALL'].length > historyLimit) {
      historyLog['ALL'].splice(historyLimit, historyLog['ALL'].length);
    }
  };

  const printReceivePacket = (packetData) => {
    if (options.printReceivePacket) {
      generateLog({
        level: 'debug',
        caller: 'envisalink::packet.receive',
        message: packetData
      });
    }
  };

  const printSendPacket = (packetData) => {
    if (options.printSendPacket) {
      generateLog({
        level: 'debug',
        caller: 'envisalink::packet.send',
        message: packetData
      });
    }
  };

  const printCommandData = (commandData) => {
    if (options.printCommandData) {
      generateLog({
        level: 'debug',
        caller: 'envisalink::packet.command',
        message: commandData
      });
    }
  };

  const connOnError = (err) => {
    if (typeof(parsedCallbacks.connectionStateCb) === 'function') {
      parsedCallbacks.connectionStateCb({
        connected: false,
        reason: 'error',
        host: connectionOptions.host,
        port: connectionOptions.port,
        err
      });
    }

    notifyError(generateError({
      caller: 'envisalink::connection.error',
      reason: 'TCP connection error',
      errorKey: 'ENVISALINK_TCP_CONNECTION_ERROR',
      err,
      includeStackTrace: true,
      log: false,
      context: {
        host: connectionOptions.host,
        port: connectionOptions.port
      }
    }));
  };

  const connOnConnect = () => {
    receiveBuffer = '';

    if (typeof(parsedCallbacks.connectionStateCb) === 'function') {
      parsedCallbacks.connectionStateCb({
        connected: true,
        reason: 'connect',
        host: connectionOptions.host,
        port: connectionOptions.port
      });
    }
  };
  
  const connOnEnd = (param) => {
    receiveBuffer = '';

    if (typeof(parsedCallbacks.connectionStateCb) === 'function') {
      parsedCallbacks.connectionStateCb({
        connected: false,
        reason: 'end',
        host: connectionOptions.host,
        port: connectionOptions.port,
        param
      });
    }

    generateLog({
      level: 'warn',
      caller: 'envisalink::connection.end',
      message: 'TCP connection ended',
      errorKey: 'ENVISALINK_TCP_CONNECTION_ENDED',
      context: {
        param,
        host: connectionOptions.host,
        port: connectionOptions.port
      }
    });
  };
  
  const connOnClose = (hadErr) => {
    clearInterval(pollTimer);
    receiveBuffer = '';
    if (typeof(parsedCallbacks.connectionStateCb) === 'function') {
      parsedCallbacks.connectionStateCb({
        connected: false,
        reason: 'close',
        host: connectionOptions.host,
        port: connectionOptions.port,
        hadErr
      });
    }

    generateLog({
      level: hadErr ? 'error' : 'warn',
      caller: 'envisalink::connection.close',
      message: 'TCP connection closed',
      errorKey: 'ENVISALINK_TCP_CONNECTION_CLOSED',
      context: {
        hadErr,
        shouldReconnect,
        host: connectionOptions.host,
        port: connectionOptions.port
      }
    });
    setTimeout(() => {
      if (shouldReconnect && (!activeConnection || activeConnection.destroyed)) {
        retr.connect()
      }
    }, 5000);
  };

  const connOnData = (data) => {
    const chunkText = data.toString();
    receiveBuffer += chunkText;

    const dataBuffer = receiveBuffer
      .split(/\r\n|\n|\r/g);
    receiveBuffer = dataBuffer.pop() ?? '';

    const completeFrames = dataBuffer.filter((entry) => entry !== '');
    printDebug(`[Debug] [connOnData()]: Commands received: '${completeFrames.length}'`);
    printReceivePacket(`Data received: '${chunkText.replace(/[\n\r]/g, '|')}'`);

    for (let i = 0; i < completeFrames.length; i++) {
      const commandData = completeFrames[i];
      if (commandData !== '') {
        try {
          retr.parseIncoming({ commandData });

          if (typeof(parsedCallbacks.onRawData) === 'function') {
            parsedCallbacks.onRawData({ commandData, dataBuffer: completeFrames, bufferIndex: i });
          }
        } catch (err) {
          notifyError(generateError({
            caller: 'envisalink::connOnData',
            reason: 'Failed to process incoming panel data',
            errorKey: 'ENVISALINK_CONN_ON_DATA_PROCESSING_FAILED',
            err,
            includeStackTrace: true,
            log: false,
            context: {
              commandData,
              bufferIndex: i
            }
          }));
        }
      }
    }
  };

  retr.sendCommand = ({ command, params } = {}) => {
    if (!retr.isConnected()) {
      return Promise.reject(wrapError({
        caller: 'envisalink::sendCommand',
        reason: 'Not connected to any remote host',
        errorKey: 'ENVISALINK_SEND_COMMAND_NO_CONNECTION',
        context: {
          command,
          params,
          destroyed: activeConnection ? activeConnection.destroyed : undefined
        }
      }));
    }

    switch (command) {
      case 'poll':
        return retr.sendRawCommand({ data: '000' }).then(() => true);

      case 'statusReport':
        return retr.sendRawCommand({ data: '001' }).then(() => true);

      case 'dumpZoneTimers':
        return retr.sendRawCommand({ data: '008' }).then(() => true);

      case 'setTime':
        return retr.sendRawCommand({ data: '010', params: normalizeStringInput(params) }).then(() => true);

      case 'commandOutput':
        return retr.sendRawCommand({ data: '020', params: normalizeStringInput(params) }).then(() => true);

      case 'armAway':
        return retr.sendRawCommand({ data: '030', params: normalizeStringInput(params).substring(0, 1) }).then(() => true);

      case 'armStay':
        return retr.sendRawCommand({ data: '031', params: normalizeStringInput(params).substring(0, 1) }).then(() => true);

      case 'armNoEntryDelay':
        return retr.sendRawCommand({ data: '032', params: normalizeStringInput(params).substring(0, 1) }).then(() => true);

      case 'armWithCode':
        return retr.sendRawCommand({ data: '033', params: normalizeStringInput(params).substring(0, 7) }).then(() => true);

      case 'disarmWithCode':
        return retr.sendRawCommand({ data: '040', params: normalizeStringInput(params).substring(0, 7) }).then(() => true);

      case 'setTimestamp':
        return retr.sendRawCommand({
          data: '055',
          params: ['1', 'true', 'on', 'yes'].includes(normalizeStringInput(params).toLowerCase()) || params === true ? '1' : '0'
        }).then(() => true);

      case 'setTimeBroadcast':
        return retr.sendRawCommand({
          data: '056',
          params: ['1', 'true', 'on', 'yes'].includes(normalizeStringInput(params).toLowerCase()) || params === true ? '1' : '0'
        }).then(() => true);

      case 'setTemperatureBroadcast':
        return retr.sendRawCommand({
          data: '057',
          params: ['1', 'true', 'on', 'yes'].includes(normalizeStringInput(params).toLowerCase()) || params === true ? '1' : '0'
        }).then(() => true);

      case 'panicAlarm':
        return retr.sendRawCommand({ data: '060', params: normalizeStringInput(params).substring(0, 1) }).then(() => true);

      case 'singleKeyStroke':
        return retr.sendRawCommand({ data: '070', params: normalizeStringInput(params).substring(0, 1) }).then(() => true);

      case 'sendKeyStroke':
        return retr.sendRawCommand({ data: '071', params: normalizeStringInput(params).substring(0, 7) }).then(() => true);

      case 'enterUserCodeProgrammingMode':
        return retr.sendRawCommand({ data: '072', params: params?.toString?.()?.substring?.(0, 1) ?? '' }).then(() => true);

      case 'enterUserProgramingMode':
        return retr.sendRawCommand({ data: '073', params: params?.toString?.()?.substring?.(0, 1) ?? '' }).then(() => true);

      case 'keepAlive':
        return retr.sendRawCommand({ data: '074', params: params?.toString?.()?.substring?.(0, 1) ?? '' }).then(() => true);

      case 'requestInteriorTemperature':
        return retr.sendRawCommand({ data: '080' }).then(() => true);

      case 'enterCode':
        return retr.sendRawCommand({ data: '200', params: params?.toString?.()?.substring?.(0, 6) ?? '' }).then(() => true);

      default:
        generateLog({
          level: 'warn',
          caller: 'envisalink::sendCommand',
          message: 'Unknown command requested',
          errorKey: 'ENVISALINK_UNSUPPORTED_COMMAND_REQUESTED',
          context: {
            command,
            params
          }
        });
        return Promise.resolve(false);
    }
  };

  retr.sendRawCommand = ({ data, params = '', includeChecksum = true, includeTerminators = true } = {}) => {
    if (!retr.isConnected()) {
      return Promise.reject(wrapError({
        caller: 'envisalink::sendRawCommand',
        reason: 'Not connected to any remote host',
        errorKey: 'ENVISALINK_SEND_RAW_COMMAND_NO_CONNECTION',
        context: {
          data,
          params,
          includeChecksum,
          includeTerminators,
          destroyed: activeConnection ? activeConnection.destroyed : undefined
        }
      }));
    }

    const payload = `${data}${params ?? ''}`;
    let checksum = 0;
    for (let i = 0; i < payload.length; i++) {
      checksum += payload.charCodeAt(i);
    }

    checksum = (checksum % 256).toString(16).toUpperCase().padStart(2, '0');
    let sendData = payload;

    if (includeChecksum) {
      sendData += checksum;
    }

    printSendPacket(`Data sent: '${sendData}${includeTerminators ? '\\r\\n' : ''}'`);
    if (includeTerminators) {
      sendData += '\r\n';
    }
    activeConnection.write(sendData);
    return Promise.resolve(sendData);
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
      throw wrapError({
        caller: 'envisalink::connectToInvisalink',
        reason: 'Port number is not valid',
        errorKey: 'ENVISALINK_INVALID_NETWORK_PORT',
        context: {
          port
        }
      });
    }

    activeConnection = nwTcp.createConnection({ port: port || '4025', host: netCon.host });

    printDebug(`[Debug] [connectToInvisalink()]: TCP link established to port '${netCon.port}'`);
  
    activeConnection.on('connect', cbs.onConnectCb);
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
      onConnectCb: connOnConnect,
      onErrCb: connOnError,
      onCloseCb: connOnClose,
      onEndCb: connOnEnd,
      onDataCb: connOnData,
      ...defaultCallbackHandlers
    };

    shouldReconnect = parseReconnectSetting(connectionOptions.shouldReconnect);
  
    if (!connectionOptions.host) {
      throw wrapError({
        caller: 'envisalink::init',
        reason: 'Host is not valid',
        errorKey: 'ENVISALINK_INVALID_NETWORK_HOST',
        context: {
          host: connectionOptions.host
        }
      });
    }

    if (!auth.pass) {
      throw wrapError({
        caller: 'envisalink::init',
        reason: 'Panel password is not valid',
        errorKey: 'ENVISALINK_INVALID_AUTH_PASSWORD',
        context: {
          hasAuthenticationObject: Boolean(authentication),
          passType: typeof auth.pass
        }
      });
    }

    if (typeof(cbs.onErrCb) !== 'function') {
      throw wrapError({
        caller: 'envisalink::init',
        reason: 'Default callback onErrCb is not a function',
        errorKey: 'ENVISALINK_INVALID_DEFAULT_ON_ERROR_CALLBACK',
        context: {
          callbackType: typeof(cbs.onErrCb)
        }
      });
    }

    if (typeof(cbs.onCloseCb) !== 'function') {
      throw wrapError({
        caller: 'envisalink::init',
        reason: 'Default callback onCloseCb is not a function',
        errorKey: 'ENVISALINK_INVALID_DEFAULT_ON_CLOSE_CALLBACK',
        context: {
          callbackType: typeof(cbs.onCloseCb)
        }
      });
    }

    if (typeof(cbs.onEndCb) !== 'function') {
      throw wrapError({
        caller: 'envisalink::init',
        reason: 'Default callback onEndCb is not a function',
        errorKey: 'ENVISALINK_INVALID_DEFAULT_ON_END_CALLBACK',
        context: {
          callbackType: typeof(cbs.onEndCb)
        }
      });
    }

    if (typeof(parsedCallbacks.onError) !== 'function') {
      throw wrapError({
        caller: 'envisalink::init',
        reason: 'Callback onError is not a function',
        errorKey: 'ENVISALINK_INVALID_ON_ERROR_CALLBACK',
        context: {
          callbackType: typeof(parsedCallbacks.onError)
        }
      });
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
    generateLog({
      level: 'debug',
      caller: 'envisalink::printDebug',
      message: 'Partition state snapshot',
      context: {
        zoneCount: zoneArr.length,
        partitions
      }
    });
  };

  retr.getPartitionState = () => {
    return JSON.parse(JSON.stringify(partitions));
  };

  retr.getSystemState = () => {
    return JSON.parse(JSON.stringify(systemState));
  };

  retr.getZonesState = () => {
    return JSON.parse(JSON.stringify(zones));
  };

  retr.splitDumpToZones = (data) => {
    const zoneTimes = data.match(/.{1,4}/g) ?? [];
    const zonesWithDetails = {};

    let foundEnd = false;
    for (let i = zoneTimes.length - 1; i >= 0; i--) {
      const zoneTime = zoneTimes[i];

      if (zoneTime !== '0000') {
        foundEnd = true;
      }

      if (foundEnd) {
        const bytePairs = zoneTime.match(/[a-fA-F0-9]{2}/g);
        if (!bytePairs || bytePairs.length === 0) {
          continue;
        }

        const reverseEndian = bytePairs.reverse().join('');
        const differenceIn5Seconds = parseInt(0xFFFF - parseInt(reverseEndian, 16)) * 5;
        const zone = String(i + 1);
        zonesWithDetails[zone] = {
          ...zones[zone],
          zone: i + 1,
          lastUpdate: reverseEndian,
          secondsAgo: differenceIn5Seconds
        };
      }
    }

    zones = {
      ...zones,
      ...zonesWithDetails
    };

    return zones;
  };

  retr.returnFriendlyTime = (givenTime) => {
    if (givenTime) {
      return new Date(givenTime).toISOString().replace(/T/, ' ').replace(/\..+/, '');
    }

    return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  }

  // Login
  retr.handleLoginPrompt = ({ commandType, commandParam }) => {
    switch (commandParam) {
      case '0':
        generateError({
          caller: 'envisalink::handleLoginPrompt',
          reason: 'Incorrect password reported by panel',
          errorKey: 'ENVISALINK_LOGIN_FAILED_BAD_CREDENTIALS',
          context: {
            commandType,
            commandParam
          }
        });
        break

      case '1':
        generateLog({
          level: 'info',
          caller: 'envisalink::handleLoginPrompt',
          message: 'Password accepted. Login successful',
          context: {
            commandType,
            commandParam
          }
        });
        break
  
      case '2':
        generateError({
          caller: 'envisalink::handleLoginPrompt',
          reason: 'Connection closed before password was provided in time',
          errorKey: 'ENVISALINK_LOGIN_FAILED_TIMEOUT',
          context: {
            commandType,
            commandParam
          }
        });
        break

      case '3':
        generateLog({
          level: 'info',
          caller: 'envisalink::handleLoginPrompt',
          message: 'Attempting login with panel password',
          context: {
            commandType,
            commandParam
          }
        });
        retr.sendRawCommand({ data: '005', params: auth.pass }).catch((err) => {
          notifyError(generateError({
            caller: 'envisalink::handleLoginPrompt',
            reason: 'Failed to send login credentials after prompt',
            errorKey: 'ENVISALINK_LOGIN_SEND_CREDENTIALS_FAILED',
            err,
            includeStackTrace: true,
            log: false,
            context: {
              commandType,
              commandParam
            }
          }));
        });
        break

      default:
        generateLog({
          level: 'error',
          caller: 'envisalink::handleLoginPrompt',
          message: 'Unknown login state. Will not process',
          errorKey: 'ENVISALINK_UNKNOWN_LOGIN_STATE',
          context: {
            commandType,
            commandParam
          }
        });

    };
  };

  // Timed Out!
  retr.handleConnTimeout = (data) => {
    generateError({
      caller: 'envisalink::handleConnTimeout',
      reason: 'Connection timeout reported by panel',
      errorKey: 'ENVISALINK_CONNECTION_TIMEOUT_RESPONSE',
      context: {
        raw: data
      }
    });
  };

  retr.handleZoneTimerDump = ({ commandType, commandParam, commandChecksum }) => {
    const parsedResults = retr.splitDumpToZones(commandParam);
    const zoneTimerDumpCallback = parsedCallbacks.zoneTimerDumpCb ?? parsedCallbacks.onReceiveZoneTimerDump;
    if (typeof(zoneTimerDumpCallback) === 'function') {
      zoneTimerDumpCallback({
        raw: `${commandType}${commandParam}${commandChecksum}`,
        commandType,
        commandParam,
        commandChecksum,
        zones: parsedResults,
        parsedResults
      });
    }

    emitPanelEvent({
      raw: `${commandType}${commandParam}${commandChecksum}`,
      commandType,
      commandParam,
      commandChecksum,
      category: 'zoneTimerDump',
      event: 'zoneTimerDump',
      eventText: 'Zone timer dump received',
      state: parsedResults
    });
  };

  const parseVerboseTrouble = (commandParam) => {
    return decodeVerboseTroubleBits(commandParam);
  };

  const parseTemperatureBroadcast = (commandParam) => {
    const normalizedParam = normalizeStringInput(commandParam);
    if (!/^\d{4}$/.test(normalizedParam)) {
      return null;
    }

    return {
      thermostat: Number.parseInt(normalizedParam[0], 10),
      temperature: Number.parseInt(normalizedParam.slice(1), 10)
    };
  };

  retr.getHistory = () => {
    return JSON.parse(JSON.stringify(historyLog));
  };

  retr.parseIncoming = (message) => {
    const commandData = message.commandData;
    const asciiCommandType = commandData.split(',')[0];
    if (asciiCommandType.startsWith('%') || asciiCommandType.startsWith('^')) {
      appendHistory({ commandType: asciiCommandType, data: commandData });
      generateLog({
        level: 'warn',
        caller: 'envisalink::parseIncoming',
        message: 'Ignoring unsupported ASCII TPI frame in DSC parser',
        errorKey: 'ENVISALINK_UNKNOWN_EVENT_RECEIVED',
        context: {
          commandType: asciiCommandType,
          commandData
        }
      });

      return;
    }

    const commandType = commandData.substring(0, 3);
    const commandParam = commandData.substring(3, (commandData.length - 2));
    const commandChecksum = commandData.substring((commandData.length - 2));
    appendHistory({ commandType: commandType, data: commandParam, checksum: commandChecksum });

    switch (commandType) {
      case '500':
        printCommandData(`[${commandType}] - ACKN: Command '${commandParam}' received`);
        if (commandParam.startsWith('200')) {
          updateSystemState({
            patch: {
              codeRequired: false,
              codePromptType: null,
              codePromptPartition: null,
              codePromptLength: null
            }
          });
        }
        break
      case '501':
        generateLog({
          level: 'warn',
          caller: 'envisalink::parseIncoming',
          message: 'Panel reported a bad checksum',
          errorKey: 'ENVISALINK_BAD_CHECKSUM_RESPONSE',
          context: {
            commandType,
            commandParam,
            commandChecksum,
            commandData
          }
        });
        break
      case '502':
        generateLog({
          level: 'error',
          caller: 'envisalink::parseIncoming',
          message: 'Panel reported an error response',
          errorKey: 'ENVISALINK_PANEL_ERROR_RESPONSE',
          context: {
            commandType,
            commandParam,
            commandChecksum,
            commandData
          }
        });
        break
      case '505':
        printCommandData(`[${commandType}] - LGIN: Login`);
        retr.handleLoginPrompt({ commandType, commandParam });
        break

      case '510':
        printCommandData(`[${commandType}] - KPLD: Keypad LED state '${commandParam}', '0b${toBinaryString(commandParam) ?? 'unknown'}'`);
        emitKeypadUpdate({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'keypadLedState',
          stateType: 'led'
        });
        break

      case '511':
        printCommandData(`[${commandType}] - KPLF: Keypad LED flash state '${commandParam}', '0b${toBinaryString(commandParam) ?? 'unknown'}'`);
        emitKeypadUpdate({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'keypadLedFlashState',
          stateType: 'flash'
        });
        break

      case '550':
        printCommandData(`[${commandType}] - TIME: Time broadcast '${commandParam}'`);
        emitKeypadUpdate({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'timeBroadcast',
          stateType: 'time'
        });
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'timeBroadcast',
          eventText: 'Time broadcast received',
          patch: {
            panelTime: commandParam
          }
        });
        break

      case '560': {
        printCommandData(`[${commandType}] - OUTD: Outdoor temperature broadcast '${commandParam}'`);
        const temperatureState = parseTemperatureBroadcast(commandParam);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'outdoorTemperatureBroadcast',
          eventText: 'Outdoor temperature broadcast received',
          patch: {
            exteriorTemperature: temperatureState
          },
          metadata: {
            thermostat: temperatureState?.thermostat ?? null,
            temperature: temperatureState?.temperature ?? null
          }
        });
        break
      }

      case '561':
        printCommandData(`[${commandType}] - RING: Telephone ring detected'`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'telephoneRingDetected',
          eventText: 'Telephone ring detected',
          patch: {
            lastTelephoneRingAt: new Date().toISOString()
          }
        });
        break

      case '562': {
        printCommandData(`[${commandType}] - INDT: Indoor temperature broadcast '${commandParam}'`);
        const temperatureState = parseTemperatureBroadcast(commandParam);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'indoorTemperatureBroadcast',
          eventText: 'Indoor temperature broadcast received',
          patch: {
            interiorTemperature: temperatureState
          },
          metadata: {
            thermostat: temperatureState?.thermostat ?? null,
            temperature: temperatureState?.temperature ?? null
          }
        });
        break
      }

      case '601':
        printCommandData(`[${commandType}] - ZNAL: Zone '${commandParam}' alarm'`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '602':
        printCommandData(`[${commandType}] - ZNAR: Zone '${commandParam}' alarm restore'`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '603':
        printCommandData(`[${commandType}] - ZTAL: Zone '${commandParam}' tamper alarm'`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '604':
        printCommandData(`[${commandType}] - ZTAR: Zone '${commandParam}' tamper alarm restore'`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '605':
        printCommandData(`[${commandType}] - ZFAL: Zone '${commandParam}' fault'`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '606':
        printCommandData(`[${commandType}] - ZFAR: Zone '${commandParam}' fault restore'`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break
  
      case '609':
        printCommandData(`[${commandType}] - ZNON: Zone '${commandParam}' open`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '610':
        printCommandData(`[${commandType}] - ZNRS: Zone '${commandParam}' restored`);
        emitZonePanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break
  
      case '615':
        printCommandData(`[${commandType}] - ZTDP: Zone timer dump received`);
        retr.handleZoneTimerDump({ commandType, commandParam, commandChecksum });
        break

      case '616':
        printCommandData(`[${commandType}] - BZBD: Bypassed zones bitfield dump received`);
        emitZoneBypassUpdate({ commandType, commandParam, commandChecksum, commandData });
        break

      case '620':
        printCommandData(`[${commandType}] - DARM: Duress alarm from code ${commandParam}`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'duressAlarm',
          eventText: 'Duress alarm from code',
          patch: {
            lastDuressCode: commandParam
          }
        });
        break

      case '621':
        printCommandData(`[${commandType}] - FKRM: Fire alarm key from panel`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '622':
        printCommandData(`[${commandType}] - FKRR: Fire alarm key restored`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '623':
        printCommandData(`[${commandType}] - AKRM: Aux key alarm from panel`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '624':
        printCommandData(`[${commandType}] - AKRR: Aux key alarm restore`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '625':
        printCommandData(`[${commandType}] - PKRM: Panic key alarm from panel`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '626':
        printCommandData(`[${commandType}] - PKRR: Panic key alarm restore`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '631':
        printCommandData(`[${commandType}] - SARM: Smoke alarm`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '632':
        printCommandData(`[${commandType}] - SRRM: Smoke alarm restored`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break
  
      case '650':
        printCommandData(`[${commandType}] - PRDY: Partition '${commandParam}' ready`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '651':
        printCommandData(`[${commandType}] - PNRY: Partition '${commandParam}' not ready`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '652':
        printCommandData(`[${commandType}] - PARM: Partition '${commandParam}' armed`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '653':
        printCommandData(`[${commandType}] - PFRY: Partition '${commandParam}' force ready`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '654':
        printCommandData(`[${commandType}] - PLRM: Partition '${commandParam}' in alarm`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '655':
        printCommandData(`[${commandType}] - PDRM: Partition '${commandParam}' disarmed`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '656':
        printCommandData(`[${commandType}] - PDXT: Delayed exit in progress for partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '657':
        printCommandData(`[${commandType}] - PDEN: Delayed entry in progress for partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '658':
        printCommandData(`[${commandType}] - KPLK: Keypad lockout in partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '659':
        printCommandData(`[${commandType}] - KPFL: Keypad failed to arm in partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '660':
        printCommandData(`[${commandType}] - PGMO: PGM output in partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '663':
        printCommandData(`[${commandType}] - DCHE: Door chime enabled in partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '664':
        printCommandData(`[${commandType}] - DCHD: Door chime disabled in partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '670':
        printCommandData(`[${commandType}] - KPIV: Invalid access code was entered in partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '671':
        printCommandData(`[${commandType}] - NOFN: Function not available for partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '672':
        printCommandData(`[${commandType}] - FARM: Failed to arm partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break
  
      case '673':
        printCommandData(`[${commandType}] - PTBY: Partition '${commandParam}' busy`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '674':
        printCommandData(`[${commandType}] - ARIP: Partition '${commandParam}' arming in progress`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '680':
        printCommandData(`[${commandType}] - INSM: Installer mode entered`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'installersMode',
          eventText: 'Installer mode entered',
          patch: {
            installersMode: true
          }
        });
        break

      case '700':
        printCommandData(`[${commandType}] - USER: Partition '${commandParam[0]}' armed by user '${commandParam.slice(1)}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '701':
        printCommandData(`[${commandType}] - SPCL: Partition '${commandParam[0]}' armed by special closing`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '702':
        printCommandData(`[${commandType}] - PART: Partition '${commandParam[0]}' partial closing`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '750':
        printCommandData(`[${commandType}] - USER: Partition '${commandParam[0]}' disarmed by user '${commandParam.slice(1)}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '751':
        printCommandData(`[${commandType}] - SPCL: Partition '${commandParam[0]}' special disarm`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '800':
        printCommandData(`[${commandType}] - BATL: Panel low battery trouble`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '801':
        printCommandData(`[${commandType}] - BATR: Panel low battery trouble restored`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '802':
        printCommandData(`[${commandType}] - ACLO: AC power lost`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '803':
        printCommandData(`[${commandType}] - ACRE: AC power restored`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '806':
        printCommandData(`[${commandType}] - BELL: Bell trouble`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '807':
        printCommandData(`[${commandType}] - BCLR: Bell trouble restored`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '814':
        printCommandData(`[${commandType}] - STMP: System tamper`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '815':
        printCommandData(`[${commandType}] - STMR: System tamper restored`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '816':
        printCommandData(`[${commandType}] - BUFN: Panel event buffer near full`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '829':
        printCommandData(`[${commandType}] - STMP: System tamper`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '830':
        printCommandData(`[${commandType}] - STMR: System tamper restored`);
        emitGeneralKeypadEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '840':
        printCommandData(`[${commandType}] - TRLN: Trouble LED on for partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '841':
        printCommandData(`[${commandType}] - TRLF: Trouble LED off for partition '${commandParam}'`);
        emitPartitionPanelEvent({ commandType, commandParam, commandChecksum, commandData });
        break

      case '842':
        printCommandData(`[${commandType}] - FIRT: Fire trouble alarm`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'fireTroubleAlarm',
          eventText: 'Fire trouble alarm',
          patch: {
            fireTrouble: true
          }
        });
        break

      case '843':
        printCommandData(`[${commandType}] - FIRT: Fire trouble alarm restored`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'fireTroubleAlarmRestore',
          eventText: 'Fire trouble alarm restored',
          patch: {
            fireTrouble: false
          }
        });
        break
  
      case '849':
        printCommandData(`[${commandType}] - VTST: Verbose Trouble Status '${commandParam}', '0b${toBinaryString(commandParam) ?? 'unknown'}'`);
        {
          const verboseTrouble = parseVerboseTrouble(commandParam);
          emitSystemEvent({
            commandType,
            commandParam,
            commandChecksum,
            commandData,
            event: 'verboseTroubleStatus',
            eventText: 'Verbose trouble status received',
            patch: {
              verboseTroubleCode: verboseTrouble.hex,
              verboseTroubleBinary: verboseTrouble.binary,
              verboseTroubleMessages: verboseTrouble.descriptions,
              verboseTroubleFlags: verboseTrouble.flags,
              acPresent: verboseTrouble.acPresent,
              serviceRequired: verboseTrouble.flags.serviceRequired,
              acPowerLost: verboseTrouble.flags.acPowerLost,
              telephoneLineFault: verboseTrouble.flags.telephoneLineFault,
              failureToCommunicate: verboseTrouble.flags.failureToCommunicate,
              zoneSensorFault: verboseTrouble.flags.zoneSensorFault,
              zoneSensorTamper: verboseTrouble.flags.zoneSensorTamper,
              zoneSensorLowBattery: verboseTrouble.flags.zoneSensorLowBattery,
              lossOfTime: verboseTrouble.flags.lossOfTime
            },
            metadata: {
              verboseTroubleMessages: verboseTrouble.descriptions,
              verboseTroubleFlags: verboseTrouble.flags
            }
          });
        }
        break
  
      case '900':
        printCommandData(`[${commandType}] - CDRQ: Code required.`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'codeRequired',
          eventText: 'User code required',
          patch: {
            codeRequired: true,
            codePromptType: 'user',
            codePromptPartition: commandParam?.[0] ?? null,
            codePromptLength: commandParam?.[1] ?? null
          }
        });
        break

      case '912':
        printCommandData(`[${commandType}] - PGMO: Command output pressed '${commandParam}'`);
        {
          const partition = commandParam?.[0] ? normalizePartitionId(commandParam[0]) : null;
          const output = commandParam?.[1] ?? null;
          let nextPartition = null;
          if (partition) {
            nextPartition = updatePartitionRecord({
              partition,
              patch: {
                pgmOutput: true,
                [`pgm${output}LastTriggeredAt`]: new Date().toISOString(),
                lastEventCode: commandType,
                lastEvent: 'commandOutputPressed',
                lastEventText: 'Command output pressed',
                lastEventAt: new Date().toISOString()
              }
            });

            if (typeof(parsedCallbacks.partitionUpdateCb) === 'function') {
              parsedCallbacks.partitionUpdateCb({
                raw: commandData,
                commandType,
                commandParam,
                commandChecksum,
                partition,
                event: 'commandOutputPressed',
                eventText: 'Command output pressed',
                state: nextPartition
              });
            }
          }

          emitSystemEvent({
            commandType,
            commandParam,
            commandChecksum,
            commandData,
            event: 'commandOutputPressed',
            eventText: 'Command output pressed',
            patch: {
              lastCommandOutput: {
                partition,
                output
              }
            },
            metadata: {
              partition,
              output,
              partitionState: nextPartition
            }
          });
        }
        break

      case '921':
        printCommandData(`[${commandType}] - MCDR: Master code required.`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'masterCodeRequired',
          eventText: 'Master code required',
          patch: {
            codeRequired: true,
            codePromptType: 'master'
          }
        });
        break

      case '922':
        printCommandData(`[${commandType}] - ICDR: Installer code required.`);
        emitSystemEvent({
          commandType,
          commandParam,
          commandChecksum,
          commandData,
          event: 'installerCodeRequired',
          eventText: 'Installer code required',
          patch: {
            codeRequired: true,
            codePromptType: 'installer'
          }
        });
        break

      default:
        generateLog({
          level: 'error',
          caller: 'envisalink::parseIncoming',
          message: 'Unknown event received. Will not process',
          errorKey: 'ENVISALINK_UNKNOWN_EVENT_RECEIVED',
          context: {
            commandType,
            commandParam,
            commandChecksum,
            commandData
          }
        });
    }
  };


  init();

  return retr;
};

module.exports = Invisalink;
