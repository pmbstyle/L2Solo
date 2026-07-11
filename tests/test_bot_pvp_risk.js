const assert = require('assert');

require('../src/Global');

const BotPvpRisk = invoke('GameServer/Bot/AI/BotPvpRisk');

function actor(id, options = {}) {
    return {
        fetchId: () => id,
        fetchClanId: () => options.clanId || 0,
        fetchDestId: () => options.targetId || 0,
        fetchIsOnline: () => true,
        state: { fetchDead: () => false }
    };
}

const botSession = { actor: actor(1, { clanId: 10 }) };
const threat = actor(2);
const passerby = { actor: actor(3) };
const clanMate = { actor: actor(4, { clanId: 10 }) };
const activeDefender = { actor: actor(5, { targetId: threat.fetchId() }) };

assert.strictEqual(BotPvpRisk.isCombatAlly(botSession, passerby, threat), false, 'random white passerby should not count as an ally');
assert.strictEqual(BotPvpRisk.isCombatAlly(botSession, clanMate, threat), true, 'nearby clan member should count as an ally');
assert.strictEqual(BotPvpRisk.isCombatAlly(botSession, activeDefender, threat), true, 'character already fighting the PK should count as an ally');

assert.strictEqual(BotPvpRisk.evaluate({
    botLevel: 20,
    threatLevel: 20,
    hpRatio: 1,
    mpRatio: 1,
    allies: 0,
    role: 'dps'
}).action, 'fight', 'healthy equal-level fighter should stand its ground');

assert.strictEqual(BotPvpRisk.evaluate({
    botLevel: 20,
    threatLevel: 20,
    hpRatio: 0.20,
    mpRatio: 1,
    allies: 0,
    role: 'dps'
}).action, 'flee', 'critical HP bot should flee without real support');

assert.strictEqual(BotPvpRisk.evaluate({
    botLevel: 20,
    threatLevel: 23,
    hpRatio: 0.9,
    mpRatio: 0.9,
    allies: 3,
    role: 'tank'
}).action, 'fight', 'real numerical support should justify fighting a stronger PK');

assert.strictEqual(BotPvpRisk.evaluate({
    botLevel: 20,
    threatLevel: 20,
    hpRatio: 0.8,
    mpRatio: 0.1,
    allies: 0,
    role: 'healer'
}).action, 'flee', 'low-MP support bot should avoid an unsupported PK fight');

console.log('Bot PvP risk checks passed');
