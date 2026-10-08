'use strict';
const assert = require('node:assert/strict');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { create } = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const on = create({ config: { developerDiagnostics: true } });
const off = create({ config: { developerDiagnostics: false } });
const hostile = new Proxy({}, { get() { throw Error('off payload work'); } });
assert.equal(off.omitAggregatesOnOverflow(hostile, 'message_too_large'), false);
const event = { key: 'peer:1:2', at: 100, action: 'contest', actor: { id: 1 }, peer: { id: 2 } };
const required = { states: 1700, inFlight: 2, competition: { mode: 'addressed', at: 100,
    events: [event], frame: { frameId: 1, at: 100, events: [event] } } };
const message = Protocol.envelope('heartbeat', 'fixture', { ...required,
    developerDiagnostics: { counts: { overflow: 'x'.repeat(Protocol.MAX_MESSAGE_BYTES) } } }, 'fixed-id');
const envelopeIdentity = { msgId: message.msgId, workerEpoch: message.workerEpoch, sentAt: message.sentAt };
let result = Protocol.validateEnvelope(message, 'worker');
assert.equal(result.reason, 'message_too_large');
assert.equal(on.omitAggregatesOnOverflow(message, result.reason), true);
result = Protocol.validateEnvelope(message, 'worker');
assert.equal(result.ok, true);
assert.deepEqual(message.payload, required);
assert.deepEqual({ msgId: message.msgId, workerEpoch: message.workerEpoch, sentAt: message.sentAt }, envelopeIdentity);
assert.equal(message.payload.competition.events[0], event, 'required game event is not rebuilt or changed');
assert.equal(on.metrics().counts['transport:aggregate_drop:heartbeat_size'], 1);
assert.equal(on.omitAggregatesOnOverflow(message, 'invalid_competition_frame'), false);
assert.equal(on.omitAggregatesOnOverflow(message, 'message_too_large'), false);
console.log('Heartbeat capacity: optional new aggregate cannot reject or alter existing game frame');
