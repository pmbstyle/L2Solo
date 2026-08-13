const assert = require('assert');

require('../src/Global');

const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const ServerResponse = invoke('GameServer/Network/Response');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

function effect(key, id, type = 'buff', extra = {}) {
    return {
        key,
        id,
        level: 1,
        type,
        durationMs: 60000,
        ...extra
    };
}

const realNow = Date.now;
let currentTime = 1000;
Date.now = () => currentTime;
const repeatedDebuff = {};
const firstSilence = EffectStore.apply(repeatedDebuff, effect('silence', 4098, 'debuff', {
    level: 8,
    durationMs: 120000
}));
currentTime += 8000;
const repeatedSilence = EffectStore.apply(repeatedDebuff, effect('silence', 4098, 'debuff', {
    level: 8,
    durationMs: 120000
}));
assert.strictEqual(repeatedSilence, null, 'an equal offensive effect must not restart its source timer');
assert.strictEqual(EffectStore.list(repeatedDebuff)[0].expiresAt, firstSilence.expiresAt, 'rejected Silence must retain its original expiry');

const repeatedBuff = {};
const firstShield = EffectStore.apply(repeatedBuff, effect('shield', 1040, 'buff'));
currentTime += 5000;
const refreshedShield = EffectStore.apply(repeatedBuff, effect('shield', 1040, 'buff'));
assert(refreshedShield, 'an equal friendly buff should refresh');
assert(refreshedShield.expiresAt > firstShield.expiresAt, 'a refreshed friendly buff should get a new expiry');
Date.now = realNow;

const sourcedStun = {};
const shieldStun = C4SkillRules.resolve({ selfId: 92, level: 1, name: 'Shield Stun' });
const npcStun = C4SkillRules.resolve({ selfId: 4075, level: 2, name: 'Shock' });
const firstStun = EffectStore.apply(sourcedStun, effect('stun', 92, 'debuff', {
    stackFamily: shieldStun.stackFamily,
    stackOrder: shieldStun.stackOrder
}));
const repeatedStun = EffectStore.apply(sourcedStun, effect('stun', 4075, 'debuff', {
    level: 2,
    stackFamily: npcStun.stackFamily,
    stackOrder: npcStun.stackOrder
}));
assert.deepStrictEqual(
    [shieldStun.stackFamily, shieldStun.stackOrder, npcStun.stackFamily, npcStun.stackOrder],
    ['Stun', 1, 'Stun', 1],
    'control effects should carry their sourced stack family and order'
);
assert.strictEqual(repeatedStun, null, 'a higher skill level must not restart an equal-order control effect');
assert.strictEqual(EffectStore.list(sourcedStun)[0], firstStun, 'the original equal-order stun should retain ownership');

const shockBlast = C4SkillRules.resolve({ selfId: 361, level: 1, name: 'Shock Blast' });
const strongerStun = EffectStore.apply(sourcedStun, effect('stun', 361, 'debuff', {
    stackFamily: shockBlast.stackFamily,
    stackOrder: shockBlast.stackOrder
}));
assert(strongerStun, 'a sourced higher-order control effect should replace the current stack owner');
assert.strictEqual(EffectStore.list(sourcedStun)[0].id, 361, 'the order-two stun should own the shared Stun stack');

const physicalBuffs = {};
const might = C4SkillRules.resolve({ selfId: 1068, level: 3, name: 'Might' });
const chantOfBattle = C4SkillRules.resolve({ selfId: 1007, level: 3, name: 'Chant of Battle' });
EffectStore.apply(physicalBuffs, effect('might', 1068, 'buff', {
    level: 3,
    stackFamily: might.stackFamily,
    stackOrder: might.stackOrder,
    stats: might.stats
}));
EffectStore.apply(physicalBuffs, effect('chant_of_battle', 1007, 'buff', {
    level: 3,
    stackFamily: chantOfBattle.stackFamily,
    stackOrder: chantOfBattle.stackOrder,
    stats: chantOfBattle.stats
}));
assert.deepStrictEqual(
    [might.stackFamily, chantOfBattle.stackFamily, might.stackOrder, chantOfBattle.stackOrder],
    ['pAtk', 'pAtk', 1.15, 1.15],
    'equivalent P.Atk buffs should retain their shared sourced stack metadata'
);
assert.deepStrictEqual(EffectStore.list(physicalBuffs).map((entry) => entry.key), ['chant_of_battle'], 'the latest equal P.Atk buff should replace the previous source');
assert.strictEqual(EffectStats.multiplier(physicalBuffs, 'pAtkMul'), 1.15, 'equivalent P.Atk buffs must not multiply together');

const prophecyStack = {};
const prophecyOfFire = C4SkillRules.resolve({ selfId: 1356, level: 1, name: 'Prophecy of Fire' });
const chantOfVictory = C4SkillRules.resolve({ selfId: 1363, level: 1, name: 'Chant of Victory' });
EffectStore.apply(prophecyStack, effect('prophecy_of_fire', 1356, 'buff', {
    stackFamily: prophecyOfFire.stackFamily,
    stackOrder: prophecyOfFire.stackOrder,
    stats: prophecyOfFire.stats
}));
EffectStore.apply(prophecyStack, effect('chant_of_victory', 1363, 'buff', {
    stackFamily: chantOfVictory.stackFamily,
    stackOrder: chantOfVictory.stackOrder,
    stats: chantOfVictory.stats
}));
assert.deepStrictEqual(
    [prophecyOfFire.stackFamily, prophecyOfFire.stackOrder, chantOfVictory.stackFamily, chantOfVictory.stackOrder],
    ['CoV', 1, 'CoV', 1],
    'Prophecies and Chant of Victory should preserve their shared sourced stack'
);
assert.deepStrictEqual(EffectStore.list(prophecyStack).map((entry) => entry.key), ['chant_of_victory'], 'only the latest equal CoV-family buff should remain active');

const stacked = { activeBuffs: { sprint: Date.now() + 60000 } };
EffectStore.apply(stacked, effect('sprint', 230, 'buff', {
    level: 2,
    stackFamily: 'SpeedUp',
    stackOrder: 33,
    stats: { runSpdAdd: 33 }
}));
assert.strictEqual(EffectStore.apply(stacked, effect('windWalk', 1204, 'buff', {
    level: 1,
    stackFamily: 'SpeedUp',
    stackOrder: 20,
    stats: { runSpdAdd: 20 }
})), null, 'a weaker member of an occupied C4 stack must be rejected');
assert.strictEqual(EffectStats.add(stacked, 'runSpdAdd'), 33, 'a shared stack family must contribute only one stat value');

const block = EffectStore.apply(stacked, effect('block_wind_walk', 1359, 'debuff', {
    stackFamily: 'SpeedUp',
    stackOrder: 99,
    stats: { runSpdMul: 0.9 }
}));
assert(block, 'a higher-order effect should replace the current stack owner');
assert.deepStrictEqual(EffectStore.list(stacked).map((entry) => entry.key), ['block_wind_walk'], 'the displaced stack member must leave storage and icon state');
assert.strictEqual(stacked.activeBuffs.sprint, undefined, 'stack replacement must clear the displaced legacy marker');

const cappedBuffs = { activeBuffs: {} };
for (let index = 0; index < 21; index += 1) {
    const key = `buff_${index}`;
    cappedBuffs.activeBuffs[key] = Date.now() + 60000;
    EffectStore.apply(cappedBuffs, effect(key, 1000 + index));
}
assert.strictEqual(EffectStore.list(cappedBuffs, { includeDebuffs: false }).length, 20, 'C4 must retain at most twenty counted buffs');
assert.strictEqual(cappedBuffs.effects.buff_0, undefined, 'the oldest buff should be displaced when the buff bar is full');
assert.strictEqual(cappedBuffs.activeBuffs.buff_0, undefined, 'slot eviction must clear the matching legacy marker');

const chantOfLife = C4SkillRules.resolve({ selfId: 1229, level: 6 });
const heartOfPaagrio = C4SkillRules.resolve({ selfId: 1256, level: 1 });
assert.deepStrictEqual(
    [chantOfLife.stackFamily, chantOfLife.stackOrder, heartOfPaagrio.stackFamily, heartOfPaagrio.stackOrder],
    ['life_force_orc', 6, 'life_force_orc', 6],
    'C4 short HoTs should retain their shared sourced stack and per-level order'
);
EffectStore.apply(cappedBuffs, effect('chant_of_life', 1229, 'buff', {
    level: 6,
    stackFamily: chantOfLife.stackFamily,
    stackOrder: chantOfLife.stackOrder,
    hot: { count: 15, intervalMs: 1000, heal: 31 }
}));
assert.strictEqual(EffectStore.list(cappedBuffs, { includeDebuffs: false }).length, 21, 'the C4 short-buff slot must not evict an ordinary buff');
EffectStore.apply(cappedBuffs, effect('heart_of_paagrio', 1256, 'buff', {
    stackFamily: heartOfPaagrio.stackFamily,
    stackOrder: heartOfPaagrio.stackOrder,
    hot: { count: 15, intervalMs: 1000, heal: 31 }
}));
assert.strictEqual(EffectStore.list(cappedBuffs).some((entry) => entry.key === 'chant_of_life'), false, 'equal short HoTs should replace one another in their shared slot');
assert.strictEqual(EffectStore.list(cappedBuffs).some((entry) => entry.key === 'heart_of_paagrio'), true, 'the latest equal short HoT should own the shared slot');

const debuffOverflow = {};
for (let index = 0; index < 20; index += 1) {
    EffectStore.apply(debuffOverflow, effect(`buff_${index}`, 2000 + index));
}
let overflowDebuff = null;
for (let index = 0; index < 11; index += 1) {
    overflowDebuff = EffectStore.apply(debuffOverflow, effect(`debuff_${index}`, 3000 + index, 'debuff'));
}
assert.strictEqual(EffectStore.list(debuffOverflow, { includeDebuffs: false }).length, 19, 'debuffs beyond ten should consume ordinary buff slots');
assert.strictEqual(EffectStore.list(debuffOverflow, { includeBuffs: false }).length, 11, 'overflow accounting must not silently remove the debuff itself');

const statEviction = {};
EffectStore.apply(statEviction, effect('might', 1068, 'buff', { stats: { pAtkMul: 1.15 } }));
for (let index = 1; index < 20; index += 1) {
    EffectStore.apply(statEviction, effect(`buff_${index}`, 7000 + index));
}
for (let index = 0; index < 11; index += 1) {
    overflowDebuff = EffectStore.apply(statEviction, effect(`debuff_${index}`, 8000 + index, 'debuff'));
}
assert.strictEqual(overflowDebuff.removedEffects[0]?.key, 'might', 'slot overflow should report the stat-bearing effect it evicted');
assert.strictEqual(JSON.stringify(overflowDebuff).includes('removedEffects'), false, 'runtime displacement metadata must not leak into persisted effects');

const rawEffects = Array.from({ length: 35 }, (_, index) => ({
    id: 4000 + index,
    level: 1,
    duration: 60
}));
const selfPacket = ServerResponse.abnormalStatusUpdate(rawEffects);
const partyPacket = ServerResponse.partySpelled(2000001, rawEffects);
assert.strictEqual(selfPacket.readInt16LE(1), 30, 'MagicEffectIcons must stay within the three-row C4 capacity');
assert.strictEqual(partyPacket.readInt32LE(9), 20, 'PartySpelled must stay within the two-row C4 capacity');
assert.strictEqual(selfPacket.readInt32LE(3), 4030, 'self overflow should replace the oldest visible slots with later effects');
assert.strictEqual(partyPacket.readInt32LE(13), 4020, 'party overflow should replace the oldest visible slots with later effects');

const shortBuffPanel = {};
for (let index = 0; index < 20; index += 1) {
    EffectStore.apply(shortBuffPanel, effect(`buff_${index}`, 9000 + index));
}
EffectStore.apply(shortBuffPanel, effect('chant_of_life', 1229, 'buff', {
    stackFamily: 'life_force_orc',
    stackOrder: 1
}));
for (let index = 0; index < 10; index += 1) {
    EffectStore.apply(shortBuffPanel, effect(`debuff_${index}`, 9100 + index, 'debuff'));
}
const shortSelfPacket = ServerResponse.abnormalStatusUpdate.fromActor(shortBuffPanel);
const shortPartyPacket = ServerResponse.partySpelled.fromActor({ ...shortBuffPanel, fetchId: () => 2000003 });
const shortStatusPacket = ServerResponse.shortBuffStatusUpdate.fromActor(shortBuffPanel);
assert.strictEqual(shortSelfPacket.readInt16LE(1), 30, 'the short-buff slot must not consume a self abnormal-status slot');
assert.strictEqual(shortSelfPacket.readInt32LE(3), 9000, 'excluding the short buff must preserve the oldest regular self icon');
assert.strictEqual(shortStatusPacket.readUInt8(0), 0xf4, 'Orc HoTs should use the C4 short-buff opcode');
assert.strictEqual(shortStatusPacket.readInt32LE(1), 1229, 'the short-buff packet should carry the Orc HoT skill id');
assert.strictEqual(shortPartyPacket.includes(Buffer.from([0xcd, 0x04, 0x00, 0x00])), true, 'PartySpelled should continue to expose the Orc HoT to party members');
const clearedShortStatus = ServerResponse.shortBuffStatusUpdate.fromActor({});
assert.deepStrictEqual(
    [clearedShortStatus.readInt32LE(1), clearedShortStatus.readInt32LE(5), clearedShortStatus.readInt32LE(9)],
    [0, 0, 0],
    'an empty short-buff slot should send the native clear payload'
);

const legacyOnly = {
    fetchId: () => 2000002,
    activeBuffs: { shield: Date.now() + 60000 }
};
const clearedPacket = ServerResponse.abnormalStatusUpdate.fromActor(legacyOnly);
assert.strictEqual(clearedPacket.readInt16LE(1), 0, 'legacy markers must not resurrect effects absent from the authoritative store');

console.log('C4 effect stack and slot checks passed');
