const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

let wakeups = 0;
let urgentWakeup = false;
let invalidatedThreatSession = null;
const originalWakeup = BotAI.wakeup;
const originalInvalidateThreatProjection = PartyAwareness.invalidateThreatProjection;
BotAI.wakeup = (session, options) => {
    wakeups += 1;
    urgentWakeup = options?.urgent === true;
    assert.strictEqual(session.accountId, 'bot_hit_wakeup');
};
PartyAwareness.invalidateThreatProjection = (session) => {
    invalidatedThreatSession = session;
    return true;
};

const hitBotActor = {
    hp: 50,
    maxHp: 100,
    id: 2000101,
    session: null,
    state: {
        fetchSeated: () => false,
        fetchCombats: () => false,
        setCombats() {}
    },
    automation: {
        replenishVitals() {}
    },
    fetchId() { return this.id; },
    fetchHp() { return this.hp; },
    fetchMaxHp() { return this.maxHp; },
    setHp(value) { this.hp = value; },
    statusUpdateVitals() {}
};
const hitBotSession = {
    accountId: 'bot_hit_wakeup',
    aiActive: true,
    actor: hitBotActor,
    dataSendToMeAndOthers() {}
};
hitBotActor.session = hitBotSession;

const attacker = {
    fetchId: () => 1001
};
const attackerSession = {
    actor: attacker,
    dataSendToMeAndOthers() {}
};

ReceivedHit(attackerSession, hitBotActor, 7);
assert.strictEqual(hitBotActor.fetchHp(), 43, 'ReceivedHit should still apply damage');
assert.strictEqual(hitBotSession.incomingThreatId, 1001, 'bot victim should remember the fresh attacker');
assert.strictEqual(wakeups, 1, 'bot victim should wake immediately on incoming damage');
assert.strictEqual(urgentWakeup, true, 'damage wakeups must bypass visibility wake coalescing');
assert.strictEqual(invalidatedThreatSession, hitBotSession,
    'incoming damage must invalidate the party threat projection before the urgent wakeup');

BotAI.wakeup = originalWakeup;
PartyAwareness.invalidateThreatProjection = originalInvalidateThreatProjection;

console.log('Bot AI visibility checks passed');
