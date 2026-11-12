'use strict';
// A kill's consequences fail one at a time: a reward, a bot's journal line or a guardian spawn that
// throws is counted (FailureLog `kill.<what>`) and the kill's other consequences still happen; the
// throw never leaves the death (it would reach the hit timer and exit the server). C4 (Lisvus
// L2Attackable.doDie / calculateRewards): a failed reward or quest notification is logged and the
// death goes on.
const assert = require('assert');
require('../src/Global');
const FailureLog = require('../src/FailureLog');
const World = invoke('GameServer/World/World');
const Generics = invoke(path.actor);
const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');
const HotBackgroundParty = invoke('GameServer/Bot/AI/HotBackgroundParty');

const saved = [];
function replace(object, key, value) { const old = object[key]; saved.push(() => { object[key] = old; }); object[key] = value; }
function body(id, x) {
    return { fetchId: () => id, fetchSelfId: () => id, fetchName: () => `b${id}`, fetchLocX: () => x, fetchLocY: () => 0,
        fetchLocZ: () => 0, fetchLevel: () => 20, fetchIsOnline: () => true, isDead: () => false, automation: { abortAll() {} } };
}
function member(id, x) {
    return { accountId: `bot_${id}`, actor: body(id, x), hotBackgroundPartyId: 1, plan: 'hunting',
        coldLifeState: { characterId: id, timing: {}, stats: { lifelongKills: 0, fightsWon: 0, fightsResolved: 0 } } };
}
const count = (site) => FailureLog.snapshot()?.[site] || 0;
try {
    const leader = member(7001, 0), other = member(7002, 10);
    replace(World, 'user', { sessions: [leader, other], revision: 0 });
    replace(HotBackgroundParty, 'leader', () => leader);
    replace(HotBackgroundParty, 'roster', () => [leader, other]);
    replace(World, 'removeNpc', () => {});
    replace(invoke('GameServer/Pets/PetRuntime'), 'rewardDamage', () => 1);
    let quests = 0, memories = [];
    replace(invoke('GameServer/Quest/QuestService'), 'onKill', async () => { quests++; });
    replace(invoke('GameServer/Social/SharedHuntMemory'), 'recordHot', (rewards) => { memories.push(rewards.length); });
    replace(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', async () => {});
    const mob = { fetchId: () => 9001, fetchName: () => 'mob', fetchLocX: () => 60, fetchLocY: () => 0, fetchLevel: () => 20,
        fetchAcquiredExp: () => 100, fetchRewardSp: () => 10 };

    // The leader's EXP award throws: the other member is still paid, both kills count on their rows.
    const paid = [];
    replace(Generics, 'experienceReward', (rewarded) => {
        if (rewarded === leader) throw new TypeError('award failed');
        paid.push(rewarded);
    });
    assert.doesNotThrow(() => NpcDied(leader, leader.actor, mob), 'a failed reward does not leave the death');
    assert.deepStrictEqual(paid, [other], 'the other member is still paid its share');
    assert.deepStrictEqual([leader, other].map((s) => s.coldLifeState.stats.fightsWon), [1, 1], 'both kills count on the rows');
    assert.deepStrictEqual([quests, memories], [1, [2]], 'the quest callback and the hunt memory still run');
    assert.strictEqual(count('kill.rewards'), 1, 'the failed award is counted once');

    // The bot's journal line throws: EXP is still paid to both.
    paid.length = 0;
    replace(Generics, 'experienceReward', (rewarded) => paid.push(rewarded));
    replace(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', () => { throw new Error('journal failed'); });
    assert.doesNotThrow(() => NpcDied(leader, leader.actor, mob));
    assert.deepStrictEqual(paid, [leader, other], 'a failed journal line costs nobody their EXP');
    assert.strictEqual(count('kill.journal'), 1);

    // A consequence before the corpse is handed over (a fairy tree's guardians) throws: the death
    // still reaches NpcDied, which registers the corpse's decay and respawn and pays the kill.
    let handedOver = 0;
    replace(Generics, 'npcDied', () => { handedOver++; });
    replace(invoke('GameServer/Items/SoulCrystalProgression'), 'onDeath', async () => {});
    replace(invoke('GameServer/Pets/FairyTrees'), 'onDeath', () => { throw new TypeError('guardians failed'); });
    const corpse = { fetchId: () => 9002, fetchSelfId: () => 20001, fetchIsKillable: () => true, fetchIsRaidBoss: () => false,
        fetchIsSummon: () => false, model: {}, destructor() {},
        state: { dead: false, fetchDead() { return this.dead; }, setDead(value) { this.dead = value; } } };
    assert.doesNotThrow(() => invoke('GameServer/Npc/Generics/Die')({ dataSendToMeAndOthers() {} }, leader.actor, corpse));
    assert.deepStrictEqual([corpse.state.dead, handedOver], [true, 1], 'the corpse is still handed over to NpcDied');
    assert.strictEqual(count('kill.fairy_tree'), 1);

    // A character's death: its EXP loss throws before the body is marked dead and its life row
    // throws after. The body still dies (dead, die packet), the died situation still reaches the
    // worker and the journal still gets its line; each failure is counted.
    {
        const fs = require('fs'), vm = require('vm'), { createRequire } = require('node:module');
        const filename = require.resolve('../src/GameServer/Actor/Generics/Die.js');
        const seen = { diePackets: 0, posts: [], journal: 0 };
        const boom = (message) => () => { throw new TypeError(message); };
        const deps = {
            'GameServer/Network/Response': { die: () => Buffer.from([0]) },
            'GameServer/Effects/EffectStore': { prune() {} }, 'GameServer/Effects/EffectTicker': { clearAll() {}, refreshEffects() {} },
            'GameServer/Actor/Generics/CalculateStats': () => {}, 'GameServer/Skills/ChargeLifecycle': { clear() {} },
            'GameServer/Bot/Economy/EconomyContext': { basics: () => ({ deathHours: 1 }) },
            'GameServer/Bot/Economy/EconomicValuation': { progressStats: () => ({}), liveDeathHours: (hours) => hours },
            'GameServer/Bot/AI/KnowledgeLearning': { knowledgeEnabled: () => false },
            'GameServer/Progression/DeathExperience': { applyDeathPenalty: boom('death exp failed') },
            'GameServer/Clan/ClanAllianceService': { onDeath() {} },
            'GameServer/Bot/Population/BotLifeState': { cachedState: () => ({ stats: {} }), recordNearFight: boom('life row failed'),
                notifyNearFacts: (session, reason) => seen.posts.push(reason) },
            'GameServer/Bot/DecisionTrace': { on: () => false },
            'GameServer/Bot/AI/BotEventJournal': { record() { seen.journal++; } }
        };
        const box = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: box, require: createRequire(filename),
            invoke: (name) => deps[name] || {}, Buffer });
        const dying = { fetchId: () => 7003, fetchName: () => 'b7003', fetchExp: () => 1000, setExpSp() {}, effects: {},
            dead: false, isDead() { return this.dead; }, destructor() {},
            state: { destructor() {}, setDead(value) { dying.dead = value; } } };
        dying.session = { accountId: 'bot_7003', actor: dying, dataSendToMeAndOthers() { seen.diePackets++; } };
        assert.doesNotThrow(() => box.exports(dying.session, dying), 'a failed consequence does not leave the death');
        assert.deepStrictEqual([dying.dead, seen.diePackets], [true, 1], 'the body is still dead, not alive at 0 HP');
        assert.deepStrictEqual([seen.posts, seen.journal], [['death'], 1], 'the died situation and the journal line still happen');
        assert.deepStrictEqual([count('death.exp_penalty'), count('death.life_row')], [1, 1], 'both failures are counted');
    }
    console.log('Kill consequences: one that fails is counted and the others still run');
} finally { saved.reverse().forEach((restore) => restore()); }
