const assert = require('assert');
const path = require('path');

require('../../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');

const root = path.resolve(__dirname, '..', '..');

function dataFile(directory, slug) {
    return require(path.join(root, 'data', 'Npcs', directory, `${slug}.json`));
}

module.exports = function assertC4MonsterLocation(config) {
    DataCache.init();

    const mobIdSet = new Set(config.mobIds);
    const importedNpcIdSet = new Set(config.importedNpcIds);
    const importedNpcs = require(path.join(root, 'data', 'Npcs', `${config.slug}.json`));
    const importedRewards = dataFile('Rewards', config.slug);
    const importedBindings = dataFile('Skills', config.slug);
    const allBindings = config.bindingSlugs.flatMap((slug) => dataFile('Skills', slug))
        .filter((binding) => mobIdSet.has(binding.npcId));
    const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
    const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));

    assert.deepStrictEqual(importedNpcs.map((npc) => npc.selfId), config.importedNpcIds,
        `only previously unloaded ${config.displayName} templates may be imported`);
    assert.deepStrictEqual(importedRewards.map((reward) => reward.selfId), config.importedNpcIds,
        `only previously unloaded ${config.displayName} reward tables may be imported`);
    assert.ok(importedBindings.every((binding) => importedNpcIdSet.has(binding.npcId)),
        'reused monster skill bindings must not be duplicated');
    assert.strictEqual(npcs.length, config.mobIds.length,
        `all ${config.displayName} monsters must be loaded exactly once`);
    assert.strictEqual(rewards.length, config.mobIds.length,
        `every ${config.displayName} monster must have exactly one reward table`);
    // Spawns come from L2J_Mobius C4 (scripts/generate-c4-mobius-spawns.js); only the families it never
    // places (config.unspawned, e.g. beasts born by feeding) are absent from the world.
    const unspawned = new Set(config.unspawned || []);
    const spawnedIds = new Set(DataCache.npcSpawns
        .filter((area) => String(area.selfId).startsWith('mobius:'))
        .flatMap((area) => area.spawns.map((spawn) => Number(spawn.selfId))));
    assert.deepStrictEqual(config.mobIds.filter((id) => !spawnedIds.has(id) && !unspawned.has(id)), [],
        `every ${config.displayName} family must be spawned from Mobius`);
    assert.deepStrictEqual([...unspawned].filter((id) => spawnedIds.has(id)), [],
        `${config.displayName} unspawned families must stay out of the Mobius spawns`);

    const sample = npcs.find((npc) => npc.selfId === config.sample.id);
    assert.ok(sample, `representative NPC ${config.sample.id} must be loaded`);
    assert.deepStrictEqual(
        {
            id: sample.selfId, name: sample.template.name, level: sample.template.level,
            hostile: sample.template.hostile, pAtk: sample.stats.pAtk, pDef: sample.stats.pDef,
            mAtk: sample.stats.mAtk, mDef: sample.stats.mDef, hp: sample.vitals.maxHp,
            exp: Math.round(sample.rewards.exp * sample.template.level ** 2), sp: sample.rewards.sp,
            clan: sample.clan.clanName, race: sample.traits.race
        },
        config.sample,
        'the representative template must retain exact Lisvus combat and reward values'
    );

    const sourceDropRows = rewards.reduce((count, reward) => count
        + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
        + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
    assert.strictEqual(sourceDropRows, config.sourceDropRows,
        'all Lisvus drop and spoil rows must exist across new and reused reward tables');
    const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
        .flatMap((group) => group.items.map((item) => item.selfId))));
    rewardItemIds.forEach((itemId) => {
        assert.ok(DataCache.items.some((item) => item.selfId === itemId),
            `drop item ${itemId} must have a loaded template`);
    });
    assert.deepStrictEqual(
        Object.keys(config.importedItems).map(Number)
            .map((itemId) => DataCache.items.find((item) => item.selfId === itemId).template.name),
        Object.values(config.importedItems),
        'previously missing drop items must retain their exact source identities'
    );

    function npcInstance(template, objectId) {
        const [locX, locY, locZ] = config.origin;
        return new Npc(objectId, { ...utils.crushOb(template), locX, locY, locZ, head: 0 });
    }

    assert.strictEqual(importedBindings.length, config.importedSkillRows,
        'only new monster families may receive imported skill bindings');
    assert.strictEqual(allBindings.length, config.sourceSkillRows,
        'all source skill rows must exist across new and reused bindings');
    Object.entries(config.combatSkills).forEach(([npcIdText, skillIds]) => {
        const npcId = Number(npcIdText);
        const template = npcs.find((npc) => npc.selfId === npcId);
        assert.ok(template, `combat NPC ${npcId} must be loaded`);
        const instance = npcInstance(template, 9990000 + npcId);
        assert.strictEqual(
            NpcSkills.forNpc(instance).length,
            allBindings.filter((binding) => binding.npcId === npcId).length,
            `NPC ${npcId} must instantiate every sourced active and passive binding exactly once`
        );
        assert.deepStrictEqual(
            NpcSkills.combatSkillsFor(instance).map((skill) => skill.fetchSelfId()),
            skillIds,
            `NPC ${npcId} must expose exactly its usable Lisvus combat skills`
        );
    });

    (config.multipliers || []).forEach(({ npcId, stat, value }) => {
        const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 10000000 + npcId);
        assert.strictEqual(EffectStats.multiplier(instance, stat), value,
            `NPC ${npcId} must retain the exact ${stat} source multiplier`);
    });

    console.log(`C4 ${config.displayName} source-fidelity checks passed`);
};
