const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');

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

let wakeups = 0;
const originalWakeup = BotAI.wakeup;
BotAI.wakeup = (session) => {
    wakeups += 1;
    assert.strictEqual(session.accountId, 'bot_hit_wakeup');
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

BotAI.wakeup = originalWakeup;

console.log('Bot AI visibility checks passed');
