#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'data', 'KnowledgeBase');
const outputNames = ['items.json', 'mobs.json', 'skills.json', 'spawns.json', 'manifest.json'];

// The committed catalog must not change with a developer's private config or
// launcher selection. Runtime-specific values are represented by every public
// progression preset instead.
process.chdir(root);
process.env.L2NODE_CONFIG_FILE = path.join(root, 'config', 'default.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
delete process.env.L2NODE_PROGRESSION_RATE;
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const minionDefinitions = require('../data/Npcs/Minions/c4_raid_bosses.json');

const SCHEMA_VERSION = 1;
const GENERATOR_PATH = 'scripts/generate-knowledge-base.js';

function round(value, digits = 12) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`Cannot serialize non-finite number: ${value}`);
    return Number(numeric.toFixed(digits));
}

function canonicalize(value) {
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return round(value);
    if (Array.isArray(value)) {
        return value.map(canonicalize).filter((entry) => entry !== undefined);
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`Unsupported generated value: ${Object.prototype.toString.call(value)}`);
    }

    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonicalize(value[key])])
        .filter(([, entry]) => entry !== undefined));
}

function jsonText(value) {
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function contentHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function positiveId(value, label) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`${label} has invalid id: ${value}`);
    return id;
}

function differingPaths(first, second, prefix = '') {
    if (jsonText(first) === jsonText(second)) return [];
    if (
        first === null || second === null ||
        typeof first !== 'object' || typeof second !== 'object' ||
        Array.isArray(first) || Array.isArray(second)
    ) return [prefix || '<root>'];

    return [...new Set([...Object.keys(first), ...Object.keys(second)])].sort()
        .flatMap((key) => differingPaths(first[key], second[key], prefix ? `${prefix}.${key}` : key));
}

function uniqueRows(rows, label, { allowConflicts = false } = {}) {
    const byId = new Map();
    const duplicates = [];
    rows.forEach((row) => {
        const id = positiveId(row?.selfId, label);
        const existing = byId.get(id);
        if (!existing) {
            byId.set(id, row);
            return;
        }
        const fields = differingPaths(existing, row);
        if (fields.length > 0 && !allowConflicts) {
            throw new Error(`${label} ${id} has conflicting duplicate definitions`);
        }
        duplicates.push({
            id,
            selectedDefinition: 'first loaded definition, matching DataCache.fetch*FromSelfId()',
            differingFields: fields
        });
    });
    return { byId, duplicates };
}

function isAttackable(template) {
    return ['Monster', 'Boss'].includes(template?.template?.kind);
}

function buildRateProfiles() {
    const profiles = {};
    Object.keys(ProgressionRates.PRESETS).forEach((preset) => {
        process.env.L2NODE_PROGRESSION_RATE = preset;
        profiles[preset] = ProgressionRates.profile();
    });
    return profiles;
}

function spoilSelectionChance(group, itemIndex) {
    const items = group?.items || [];
    const start = items.slice(0, itemIndex)
        .reduce((total, item) => total + Math.max(0, Number(item?.chance) || 0), 0);
    const end = start + Math.max(0, Number(items[itemIndex]?.chance) || 0);
    return Math.max(0, Math.min(100, end) - Math.min(100, start)) / 100;
}

function rateResult(group, item, itemIndex, kind, preset, npcLevel) {
    process.env.L2NODE_PROGRESSION_RATE = preset;
    const roll = ProgressionRates.rewardGroupRoll(group, kind, {
        npcLevel,
        killerLevel: npcLevel,
        attackerLevels: []
    }, () => 0);
    const groupChance = Number(roll.chance || 0) / 100;
    const selectionChance = kind === 'drop'
        ? ProgressionRates.dropItemSelectionChance(group, item, roll.itemRate)
        : spoilSelectionChance(group, itemIndex);
    const expectedConditionalAmount = kind === 'drop'
        ? ProgressionRates.expectedDropAmount(group, item, roll.itemRate)
        : ((Number(item.min || 1) + Number(item.max || item.min || 1)) / 2)
            * Number(roll.amountMultiplier || 1);

    return {
        chancePercent: round(groupChance * selectionChance * 100),
        expectedAmountPerKill: round(groupChance * selectionChance * expectedConditionalAmount)
    };
}

function normalizedRewardGroups(groups, kind, npcLevel, ratePresets) {
    return (groups || []).map((group, groupIndex) => ({
        groupIndex,
        overallChancePercent: round(Number(group.overall) || 0),
        items: (group.items || []).map((item, itemIndex) => ({
            itemId: positiveId(item.selfId, `${kind} item`),
            sourceName: String(item.name || ''),
            minAmount: Math.max(0, Math.floor(Number(item.min) || 0)),
            maxAmount: Math.max(0, Math.floor(Number(item.max ?? item.min) || 0)),
            selectionWeightPercent: round(Number(item.chance) || 0),
            baseChancePercent: round((Number(group.overall) || 0) * (Number(item.chance) || 0) / 100),
            rateProfiles: Object.fromEntries(ratePresets.map((preset) => [
                preset,
                rateResult(group, item, itemIndex, kind, preset, npcLevel)
            ]))
        }))
    }));
}

function aggregateRateProfiles(groups, itemId, ratePresets) {
    return Object.fromEntries(ratePresets.map((preset) => {
        const matches = groups.flatMap((group) => group.items
            .filter((item) => item.itemId === itemId)
            .map((item) => item.rateProfiles[preset]));
        const chance = 1 - matches.reduce((none, result) => (
            none * (1 - Math.max(0, Math.min(100, Number(result.chancePercent) || 0)) / 100)
        ), 1);
        return [preset, {
            chancePercent: round(chance * 100),
            expectedAmountPerKill: round(matches.reduce((total, result) => (
                total + Number(result.expectedAmountPerKill || 0)
            ), 0))
        }];
    }));
}

function buildSpawns(npcById) {
    const spawns = [];
    const spawnIdsByNpc = new Map();
    const usedIds = new Map();

    DataCache.npcSpawns.forEach((zone, zoneIndex) => {
        (zone.spawns || []).forEach((spawn, spawnIndex) => {
            const mobId = Number(spawn.selfId);
            if (!isAttackable(npcById.get(mobId))) return;

            const identity = jsonText({ zoneId: zone.selfId ?? null, spawn });
            const baseId = `spawn-${mobId}-${crypto.createHash('sha1').update(identity).digest('hex').slice(0, 12)}`;
            const occurrence = (usedIds.get(baseId) || 0) + 1;
            usedIds.set(baseId, occurrence);
            const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
            const record = {
                id,
                mobId,
                zone: {
                    id: zone.selfId ?? null,
                    sourceIndex: zoneIndex,
                    bounds: zone.bounds || []
                },
                sourceIndex: spawnIndex,
                possibleLocations: spawn.coords || [],
                total: Math.max(0, Math.floor(Number(spawn.total) || 0)),
                respawnSeconds: Math.max(0, Number(spawn.respawn) || 0),
                randomBiasSeconds: Math.max(0, Number(spawn.bias) || 0),
                period: ['day', 'night'].includes(spawn.period) ? spawn.period : 'always'
            };
            spawns.push(record);
            if (!spawnIdsByNpc.has(mobId)) spawnIdsByNpc.set(mobId, []);
            spawnIdsByNpc.get(mobId).push(id);
        });
    });

    spawns.sort((first, second) => first.mobId - second.mobId || first.id.localeCompare(second.id));
    spawnIdsByNpc.forEach((ids) => ids.sort());
    return { spawns, spawnIdsByNpc };
}

function buildMinionIndex(directSpawnIds) {
    const parentsByMinion = new Map();
    const childrenByBoss = new Map();
    minionDefinitions.forEach((definition) => {
        const bossId = positiveId(definition.bossId, 'raid boss minion parent');
        const minionId = positiveId(definition.minionId, 'raid boss minion');
        const relation = {
            bossId,
            minionId,
            minCount: Math.max(0, Math.floor(Number(definition.min) || 0)),
            maxCount: Math.max(0, Math.floor(Number(definition.max) || 0))
        };
        if (!parentsByMinion.has(minionId)) parentsByMinion.set(minionId, []);
        if (!childrenByBoss.has(bossId)) childrenByBoss.set(bossId, []);
        parentsByMinion.get(minionId).push(relation);
        childrenByBoss.get(bossId).push(relation);
    });

    const reachable = new Set(directSpawnIds);
    let changed = true;
    while (changed) {
        changed = false;
        minionDefinitions.forEach((definition) => {
            const bossId = Number(definition.bossId);
            const minionId = Number(definition.minionId);
            if (reachable.has(bossId) && !reachable.has(minionId)) {
                reachable.add(minionId);
                changed = true;
            }
        });
    }

    parentsByMinion.forEach((relations) => relations.sort((a, b) => a.bossId - b.bossId));
    childrenByBoss.forEach((relations) => relations.sort((a, b) => a.minionId - b.minionId));
    return { parentsByMinion, childrenByBoss, reachable };
}

function normalizedSkill(skill) {
    return {
        id: positiveId(skill.fetchSelfId(), 'NPC skill'),
        level: Math.max(1, Number(skill.fetchLevel()) || 1),
        name: String(skill.fetchName() || ''),
        passive: skill.fetchPassive() === true,
        magic: skill.fetchSpell() === true,
        target: skill.fetchTargetKind() || null,
        skillType: skill.fetchSkillType() || null,
        range: Number(skill.fetchDistance()) || 0,
        power: Number(skill.fetchPower()) || 0,
        hpCost: Number(skill.fetchConsumedHp()) || 0,
        mpCost: Number(skill.fetchConsumedMp()) || 0,
        hitTimeMs: Number(skill.fetchHitTime()) || 0,
        reuseTimeMs: Number(skill.fetchReuseTime()) || 0,
        durationMs: Number(skill.fetchBuffTime()) || 0,
        raw: skill.model,
        semantic: skill.fetchSemantic() || {}
    };
}

function defaultEffectiveStats(instance) {
    return {
        maxHp: instance.fetchMaxHp(),
        maxMp: instance.fetchMaxMp(),
        pAtk: instance.fetchCollectivePAtk(),
        mAtk: instance.fetchCollectiveMAtk(),
        pDef: instance.fetchCollectivePDef(),
        mDef: instance.fetchCollectiveMDef(),
        accuracy: instance.fetchCollectiveAccur(),
        evasion: instance.fetchCollectiveEvasion(),
        attackSpeed: instance.fetchCollectiveAtkSpd(),
        castSpeed: instance.fetchCollectiveCastSpd(),
        walkSpeed: instance.fetchCollectiveWalkSpd(),
        runSpeed: instance.fetchCollectiveRunSpd()
    };
}

function buildKnowledgeBase() {
    DataCache.init();
    const originalRate = process.env.L2NODE_PROGRESSION_RATE;
    try {
        const indexedItems = uniqueRows(DataCache.items, 'item', { allowConflicts: true });
        const itemById = indexedItems.byId;
        const npcById = uniqueRows(DataCache.npcs, 'NPC').byId;
        const rewardByNpc = uniqueRows(DataCache.npcRewards, 'NPC reward').byId;
        const attackableNpcs = [...npcById.values()].filter(isAttackable)
            .sort((first, second) => Number(first.selfId) - Number(second.selfId));
        attackableNpcs.forEach((npc) => {
            if (!rewardByNpc.has(Number(npc.selfId))) {
                throw new Error(`Attackable NPC ${npc.selfId} has no reward definition`);
            }
        });
        minionDefinitions.forEach((definition) => {
            const boss = npcById.get(Number(definition.bossId));
            const minion = npcById.get(Number(definition.minionId));
            if (!isAttackable(boss) || !isAttackable(minion)) {
                throw new Error(`Raid minion relation ${definition.bossId} -> ${definition.minionId} references a missing attackable NPC`);
            }
        });
        const rateProfiles = buildRateProfiles();
        const ratePresets = Object.keys(rateProfiles);
        const { spawns, spawnIdsByNpc } = buildSpawns(npcById);
        const directSpawnIds = new Set(spawnIdsByNpc.keys());
        const minions = buildMinionIndex(directSpawnIds);
        const sourcesByItem = new Map();
        const skillByKey = new Map();
        let dropEntries = 0;
        let spoilEntries = 0;

        const mobs = attackableNpcs.map((template) => {
            const id = Number(template.selfId);
            const reward = rewardByNpc.get(id) || { rewards: [], spoils: [] };
            const level = Number(template.template?.level) || 0;
            const drops = normalizedRewardGroups(reward.rewards, 'drop', level, ratePresets);
            const spoils = normalizedRewardGroups(reward.spoils, 'spoil', level, ratePresets);
            const availability = {
                directSpawn: directSpawnIds.has(id),
                raidMinion: minions.parentsByMinion.has(id),
                knownReachable: minions.reachable.has(id)
            };

            [['drop', drops], ['spoil', spoils]].forEach(([kind, groups]) => {
                const itemIds = new Set(groups.flatMap((group) => group.items.map((item) => item.itemId)));
                if (kind === 'drop') dropEntries += groups.reduce((total, group) => total + group.items.length, 0);
                else spoilEntries += groups.reduce((total, group) => total + group.items.length, 0);
                itemIds.forEach((itemId) => {
                    if (!itemById.has(itemId)) {
                        throw new Error(`NPC ${id} references missing ${kind} item ${itemId}`);
                    }
                    if (!sourcesByItem.has(itemId)) sourcesByItem.set(itemId, { drops: [], spoils: [] });
                    const matchingGroups = groups.filter((group) => group.items.some((item) => item.itemId === itemId));
                    sourcesByItem.get(itemId)[kind === 'drop' ? 'drops' : 'spoils'].push({
                        mobId: id,
                        mobName: String(template.template?.name || ''),
                        mobLevel: level,
                        availability,
                        groupIndexes: matchingGroups.map((group) => group.groupIndex),
                        rateProfiles: aggregateRateProfiles(matchingGroups, itemId, ratePresets)
                    });
                });
            });

            const instance = new Npc(1, {
                ...utils.crushOb(template),
                locX: 0,
                locY: 0,
                locZ: 0,
                head: 0
            });
            instance.gameTime = { isNight: () => false };
            const skills = NpcSkills.forNpc(instance).map(normalizedSkill)
                .sort((first, second) => first.id - second.id || first.level - second.level);
            const skillIds = skills.map((skill) => {
                const key = `${skill.id}:${skill.level}`;
                const existing = skillByKey.get(key);
                if (existing && jsonText(existing) !== jsonText(skill)) {
                    throw new Error(`NPC skill ${key} resolves to conflicting definitions`);
                }
                skillByKey.set(key, skill);
                return key;
            });

            return {
                id,
                name: String(template.template?.name || ''),
                kind: String(template.template?.kind || ''),
                level,
                raidBoss: template.template?.raidBoss === true,
                aiType: instance.fetchAiType(),
                template,
                defaultEffectiveStats: defaultEffectiveStats(instance),
                effectiveStatsContext: 'daytime spawn defaults with permanent passive skills and no temporary effects',
                progression: {
                    baseExp: instance.fetchAcquiredExp(),
                    baseSp: Number(instance.fetchRewardSp()) || 0,
                    expModifier: Number(instance.fetchRewardExp()) || 0
                },
                skillIds,
                drops,
                spoils,
                availability,
                spawnIds: spawnIdsByNpc.get(id) || [],
                minionOf: minions.parentsByMinion.get(id) || [],
                minions: minions.childrenByBoss.get(id) || []
            };
        });

        const items = [...itemById.values()]
            .sort((first, second) => Number(first.selfId) - Number(second.selfId))
            .map((template) => {
                const id = Number(template.selfId);
                const sources = sourcesByItem.get(id) || { drops: [], spoils: [] };
                sources.drops.sort((first, second) => first.mobId - second.mobId);
                sources.spoils.sort((first, second) => first.mobId - second.mobId);
                return {
                    id,
                    name: String(template.template?.name || ''),
                    kind: String(template.template?.kind || ''),
                    grade: String(template.etc?.rank || 'none'),
                    template,
                    sources
                };
            });
        const skills = [...skillByKey.entries()]
            .sort(([, first], [, second]) => first.id - second.id || first.level - second.level)
            .map(([key, skill]) => ({ key, ...skill }));

        const reachableMobs = mobs.filter((mob) => mob.availability.knownReachable);
        const reachableItemIds = new Set(items.filter((item) => (
            [...item.sources.drops, ...item.sources.spoils].some((source) => source.availability.knownReachable)
        )).map((item) => item.id));
        const sourcedItemIds = new Set(sourcesByItem.keys());

        return {
            items,
            mobs,
            skills,
            spawns,
            manifest: {
                schemaVersion: SCHEMA_VERSION,
                generator: GENERATOR_PATH,
                deterministic: true,
                probabilityUnit: 'percent',
                rateAssumptions: {
                    playerLevel: 'equal to mob level',
                    attackerLevels: [],
                    deepBluePenalty: false,
                    note: 'Rate profiles describe a same-level solo kill. Level-sensitive penalties must be calculated at display time.'
                },
                rateProfiles,
                files: {
                    items: 'items.json',
                    mobs: 'mobs.json',
                    skills: 'skills.json',
                    spawns: 'spawns.json'
                },
                counts: {
                    items: items.length,
                    mobs: mobs.length,
                    skills: skills.length,
                    mobsWithDirectSpawns: mobs.filter((mob) => mob.availability.directSpawn).length,
                    knownReachableMobs: reachableMobs.length,
                    unresolvedMobAvailability: mobs.length - reachableMobs.length,
                    spawnDefinitions: spawns.length,
                    spawnLocations: spawns.reduce((total, spawn) => total + spawn.possibleLocations.length, 0),
                    dropEntries,
                    spoilEntries,
                    sourcedItems: sourcedItemIds.size,
                    knownReachableSourcedItems: reachableItemIds.size
                },
                anomalies: {
                    duplicateItemDefinitions: indexedItems.duplicates.sort((first, second) => first.id - second.id)
                }
            }
        };
    } finally {
        if (originalRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = originalRate;
    }
}

function serializeOutputs(database) {
    const itemsText = jsonText(database.items);
    const mobsText = jsonText(database.mobs);
    const skillsText = jsonText(database.skills);
    const spawnsText = jsonText(database.spawns);
    const manifest = {
        ...database.manifest,
        sha256: {
            'items.json': contentHash(itemsText),
            'mobs.json': contentHash(mobsText),
            'skills.json': contentHash(skillsText),
            'spawns.json': contentHash(spawnsText)
        }
    };
    return new Map([
        ['items.json', itemsText],
        ['mobs.json', mobsText],
        ['skills.json', skillsText],
        ['spawns.json', spawnsText],
        ['manifest.json', jsonText(manifest)]
    ]);
}

function writeOutputs(outputs) {
    fs.mkdirSync(outputDir, { recursive: true });
    outputs.forEach((text, name) => fs.writeFileSync(path.join(outputDir, name), text));
}

function checkOutputs(outputs) {
    const stale = [];
    outputs.forEach((text, name) => {
        const filePath = path.join(outputDir, name);
        if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== text) stale.push(name);
    });
    if (fs.existsSync(outputDir)) {
        fs.readdirSync(outputDir)
            .filter((name) => name.endsWith('.json') && !outputNames.includes(name))
            .forEach((name) => stale.push(name));
    }
    if (stale.length > 0) {
        throw new Error(`Knowledge base is stale (${[...new Set(stale)].join(', ')}). Run npm run generate:knowledge-base.`);
    }
}

function main() {
    const check = process.argv.includes('--check');
    const quiet = process.argv.includes('--quiet');
    const database = buildKnowledgeBase();
    const outputs = serializeOutputs(database);
    if (check) checkOutputs(outputs);
    else writeOutputs(outputs);
    if (!quiet) {
        const action = check ? 'Verified' : 'Generated';
        console.info(`${action} knowledge base: ${database.items.length} items, ${database.mobs.length} mobs, ${database.skills.length} skills, ${database.spawns.length} spawns.`);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    SCHEMA_VERSION,
    buildKnowledgeBase,
    canonicalize,
    serializeOutputs
};
