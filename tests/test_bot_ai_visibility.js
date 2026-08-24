const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

function actor(online = true) {
    return {
        fetchIsOnline: () => online
    };
}

const botSession = {
    accountId: 'bot_test',
    actor: actor(true)
};
const visiblePlayer = {
    accountId: 'player_test',
    actor: actor(true)
};
const visibleBot = {
    accountId: 'bot_other',
    actor: actor(true)
};
const offlinePlayer = {
    accountId: 'player_offline',
    actor: actor(false)
};

const World = {
    fetchVisibleUsers() {
        return [visiblePlayer, visibleBot, offlinePlayer];
    }
};

assert.deepStrictEqual(BotAI.visibleRealPlayers(botSession, botSession.actor, World), [visiblePlayer]);
assert.deepStrictEqual(BotAI.visibleRealPlayers(botSession, botSession.actor, { fetchVisibleUsers: () => [] }), []);

const positionedBot = {
    fetchLocX: () => 100,
    fetchLocY: () => 100
};
const positionedPlayer = {
    accountId: 'player_joined_after_cache',
    actor: {
        fetchIsOnline: () => true,
        fetchLocX: () => 150,
        fetchLocY: () => 100
    }
};
const cachedWorld = { user: { revision: 0, sessions: [] } };
assert.deepStrictEqual(BotAI.visibleRealPlayers(botSession, positionedBot, cachedWorld), []);
cachedWorld.user.sessions.push(positionedPlayer);
cachedWorld.user.revision += 1;
assert.deepStrictEqual(
    BotAI.visibleRealPlayers(botSession, positionedBot, cachedWorld),
    [positionedPlayer],
    'a player joining during the cache window must be visible without waiting for the TTL'
);

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
    actor: hitBotActor
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
