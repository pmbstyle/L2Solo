'use strict';
// A hot bot's kill moves its progress (EconomicValuation.progressStats: the economy
// clock, played hours, frustration, lifelong kills) and its won fight on its row,
// read from the row the session holds, without capturing the whole body (combat
// profile, every bag row) for each rewarded member.
const assert = require('assert');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Generics = invoke(path.actor);
const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const { SERVER_STARTED_AT } = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');

const saved = [];
function replace(object, key, value) { const old = object[key]; saved.push(() => { object[key] = old; }); object[key] = value; }
function actor(id, x) {
    return { hp: 100, fetchId: () => id, fetchSelfId: () => id, fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchLevel: () => 20, fetchIsOnline: () => true, isDead() { return this.hp <= 0; },
        automation: { abortAll() {} } };
}
try {
    const now = SERVER_STARTED_AT + 3 * 3600000;
    replace(Date, 'now', () => now);
    const bot = actor(7001, 0);
    const stats = { economyClock: now - 1800000, playedHours: 4, frustration: 0.8, lifelongKills: 9,
        fightsWon: 2, fightsResolved: 3, wishFocus: 'kept' };
    const session = { accountId: 'bot_progress', actor: bot, plan: 'hunting',
        coldLifeState: { characterId: 7001, timing: { lastResolvedAt: now - 7200000 }, stats } };
    replace(World, 'user', { sessions: [session], revision: 0 });
    replace(World, 'removeNpc', () => {});
    replace(Generics, 'experienceReward', () => {});
    replace(invoke('GameServer/Quest/QuestService'), 'onKill', async () => {});
    replace(invoke('GameServer/Pets/PetRuntime'), 'rewardDamage', () => 1);
    replace(invoke('GameServer/Social/SharedHuntMemory'), 'recordHot', () => {});
    replace(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', () => {});
    let captures = 0;
    const stateForActor = EconomyContext.stateForActor;
    replace(EconomyContext, 'stateForActor', (...args) => { captures++; return stateForActor(...args); });
    const mob = { fetchId: () => 9001, fetchLocX: () => 60, fetchLocY: () => 0, fetchLevel: () => 20,
        fetchAcquiredExp: () => 100, fetchRewardSp: () => 10 };

    NpcDied(session, bot, mob);

    const after = session.coldLifeState.stats;
    // Half an hour since its economy clock: played, frustration decays by e^-0.5 and
    // the kill relieves 1 / (lifelong kills + 1) of it.
    const kills = Learning.knowledgeEnabled() ? 10 : 9;
    assert.strictEqual(after.economyClock, now, 'the kill moves the economy clock to its time');
    assert.strictEqual(after.playedHours, 4.5, 'the half hour since the last clock is played');
    assert.strictEqual(after.lifelongKills, kills, 'the kill counts toward its lifelong kills');
    assert(Math.abs(after.frustration - Math.max(0, 0.8 * Math.exp(-0.5) - 1 / 10)) < 1e-12,
        'frustration decays over the half hour and the kill relieves it');
    assert.deepStrictEqual([after.fightsWon, after.fightsResolved], [3, 4], 'the kill is a resolved, won fight');
    assert.strictEqual(after.wishFocus, 'kept', 'the row keeps its other stats');
    assert.strictEqual(session.coldLifeState.timing.lastResolvedAt, now - 7200000);
    assert.strictEqual(captures, 0, 'a kill reward does not capture the whole body of a rewarded bot');

    // A killer no longer near the corpse (its poison killed after it went back
    // to town) is paid nothing and its row does not move: C4 pays only those
    // within reward range of the monster.
    const away = actor(7002, 90000);
    const awaySession = { accountId: 'bot_away', actor: away, plan: 'hunting',
        coldLifeState: { characterId: 7002, timing: {}, stats: { lifelongKills: 3, fightsWon: 1, fightsResolved: 1 } } };
    replace(World, 'user', { sessions: [awaySession], revision: 0 });
    const paid = [];
    replace(Generics, 'experienceReward', (rewarded) => paid.push(rewarded));
    NpcDied(awaySession, away, mob);
    assert.deepStrictEqual(paid, [], 'a killer far from the corpse gets no EXP or SP');
    assert.deepStrictEqual(awaySession.coldLifeState.stats, { lifelongKills: 3, fightsWon: 1, fightsResolved: 1 },
        'and the kill is not its won fight');
    console.log('NpcDied: a hot bot\'s kill moves its progress from its row without a body capture');
} finally { saved.reverse().forEach(restore => restore()); }
