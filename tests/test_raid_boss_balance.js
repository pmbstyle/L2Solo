const assert = require('assert');
const RaidBossBalance = require('../src/GameServer/RaidBoss/RaidBossBalance');

const boss = {
    selfId: 10001,
    template: { kind: 'Boss', raidBoss: true },
    stats: { pAtk: 101, mAtk: 202, pDef: 303, mDef: 404, atkSpd: 278 },
    vitals: { maxHp: 1001, maxMp: 500, revHp: 20 }
};
const minion = {
    selfId: 10002,
    template: { kind: 'Monster' },
    stats: { pAtk: 80, mAtk: 40, pDef: 120, mDef: 60 },
    vitals: { maxHp: 801, maxMp: 200 }
};
const regular = {
    selfId: 1,
    template: { kind: 'Monster' },
    stats: { pAtk: 80, mAtk: 40, pDef: 120, mDef: 60 },
    vitals: { maxHp: 801, maxMp: 200 }
};

assert.strictEqual(RaidBossBalance.isRaidBossTemplate(boss), true);
assert.strictEqual(RaidBossBalance.isRaidBossMinionTemplate(minion), true);
assert.strictEqual(RaidBossBalance.isRaidEntityTemplate(regular), false);

const [scaledBoss, scaledMinion, unchanged] = RaidBossBalance.weakenTemplates([boss, minion, regular]);
assert.deepStrictEqual(scaledBoss.stats, { pAtk: 76, mAtk: 152, pDef: 227, mDef: 303, atkSpd: 278 });
assert.deepStrictEqual(scaledBoss.vitals, { maxHp: 751, maxMp: 500, revHp: 20 });
assert.deepStrictEqual(scaledMinion.stats, { pAtk: 60, mAtk: 30, pDef: 90, mDef: 45 });
assert.deepStrictEqual(scaledMinion.vitals, { maxHp: 601, maxMp: 200 });
assert.deepStrictEqual(unchanged, regular, 'ordinary NPC templates must not be modified');
assert.strictEqual(boss.stats.pAtk, 101, 'source templates must not be mutated');
assert.strictEqual(minion.vitals.maxHp, 801, 'source minion templates must not be mutated');

console.log('test_raid_boss_balance: ok');
