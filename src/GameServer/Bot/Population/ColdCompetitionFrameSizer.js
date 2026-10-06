'use strict';
const Protocol = require('./ColdSimulationProtocol');
const numbersAs32Chars = (_, value) => typeof value === 'number' ? 'x'.repeat(32) : value;
const bytes = value => Buffer.byteLength(JSON.stringify(value, numbersAs32Chars));
// Normal action names need no escaping. Unusual keys get a conservative bound
// without another stringify per action (UTF-8 byte count also covers Unicode).
const actionBytes = name => Buffer.byteLength(name) * (/[\x00-\x1f"\\\ud800-\udfff]/.test(name) ? 6 : 1) + 38;

// One heartbeat batch owns this scratch object. No state survives the batch.
class ColdCompetitionFrameSizer {
    constructor(message, recent = [], limit = Protocol.MAX_MESSAGE_BYTES) {
        this.base = bytes(message); this.limit = limit;
        this.at = message.payload.competition.frame.at;
        this.sum = 0; this.count = 0; this.maxEvent = 0; this.actionBytes = 0;
        this.actions = new Set(Object.keys(message.payload.competition.outcomes || {}));
        for (const event of recent) this.maxEvent = Math.max(this.maxEvent, bytes(event));
        this.estimate = this.base + 12 * (this.maxEvent + 1);
    }
    offer(event) {
        if (this.count >= 160 || !Protocol.competitionEvent(event, this.at)) return false;
        const size = bytes(event), count = this.count + 1, sum = this.sum + size;
        const maxEvent = Math.max(this.maxEvent, size);
        const newAction = event.action !== 'revenge' && !this.actions.has(event.action);
        const nextActionBytes = this.actionBytes + (newAction ? actionBytes(event.action) : 0);
        const estimate = this.base + 2 * (sum + count) + 12 * (maxEvent + 1) + nextActionBytes;
        if (estimate > this.limit) return false;
        Object.assign(this, { sum, count, maxEvent, actionBytes: nextActionBytes, estimate });
        if (newAction) this.actions.add(event.action);
        return true;
    }
}
module.exports = { ColdCompetitionFrameSizer, numbersAs32Chars };
