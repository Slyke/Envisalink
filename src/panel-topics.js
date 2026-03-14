'use strict';

const joinTopic = (...segments) =>
  segments
    .map((segment) => String(segment ?? '').trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

const createPanelTopics = (parentTopic) => {
  const root = joinTopic(parentTopic || 'DCS_panel');
  const cmndRoot = joinTopic(root, 'CMND');
  const ackRoot = joinTopic(root, 'ACKC');
  const statRoot = joinTopic(root, 'STAT');

  return {
    root,
    cmndRoot,
    ackRoot,
    statRoot,
    cmndWildcard: joinTopic(cmndRoot, '#'),
    ackCommand: joinTopic(ackRoot, 'command'),
    statConnection: joinTopic(statRoot, 'connection'),
    statMqtt: joinTopic(statRoot, 'mqtt'),
    statSystem: joinTopic(statRoot, 'system'),
    statRaw: joinTopic(statRoot, 'raw'),
    statKeypad: joinTopic(statRoot, 'keypad'),
    statZone: joinTopic(statRoot, 'zone'),
    statZoneBypass: joinTopic(statRoot, 'zoneBypass'),
    statZoneTimerDump: joinTopic(statRoot, 'zoneTimerDump'),
    statPartition: joinTopic(statRoot, 'partition'),
    statCid: joinTopic(statRoot, 'cid'),
    statPanelEvent: joinTopic(statRoot, 'panelEvent'),
    ackTopicForCommandTopic: (commandTopic) => {
      const normalizedTopic = joinTopic(commandTopic);
      if (!normalizedTopic.startsWith(`${cmndRoot}/`)) {
        return null;
      }

      return normalizedTopic.replace(`${cmndRoot}/`, `${ackRoot}/`);
    }
  };
};

module.exports = {
  createPanelTopics,
  joinTopic
};
