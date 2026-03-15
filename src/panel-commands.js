'use strict';

const normalizeStringInput = (value) => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return '';
};

const buildFrameDelimiterError = (fieldLabel) =>
  `${fieldLabel} contains carriage return or line feed characters; send one panel command per request`;

const buildInvalidPanelCommand = ({ fieldLabel, error = null }) => ({
  type: 'invalid',
  error: error ?? buildFrameDelimiterError(fieldLabel)
});

const normalizeSingleFrameInput = ({ value, fieldLabel }) => {
  if (typeof value === 'string') {
    if (/[\r\n]/.test(value)) {
      return {
        error: buildFrameDelimiterError(fieldLabel)
      };
    }

    return {
      value: value.trim()
    };
  }

  if (typeof value === 'number') {
    return {
      value: String(value)
    };
  }

  return {
    value: ''
  };
};

const normalizeDigitString = ({ value, fieldLabel, minLength = 1, maxLength = 1 }) => {
  const normalizedInput = normalizeSingleFrameInput({ value, fieldLabel });
  if (normalizedInput.error) {
    return { error: normalizedInput.error };
  }

  const normalizedValue = normalizedInput.value;
  if (!normalizedValue) {
    return { error: `${fieldLabel} is required` };
  }

  if (!/^\d+$/.test(normalizedValue)) {
    return { error: `${fieldLabel} must contain only digits` };
  }

  if (normalizedValue.length < minLength || normalizedValue.length > maxLength) {
    return { error: `${fieldLabel} must be ${minLength === maxLength ? `${minLength}` : `${minLength}-${maxLength}`} digits long` };
  }

  return { value: normalizedValue };
};

const normalizePartitionDigit = (value, fieldLabel = 'Partition') =>
  normalizeDigitString({ value, fieldLabel, minLength: 1, maxLength: 1 });

const normalizeCodeDigits = (value, fieldLabel = 'Code') =>
  normalizeDigitString({ value, fieldLabel, minLength: 4, maxLength: 6 });

const normalizeBooleanFlag = (value, fieldLabel) => {
  if (typeof value === 'boolean') {
    return { value: value ? '1' : '0' };
  }

  const normalizedValue = normalizeStringInput(value).toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalizedValue)) {
    return { value: '1' };
  }

  if (['0', 'false', 'off', 'no'].includes(normalizedValue)) {
    return { value: '0' };
  }

  return { error: `${fieldLabel} must be true/false or 1/0` };
};

const normalizePartitionAndOutput = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const partitionResult = normalizePartitionDigit(value.partition, 'Partition');
    if (partitionResult.error) {
      return partitionResult;
    }

    const outputResult = normalizeDigitString({
      value: value.output,
      fieldLabel: 'Output',
      minLength: 1,
      maxLength: 1
    });
    if (outputResult.error) {
      return outputResult;
    }

    return {
      value: `${partitionResult.value}${outputResult.value}`,
      label: `commandOutput:${partitionResult.value}:${outputResult.value}`,
      followupCode: normalizeStringInput(value.code)
    };
  }

  const normalizedInput = normalizeSingleFrameInput({
    value,
    fieldLabel: 'Command output input'
  });
  if (normalizedInput.error) {
    return { error: normalizedInput.error };
  }

  const normalizedValue = normalizedInput.value;
  if (!/^\d{2}$/.test(normalizedValue)) {
    return { error: 'Command output input must be 2 digits: partition + output' };
  }

  return {
    value: normalizedValue,
    label: `commandOutput:${normalizedValue[0]}:${normalizedValue[1]}`
  };
};

const normalizePartitionCommand = (value, fieldLabel = 'Partition command input') => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const partitionResult = normalizePartitionDigit(value.partition, 'Partition');
    if (partitionResult.error) {
      return partitionResult;
    }

    return {
      value: partitionResult.value,
      label: partitionResult.value,
      followupCode: normalizeStringInput(value.code)
    };
  }

  const partitionResult = normalizePartitionDigit(value, fieldLabel);
  if (partitionResult.error) {
    return partitionResult;
  }

  return {
    value: partitionResult.value,
    label: partitionResult.value
  };
};

const normalizePartitionCodeCommand = (value, commandLabel) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const partitionResult = normalizePartitionDigit(value.partition, 'Partition');
    if (partitionResult.error) {
      return partitionResult;
    }

    const codeResult = normalizeCodeDigits(value.code, 'Code');
    if (codeResult.error) {
      return codeResult;
    }

    return {
      value: `${partitionResult.value}${codeResult.value}`,
      label: `${commandLabel}:${partitionResult.value}:[redacted]`,
      redact: true
    };
  }

  const normalizedInput = normalizeSingleFrameInput({
    value,
    fieldLabel: `${commandLabel} input`
  });
  if (normalizedInput.error) {
    return { error: normalizedInput.error };
  }

  const normalizedValue = normalizedInput.value;
  if (!/^\d{5,7}$/.test(normalizedValue)) {
    return { error: `${commandLabel} input must contain partition + 4-6 digit code` };
  }

  return {
    value: normalizedValue,
    label: `${commandLabel}:${normalizedValue[0]}:[redacted]`,
    redact: true
  };
};

const normalizePanicType = (value) => {
  const normalizedValue = normalizeStringInput(value).toLowerCase();
  const panicMap = {
    '1': { value: '1', label: 'panic:fire' },
    fire: { value: '1', label: 'panic:fire' },
    '2': { value: '2', label: 'panic:ambulance' },
    ambulance: { value: '2', label: 'panic:ambulance' },
    aux: { value: '2', label: 'panic:ambulance' },
    auxiliary: { value: '2', label: 'panic:ambulance' },
    '3': { value: '3', label: 'panic:police' },
    police: { value: '3', label: 'panic:police' }
  };

  if (!panicMap[normalizedValue]) {
    return { error: 'Panic type must be one of fire, ambulance, police, 1, 2, or 3' };
  }

  return panicMap[normalizedValue];
};

const normalizeSingleKeyStroke = (value) => {
  const normalizedInput = normalizeSingleFrameInput({
    value,
    fieldLabel: 'Single keystroke input'
  });
  if (normalizedInput.error) {
    return { error: normalizedInput.error };
  }

  const normalizedValue = normalizedInput.value.toUpperCase();
  if (normalizedValue.length !== 1) {
    return { error: 'Single keystroke input must be exactly 1 character' };
  }

  return {
    value: normalizedValue,
    label: `singleKeyStroke:${normalizedValue}`
  };
};

const normalizePartitionKeyStroke = (value, { defaultPartition = '1' } = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const partitionResult = normalizePartitionDigit(value.partition ?? defaultPartition, 'Partition');
    if (partitionResult.error) {
      return partitionResult;
    }

    const normalizedInput = normalizeSingleFrameInput({
      value: value.keys ?? value.command ?? value.data,
      fieldLabel: 'Keypad input'
    });
    if (normalizedInput.error) {
      return { error: normalizedInput.error };
    }

    const keys = normalizedInput.value;
    if (!keys) {
      return { error: 'Keypad input is required' };
    }

    return {
      value: `${partitionResult.value}${keys.substring(0, 6)}`,
      label: `sendKeyStroke:${partitionResult.value}:${keys.substring(0, 6)}`
    };
  }

  const normalizedInput = normalizeSingleFrameInput({
    value,
    fieldLabel: 'Keypad input'
  });
  if (normalizedInput.error) {
    return { error: normalizedInput.error };
  }

  const keys = normalizedInput.value;
  if (!keys) {
    return { error: 'Keypad input is required' };
  }

  return {
    value: `${defaultPartition}${keys.substring(0, 6)}`,
    label: `sendKeyStroke:${defaultPartition}:${keys.substring(0, 6)}`
  };
};

const normalizeConfiguredPartitionKeyStroke = (
  value,
  {
    code,
    codeEnvVarName,
    defaultPartition = '1'
  } = {}
) => {
  if (!code) {
    return { error: `${codeEnvVarName} is not configured` };
  }

  const keyStroke = normalizePartitionKeyStroke(value, { defaultPartition });
  if (keyStroke.error) {
    return keyStroke;
  }

  const partition = keyStroke.value[0];
  const keys = keyStroke.value.slice(1);
  const combinedKeys = `${code}${keys}`.substring(0, 6);
  return {
    value: `${partition}${combinedKeys}`,
    label: `sendKeyStroke:${partition}:[redacted]`,
    redact: true
  };
};

const normalizeMasterPartitionKeyStroke = (value, { masterCode, defaultPartition = '1' } = {}) =>
  normalizeConfiguredPartitionKeyStroke(value, {
    code: masterCode,
    codeEnvVarName: 'MASTER_CODE',
    defaultPartition
  });

const normalizeInstallerPartitionKeyStroke = (value, { installerCode, defaultPartition = '1' } = {}) =>
  normalizeConfiguredPartitionKeyStroke(value, {
    code: installerCode,
    codeEnvVarName: 'INSTALLER_CODE',
    defaultPartition
  });

const normalizeSetTime = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.now === true || value.current === true) {
      return {
        value: buildCurrentPanelTime(),
        label: 'setTime:now'
      };
    }

    return normalizeSetTime(value.value ?? value.timestamp ?? value.data);
  }

  const normalizedValue = normalizeStringInput(value);
  if (!normalizedValue || normalizedValue.toLowerCase() === 'now') {
    return {
      value: buildCurrentPanelTime(),
      label: 'setTime:now'
    };
  }

  if (!/^\d{10}$/.test(normalizedValue)) {
    return { error: 'Set time value must be 10 digits in hhmmMMDDYY format' };
  }

  return {
    value: normalizedValue,
    label: 'setTime:custom'
  };
};

const buildCurrentPanelTime = () => {
  const now = new Date();
  const parts = [
    now.getHours(),
    now.getMinutes(),
    now.getMonth() + 1,
    now.getDate(),
    now.getFullYear() % 100
  ];

  return parts.map((part) => String(part).padStart(2, '0')).join('');
};

const normalizeCodeSend = (value) => {
  const codeResult = normalizeCodeDigits(value, 'Code');
  if (codeResult.error) {
    return codeResult;
  }

  return {
    value: codeResult.value,
    label: 'enterCode:[redacted]',
    redact: true
  };
};

const namedPanelCommandDefinitions = {
  poll: {
    code: '000',
    normalizeParams: () => ({ value: '', label: 'poll' })
  },
  statusReport: {
    code: '001',
    normalizeParams: () => ({ value: '', label: 'statusReport' })
  },
  dumpZoneTimers: {
    code: '008',
    normalizeParams: () => ({ value: '', label: 'dumpZoneTimers' })
  },
  setTime: {
    code: '010',
    normalizeParams: normalizeSetTime
  },
  commandOutput: {
    code: '020',
    normalizeParams: normalizePartitionAndOutput
  },
  armAway: {
    code: '030',
    normalizeParams: (value) => normalizePartitionCommand(value, 'Partition arm away input')
  },
  armStay: {
    code: '031',
    normalizeParams: (value) => normalizePartitionCommand(value, 'Partition arm stay input')
  },
  armNoEntryDelay: {
    code: '032',
    normalizeParams: (value) => normalizePartitionCommand(value, 'Partition arm zero entry delay input')
  },
  armWithCode: {
    code: '033',
    normalizeParams: (value) => normalizePartitionCodeCommand(value, 'armWithCode')
  },
  disarmWithCode: {
    code: '040',
    normalizeParams: (value) => normalizePartitionCodeCommand(value, 'disarmWithCode')
  },
  setTimestamp: {
    code: '055',
    normalizeParams: (value) => normalizeBooleanFlag(value, 'Timestamp control')
  },
  setTimeBroadcast: {
    code: '056',
    normalizeParams: (value) => normalizeBooleanFlag(value, 'Time broadcast control')
  },
  setTemperatureBroadcast: {
    code: '057',
    normalizeParams: (value) => normalizeBooleanFlag(value, 'Temperature broadcast control')
  },
  panicAlarm: {
    code: '060',
    normalizeParams: normalizePanicType
  },
  singleKeyStroke: {
    code: '070',
    normalizeParams: normalizeSingleKeyStroke
  },
  sendKeyStroke: {
    code: '071',
    normalizeParams: normalizePartitionKeyStroke
  },
  enterUserCodeProgrammingMode: {
    code: '072',
    normalizeParams: (value) => normalizePartitionCommand(value, 'User code programming input')
  },
  enterUserProgramingMode: {
    code: '073',
    normalizeParams: (value) => normalizePartitionCommand(value, 'User programming input')
  },
  keepAlive: {
    code: '074',
    normalizeParams: (value) => normalizePartitionCommand(value, 'Keep alive input')
  },
  requestInteriorTemperature: {
    code: '080',
    normalizeParams: () => ({ value: '', label: 'requestInteriorTemperature' })
  },
  enterCode: {
    code: '200',
    normalizeParams: normalizeCodeSend
  }
};

const namedPanelCommandAliases = {
  armMax: 'armNoEntryDelay',
  commandOutputControl: 'commandOutput',
  disarm: 'disarmWithCode',
  requestInteriorHvacBroadcast: 'requestInteriorTemperature',
  sendCode: 'enterCode',
  setTemperatureBroadcastControl: 'setTemperatureBroadcast'
};

const resolveCommandName = (command) => {
  const normalizedCommand = normalizeStringInput(command);
  if (!normalizedCommand) {
    return '';
  }

  return namedPanelCommandAliases[normalizedCommand] ?? normalizedCommand;
};

const buildNamedPanelCommand = ({ command, params = undefined, options = {} } = {}) => {
  const resolvedCommand = resolveCommandName(command);
  const commandDefinition = namedPanelCommandDefinitions[resolvedCommand];
  if (!commandDefinition) {
    return null;
  }

  const normalizedParams = commandDefinition.normalizeParams
    ? commandDefinition.normalizeParams(params, options)
    : { value: normalizeStringInput(params) };

  if (normalizedParams?.error) {
    return buildInvalidPanelCommand({
      fieldLabel: 'Command parameters',
      error: normalizedParams.error
    });
  }

  return {
    type: 'named',
    command: resolvedCommand,
    code: commandDefinition.code,
    params: normalizedParams?.value ?? '',
    label: normalizedParams?.label ?? resolvedCommand,
    redactedLabel: normalizedParams?.redact ? normalizedParams.label : null,
    followupCode: normalizedParams?.followupCode ? normalizeStringInput(normalizedParams.followupCode) : ''
  };
};

const buildRawPanelCommand = (value = {}) => {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalizedInput = normalizeSingleFrameInput({
      value,
      fieldLabel: 'Raw command data'
    });
    if (normalizedInput.error) {
      return buildInvalidPanelCommand({ fieldLabel: 'Raw command data' });
    }

    const normalizedValue = normalizedInput.value;
    if (!normalizedValue) {
      return null;
    }

    return {
      type: 'raw',
      data: normalizedValue,
      includeChecksum: true,
      includeTerminators: true,
      label: normalizedValue
    };
  }

  const normalizedInput = normalizeSingleFrameInput({
    value: value.data ?? value.raw,
    fieldLabel: 'Raw command data'
  });
  if (normalizedInput.error) {
    return buildInvalidPanelCommand({ fieldLabel: 'Raw command data' });
  }

  const normalizedData = normalizedInput.value;
  if (!normalizedData) {
    return null;
  }

  return {
    type: 'raw',
    data: normalizedData,
    includeChecksum: value.includeChecksum ?? true,
    includeTerminators: value.includeTerminators ?? true,
    label: normalizedData
  };
};

const buildGenericPanelCommand = (value, routeParams = {}, options = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.command !== undefined) {
      return buildNamedPanelCommand({
        command: value.command,
        params: value.params,
        options
      }) ?? buildRawPanelCommand({
        data: value.command,
        includeChecksum: value.includeChecksum ?? true,
        includeTerminators: value.includeTerminators ?? true
      });
    }

    if (value.data !== undefined || value.raw !== undefined) {
      return buildRawPanelCommand({
        data: value.data ?? value.raw,
        includeChecksum: value.includeChecksum ?? true,
        includeTerminators: value.includeTerminators ?? true
      });
    }
  }

  const normalizedInput = normalizeSingleFrameInput({
    value: routeParams.command ?? value,
    fieldLabel: 'Command input'
  });
  if (normalizedInput.error) {
    return buildInvalidPanelCommand({ fieldLabel: 'Command input' });
  }

  const routeCommand = resolveCommandName(normalizedInput.value);
  if (!routeCommand) {
    return null;
  }

  if (namedPanelCommandDefinitions[routeCommand]) {
    return buildNamedPanelCommand({
      command: routeCommand,
      params: routeParams.params,
      options
    });
  }

  return buildRawPanelCommand({ data: normalizedInput.value });
};

const buildKeypadCommand = (value, options = {}) => {
  const normalized = normalizePartitionKeyStroke(value, options);
  if (normalized.error) {
    return buildInvalidPanelCommand({
      fieldLabel: 'Keypad input',
      error: normalized.error
    });
  }

  return {
    type: 'named',
    command: 'sendKeyStroke',
    code: namedPanelCommandDefinitions.sendKeyStroke.code,
    params: normalized.value,
    label: normalized.label
  };
};

const buildConfiguredKeypadCommand = (value, normalizeKeyStroke) => {
  const normalized = normalizeKeyStroke(value);
  if (normalized.error) {
    return buildInvalidPanelCommand({
      fieldLabel: 'Keypad input',
      error: normalized.error
    });
  }

  return {
    type: 'named',
    command: 'sendKeyStroke',
    code: namedPanelCommandDefinitions.sendKeyStroke.code,
    params: normalized.value,
    label: normalized.label,
    redactedLabel: normalized.label
  };
};

const buildMasterKeypadCommand = (value, options = {}) =>
  buildConfiguredKeypadCommand(value, (commandValue) =>
    normalizeMasterPartitionKeyStroke(commandValue, options));

const buildInstallerKeypadCommand = (value, options = {}) =>
  buildConfiguredKeypadCommand(value, (commandValue) =>
    normalizeInstallerPartitionKeyStroke(commandValue, options));

const getPanelCommandValidationError = (panelCommand) => {
  if (panelCommand?.type === 'invalid' && panelCommand.error) {
    return panelCommand.error;
  }

  return null;
};

const getPanelCommandCode = (panelCommand) => {
  if (!panelCommand) {
    return null;
  }

  if (panelCommand.type === 'named') {
    return panelCommand.code ?? namedPanelCommandDefinitions[panelCommand.command]?.code ?? null;
  }

  if (panelCommand.type === 'raw') {
    const rawData = normalizeStringInput(panelCommand.data);
    if (!rawData) {
      return null;
    }

    return rawData.slice(0, 3);
  }

  return null;
};

const buildPanelCommandResponseMatcher = (panelCommand) => {
  const commandCode = getPanelCommandCode(panelCommand);
  if (!commandCode) {
    return null;
  }

  return (panelPacket) => {
    const commandData = normalizeStringInput(panelPacket?.commandData);
    if (commandData.length < 5) {
      return false;
    }

    const responseType = commandData.slice(0, 3);
    if (responseType === '912' && commandCode === '020') {
      return true;
    }

    if (responseType === '502') {
      return true;
    }

    if (!['500', '501'].includes(responseType)) {
      return false;
    }

    const responsePayload = commandData.slice(3, -2);
    return responsePayload.startsWith(commandCode);
  };
};

const formatPanelCommandLabel = (panelCommand) => {
  if (!panelCommand) {
    return 'unknown';
  }

  if (panelCommand.redactedLabel) {
    return panelCommand.redactedLabel;
  }

  if (panelCommand.label) {
    return panelCommand.label;
  }

  if (panelCommand.type === 'named') {
    return panelCommand.command;
  }

  if (panelCommand.type === 'raw') {
    return panelCommand.data;
  }

  return 'unknown';
};

const buildPartitionCommand = ({ command, partition, code = '' } = {}) =>
  buildNamedPanelCommand({
    command,
    params: {
      partition,
      code
    }
  });

const buildPartitionOutputCommand = ({ partition, output, code = '' } = {}) =>
  buildNamedPanelCommand({
    command: 'commandOutput',
    params: {
      partition,
      output,
      code
    }
  });

const buildPanicCommand = (type) =>
  buildNamedPanelCommand({
    command: 'panicAlarm',
    params: type
  });

module.exports = {
  buildFrameDelimiterError,
  buildGenericPanelCommand,
  buildInstallerKeypadCommand,
  buildInvalidPanelCommand,
  buildKeypadCommand,
  buildMasterKeypadCommand,
  buildNamedPanelCommand,
  buildPanicCommand,
  buildPanelCommandResponseMatcher,
  buildPartitionCommand,
  buildPartitionOutputCommand,
  buildRawPanelCommand,
  formatPanelCommandLabel,
  getPanelCommandCode,
  getPanelCommandValidationError,
  namedPanelCommandAliases,
  namedPanelCommandDefinitions,
  normalizeSingleFrameInput,
  normalizeStringInput,
  resolveCommandName
};
