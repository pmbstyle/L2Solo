const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const RaidBossBalance = invoke('GameServer/RaidBoss/RaidBossBalance');
const rows = require('../data/Npcs/Minions/c4_group_leaders.json');
const raidRows = require('../data/Npcs/Minions/c4_raid_bosses.json');
const templates = require('../data/Npcs/c4_group_leader_minions.json');
const rewards = require('../data/Npcs/Rewards/c4_group_leader_minions.json');
const skillRows = require('../data/Npcs/Skills/c4_group_leader_minions.json');
const skillTemplates = require('../data/Npcs/Skills/c4_group_leader_minions_templates.json');
const items = require('../data/Items/Others/c4_group_leader_minions.json');

// L2J_Mobius C4 <minions>: 146 rows of ordinary leaders; 117 belong to the 74 leaders our
// world spawns, the Fairy Trees of Q421 (5185-5188) kept without standing minions (T48).
assert.strictEqual(rows.length, 117, 'every Mobius row of a spawned group leader is kept');
const leaderIds = [...new Set(rows.map((row) => row.bossId))];
assert.strictEqual(leaderIds.length, 74);
assert.strictEqual(new Set(rows.map((row) => `${row.bossId}:${row.minionId}`)).size, 117);
assert.ok(rows.every((row) => Object.keys(row).join() === 'bossId,minionId,min,max'
    && row.min >= 1 && row.max >= row.min), 'the raid-boss minion row format is kept');
assert.deepStrictEqual(rows.reduce((sum, row) => [sum[0] + row.min, sum[1] + row.max], [0, 0]), [206, 241]);
assert.ok(!rows.some((row) => [5185, 5186, 5187, 5188].includes(row.bossId)),
    'a Fairy Tree calls its guardians only when it dies (Pets/FairyTrees.js)');
// Rows Lisvus lacks: 1518 Frenzy Stakato Soldier spawns again, with its Splinter Stakato Drone.
assert.deepStrictEqual(rows.find((row) => row.bossId === 1512), { bossId: 1512, minionId: 1518, min: 2, max: 2 });

const raidIds = new Set(raidRows.flatMap((row) => [Number(row.bossId), Number(row.minionId)]));
assert.ok(rows.every((row) => !raidIds.has(row.bossId) && !raidIds.has(row.minionId)),
    'ordinary groups share no leader or minion with the raid groups');

assert.strictEqual(templates.length, 76, 'missing minion templates come from Lisvus npc.sql');
assert.strictEqual(rewards.length, 76);
assert.strictEqual(skillRows.length, 434);
assert.deepStrictEqual(skillTemplates.map((skill) => skill.selfId), [4163, 4340]);
assert.deepStrictEqual(items.map((item) => item.selfId), [5275]);
assert.strictEqual(rewards.reduce((sum, reward) => sum
    + reward.rewards.reduce((count, group) => count + group.items.length, 0)
    + reward.spoils.length, 0), 1194, 'all Lisvus drop and spoil rows of the new minions');

DataCache.init();

const npcById = new Map(DataCache.npcs.map((npc) => [Number(npc.selfId), npc]));
const spawnedIds = new Set(DataCache.npcSpawns.flatMap((area) => area.spawns)
    .filter((spawn) => Number(spawn.total) > 0).map((spawn) => Number(spawn.selfId)));
for (const id of leaderIds) {
    const leader = npcById.get(id);
    assert.ok(leader && spawnedIds.has(id), `group leader ${id} is spawned in the world`);
    assert.notStrictEqual(leader.template.raidBoss, true);
}
for (const row of rows) {
    const minion = npcById.get(row.minionId);
    assert.ok(minion, `minion template ${row.minionId} is loaded`);
    assert.strictEqual(minion.template.kind, 'Monster');
    assert.strictEqual(BotRaidSafety.isProtectedRaidEntity(minion), false,
        'ordinary minions stay huntable, not raid entities');
    assert.strictEqual(RaidBossBalance.isRaidEntityTemplate(minion), false,
        'ordinary minions keep their Lisvus stats');
}
for (const template of templates) {
    assert.strictEqual(DataCache.npcs.filter((npc) => npc.selfId === template.selfId).length, 1,
        `minion ${template.selfId} is loaded exactly once`);
    assert.strictEqual(DataCache.npcRewards.filter((reward) => reward.selfId === template.selfId).length, 1);
}
assert.ok(DataCache.items.some((item) => Number(item.selfId) === 5275));

// A sample new minion as Lisvus defines it: Varka's Elite Guard of Varka's Commander.
const guard = npcById.get(1370);
assert.deepStrictEqual(
    [guard.template.name, guard.template.level, guard.clan.clanName, guard.clan.helpRadius, guard.vitals.maxHp, guard.stats.pAtk],
    ["Varka's Elite Guard", 80, 'varka_silenos_clan', 300, 4550, 2195]
);
assert.deepStrictEqual(rows.find((row) => row.bossId === 1369), { bossId: 1369, minionId: 1370, min: 2, max: 2 });

// Ultimate Buff, 2nd of Chakram Beetle's minion 1433 is Lisvus's self pAtk buff.
assert.deepStrictEqual(C4SkillRules.resolve({ selfId: 4340, level: 1, name: 'Ultimate Buff, 2nd' }).stats, { pAtkMul: 5 });
assert.ok(skillRows.some((row) => row.npcId === 1433 && row.skillId === 4340));

// The Self Damage Shield binding resolves to a skill instead of being dropped.
const shielded = new Npc(1, { ...utils.crushOb(npcById.get(951)), locX: 0, locY: 0, locZ: 0, head: 0 });
shielded.gameTime = { isNight: () => false };
assert.ok(NpcSkills.forNpc(shielded).some((skill) => skill.fetchSelfId() === 4163));

console.log('C4 group leader minions ok');
