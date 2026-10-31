const assert = require('assert');

require('../src/Global');

const OverhitReward = invoke('GameServer/Progression/OverhitReward');
const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');

function skill(overHit, selfId = 56) {
    return {
        fetchSelfId: () => selfId,
        fetchLevel: () => 3,
        fetchSemantic: () => ({ overHit })
    };
}

function attacker(id = 2000001, extra = {}) {
    return { fetchId: () => id, ...extra };
}

function target(id = 1000001, hp = 20, maxHp = 100) {
    let currentHp = hp;
    return {
        model: {},
        fetchId: () => id,
        fetchHp: () => currentHp,
        fetchMaxHp: () => maxHp,
        setHp: (value) => { currentHp = value; }
    };
}

const normalTarget = target();
assert.strictEqual(OverhitReward.capture(normalTarget, attacker(), { damage: 30 }), null,
    'normal lethal excess must not qualify');
assert.strictEqual(OverhitReward.consume(normalTarget, attacker(), 1000).bonusExp, 0);

const wrongSkill = target();
assert.strictEqual(OverhitReward.capture(wrongSkill, attacker(), { skill: skill(false), damage: 30 }), null);

const nonLethal = target(1000002, 50, 100);
assert.strictEqual(OverhitReward.capture(nonLethal, attacker(), { skill: skill(true), damage: 40 }), null);

const noExcess = target(1000003, 20, 100);
assert.strictEqual(OverhitReward.capture(noExcess, attacker(), { skill: skill(true), damage: 20 }), null);

const eligible = target(1000004, 20, 100);
const captured = OverhitReward.capture(eligible, attacker(), { skill: skill(true), damage: 30, timestamp: 10 });
assert.strictEqual(captured.overhitDamage, 10);
const reward = OverhitReward.consume(eligible, attacker(), 1000);
assert.deepStrictEqual({ ratio: reward.bonusRatio, bonus: reward.bonusExp, adjusted: reward.adjustedExp },
    { ratio: 0.1, bonus: 100, adjusted: 1100 });
assert.strictEqual(OverhitReward.consume(eligible, attacker(), 1000).bonusExp, 0,
    'kill reward consumption must be idempotent');

const clamped = OverhitReward.contextForHit({
    attacker: attacker(), skill: skill(true), targetHpBeforeHit: 10, targetMaxHp: 100,
    finalDamage: 1000, encounterId: 5
});
assert.deepStrictEqual(OverhitReward.resolveContext(clamped, 1000), {
    eligible: true, baseExp: 1000, bonusRatio: 0.25, bonusExp: 250, adjustedExp: 1250
});

const attributed = target(1000005, 20, 100);
OverhitReward.capture(attributed, attacker(1), { skill: skill(true), damage: 30 });
assert.strictEqual(OverhitReward.consume(attributed, attacker(2), 1000).bonusExp, 0,
    'only the final skill attacker owns the Over-hit');
assert.strictEqual(OverhitReward.consume(attributed, attacker(1), 1000).bonusExp, 0,
    'a failed attribution check must still clear stale encounter state');

const summoned = OverhitReward.contextForHit({
    attacker: attacker(3, { fetchIsSummon: () => true }), skill: skill(true),
    targetHpBeforeHit: 10, targetMaxHp: 100, finalDamage: 20, encounterId: 6
});
assert.strictEqual(summoned, null, 'C4 summon final hits do not own player Over-hit');

const newSpawn = target(1000004, 20, 100);
assert.strictEqual(OverhitReward.consume(newSpawn, attacker(), 1000).bonusExp, 0,
    'Over-hit state must not leak to another spawn with the same object id');

const party = [{ actor: { fetchLevel: () => 20 } }, { actor: { fetchLevel: () => 20 } }];
const baseShares = NpcDied.partyRewardShares(party, 1000, 100);
const adjustedShares = NpcDied.partyRewardShares(party, reward.adjustedExp, 100);
assert.strictEqual(adjustedShares.reduce((sum, entry) => sum + entry.exp, 0), 1430,
    'party distribution must use the adjusted EXP pool and the normal party multiplier');
assert.strictEqual(adjustedShares.reduce((sum, entry) => sum + entry.sp, 0),
    baseShares.reduce((sum, entry) => sum + entry.sp, 0), 'Over-hit must not increase SP');

const coldContext = OverhitReward.contextForHit({
    attacker: { characterId: 2000001 }, skill: skill(true), targetHpBeforeHit: 20,
    targetMaxHp: 100, finalDamage: 30, encounterId: 1000004, timestamp: 10
});
assert.deepStrictEqual(OverhitReward.resolveContext(coldContext, 1000),
    OverhitReward.resolveContext(captured, 1000), 'hot and cold fixtures must share the authoritative formula');

// L2J Lisvus C4 skills data sets overHit on these; a rule that omits it gives no bonus.
for (const selfId of [1, 3, 48, 120, 280, 281, 1339, 1340, 1341, 1342, 1343]) {
    assert.strictEqual(invoke('GameServer/Skills/C4SkillRules').resolve({ selfId }).overHit, true, `skill ${selfId} is an over-hit skill`);
}

console.log('C4 Over-hit runtime and reward checks passed');
