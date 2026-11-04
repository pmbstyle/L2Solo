const fs = require('fs');
const path = require('path');
const { createExportedCatalogue } = require('../GameServer/Knowledge/ExportedCatalogueAdapter');
const NpcTraits = require('../GameServer/Npc/NpcTraits');

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 100;
const ITEM_GRADE_ORDER = Object.freeze(['no-grade', 'd', 'c', 'b', 'a', 's']);
const ITEM_DIRECTORY = Object.freeze([
    { key: 'weapons', label: 'Weapons', description: 'Swords, bows, magic weapons and specialist arms' },
    { key: 'armor', label: 'Armor', description: 'Head, chest, legs, gloves, boots and shields' },
    { key: 'jewelry', label: 'Jewelry', description: 'Rings, earrings and necklaces' },
    { key: 'consumables', label: 'Consumables', description: 'Shots, potions, scrolls and arrows' },
    { key: 'recipes', label: 'Recipes', description: 'Crafting recipes for equipment and supplies' },
    { key: 'materials', label: 'Materials', description: 'Crafting ingredients and upgrade materials' },
    { key: 'quest', label: 'Quest items', description: 'Quest, event and progression items' },
    { key: 'other', label: 'Other items', description: 'Miscellaneous items from the server datapack' }
]);
const NPC_WEAKNESSES = Object.freeze([
    { key: 'blunt', label: 'Blunt Weapon', stat: 'bluntWpnVuln' },
    { key: 'holy', label: 'Holy', stat: 'holyVuln' },
    { key: 'bow', label: 'Bow Weapon', stat: 'bowWpnVuln' },
    { key: 'fire', label: 'Fire', stat: 'fireVuln' },
    { key: 'water', label: 'Water', stat: 'waterVuln' },
    { key: 'wind', label: 'Wind', stat: 'windVuln' },
    { key: 'earth', label: 'Earth', stat: 'earthVuln' },
    { key: 'dark', label: 'Dark', stat: 'darkVuln' }
]);

function positiveInteger(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value, digits = 8) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Number(number.toFixed(digits));
}

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}

function commaSeparatedValues(value) {
    return String(value || '').split(',').map(normalize).filter(Boolean);
}

function itemCategory(kind) {
    const value = normalize(kind);
    if (value.startsWith('weapon.')) return 'weapons';
    if (value === 'armor.jewel') return 'jewelry';
    if (value.startsWith('armor.')) return 'armor';
    if (value === 'other.recipe') return 'recipes';
    if (value === 'other.material') return 'materials';
    if (['other.potion', 'other.scroll', 'other.shot', 'other.arrow'].includes(value)) return 'consumables';
    if (value === 'other.quest') return 'quest';
    return 'other';
}

function itemGrade(item) {
    const value = normalize(item?.grade || item?.template?.etc?.rank || 'none').replaceAll('_', '-');
    return ['none', 'no-grade', 'nograde', '0'].includes(value) ? 'no-grade' : value;
}

function playerFacingItem(item) {
    const name = String(item?.name || '').trim();
    if (!/[a-z]/i.test(name)) return false;
    return !/^\(not used\)/i.test(name) && !/^unused\b/i.test(name);
}

function itemDirectorySummary(items) {
    const counts = new Map(ITEM_DIRECTORY.map((entry) => [entry.key, {
        ...entry,
        total: 0,
        grades: new Map()
    }]));

    (items || []).filter(playerFacingItem).forEach((item) => {
        const entry = counts.get(itemCategory(item.kind));
        if (!entry) return;
        const grade = itemGrade(item);
        entry.total += 1;
        entry.grades.set(grade, (entry.grades.get(grade) || 0) + 1);
    });

    return ITEM_DIRECTORY.map(({ key }) => counts.get(key)).map((entry) => ({
        key: entry.key,
        label: entry.label,
        description: entry.description,
        total: entry.total,
        grades: ITEM_GRADE_ORDER
            .filter((grade) => entry.grades.has(grade))
            .map((grade) => ({ key: grade, count: entry.grades.get(grade) }))
    }));
}

function itemSummary(item, iconFor, sources) {
    const template = item?.template || {};
    const drops = sources.count(item.id, 'drops'), spoils = sources.count(item.id, 'spoils');
    const icon = iconFor?.(null, item.id, item.name, item.kind) || null;
    return {
        id: Number(item.id),
        name: String(item.name || `Item ${item.id}`),
        kind: String(item.kind || 'Other'),
        category: itemCategory(item.kind),
        grade: itemGrade(item),
        price: Math.max(0, Number(template?.template?.price || 0)),
        iconUrl: icon?.url || null,
        hasDropSources: drops > 0,
        hasSpoilSources: spoils > 0,
        sourceCount: drops + spoils
    };
}

function npcCombatTraits(npc, skillById) {
    const weaknesses = new Set();
    let hpMultiplier = 1;
    (npc?.skillIds || []).forEach((skillId) => {
        const skill = skillById?.get(String(skillId));
        const semantic = skill?.semantic || {};
        if (skill?.passive !== true || semantic.target !== 'self') return;
        const stats = semantic.stats || {};
        NPC_WEAKNESSES.forEach(({ key, stat }) => {
            if (Number(stats[stat]) > 1) weaknesses.add(key);
        });
        const multiplier = Number(stats.maxHpMul);
        if (Number.isFinite(multiplier) && multiplier > 0) hpMultiplier *= multiplier;
    });
    return {
        weaknesses: NPC_WEAKNESSES.map(({ key }) => key).filter((key) => weaknesses.has(key)),
        hpMultiplier: round(hpMultiplier)
    };
}

function npcFilterSummary(mobs, skillById) {
    const weaknessCounts = new Map(NPC_WEAKNESSES.map(({ key }) => [key, 0]));
    const hpMultiplierCounts = new Map();
    (mobs || []).forEach((npc) => {
        const traits = npcCombatTraits(npc, skillById);
        traits.weaknesses.forEach((key) => weaknessCounts.set(key, (weaknessCounts.get(key) || 0) + 1));
        if (traits.hpMultiplier !== 1) {
            hpMultiplierCounts.set(traits.hpMultiplier, (hpMultiplierCounts.get(traits.hpMultiplier) || 0) + 1);
        }
    });
    return {
        weaknesses: NPC_WEAKNESSES.map(({ key, label }) => ({ key, label, count: weaknessCounts.get(key) || 0 }))
            .filter((entry) => entry.count > 0),
        hpMultipliers: [...hpMultiplierCounts.entries()]
            .sort(([left], [right]) => left - right)
            .map(([value, count]) => ({ value, label: value === 0.5 ? 'x½' : `x${value}`, count }))
    };
}

function npcSummary(npc, skillById) {
    const traits = npcCombatTraits(npc, skillById);
    return {
        id: Number(npc.id),
        name: String(npc.name || `NPC ${npc.id}`),
        level: Number(npc.level || 0),
        kind: String(npc.kind || 'Monster'),
        aiType: String(npc.aiType || ''),
        raidBoss: Boolean(npc.raidBoss),
        directSpawn: Boolean(npc?.availability?.directSpawn),
        knownReachable: Boolean(npc?.availability?.knownReachable),
        weaknesses: traits.weaknesses,
        hpMultiplier: traits.hpMultiplier,
        spawnCount: Number(npc?.spawnIds?.length || 0),
        dropCount: (npc?.drops || []).reduce((sum, group) => sum + Number(group?.items?.length || 0), 0),
        spoilCount: (npc?.spoils || []).reduce((sum, group) => sum + Number(group?.items?.length || 0), 0)
    };
}

function rewardGroup(group) {
    return {
        overall: Number(group?.overallChancePercent || 0),
        items: (group?.items || []).map((item) => ({
            selfId: Number(item.itemId),
            name: String(item.sourceName || ''),
            min: Number(item.minAmount || 0),
            max: Number(item.maxAmount ?? item.minAmount ?? 0),
            chance: Number(item.selectionWeightPercent || 0)
        }))
    };
}

function scaledRewardGroups(groups, kind, npcLevel, progressionRates, iconFor) {
    return (groups || []).map((sourceGroup) => {
        const group = rewardGroup(sourceGroup);
        const roll = progressionRates.rewardGroupRoll(group, kind, {
            npcLevel,
            killerLevel: npcLevel,
            attackerLevels: []
        }, () => 0);
        const groupChance = Number(roll.chance || 0) / 100;

        return {
            groupIndex: Number(sourceGroup.groupIndex || 0),
            chancePercent: round(roll.chance),
            items: (sourceGroup.items || []).map((item, itemIndex) => {
                const rawItem = group.items[itemIndex];
                const selectionChance = kind === 'drop'
                    ? progressionRates.dropItemSelectionChance(group, rawItem, roll.itemRate)
                    : progressionRates.spoilItemChance(rawItem);
                const expectedConditionalAmount = kind === 'drop'
                    ? progressionRates.expectedDropAmount(group, rawItem, roll.itemRate)
                    : ((Number(rawItem.min || 1) + Number(rawItem.max || rawItem.min || 1)) / 2)
                        * Number(roll.amountMultiplier || 1);
                const amountRange = kind === 'drop'
                    ? progressionRates.dropAmountRange(group, rawItem, roll.itemRate)
                    : {
                        min: Number(item.minAmount || 0),
                        max: Number(item.maxAmount ?? item.minAmount ?? 0)
                    };
                const icon = iconFor?.(null, item.itemId, item.sourceName, null) || null;
                return {
                    itemId: Number(item.itemId),
                    name: String(item.sourceName || `Item ${item.itemId}`),
                    minAmount: amountRange.min,
                    maxAmount: amountRange.max,
                    chancePercent: round(groupChance * selectionChance * 100),
                    expectedAmountPerKill: round(groupChance * selectionChance * expectedConditionalAmount),
                    iconUrl: icon?.url || null
                };
            })
        };
    });
}

function aggregateItemResults(groups, itemId) {
    const matches = (groups || []).flatMap((group) => (group.items || []).filter((item) => Number(item.itemId) === Number(itemId)));
    const missChance = matches.reduce((remaining, item) => (
        remaining * (1 - Math.max(0, Math.min(100, Number(item.chancePercent || 0))) / 100)
    ), 1);
    return {
        chancePercent: round((1 - missChance) * 100),
        expectedAmountPerKill: round(matches.reduce((sum, item) => sum + Number(item.expectedAmountPerKill || 0), 0))
    };
}

function spawnMapPoints(spawn) {
    const direct = (spawn?.possibleLocations || [])
        .map((location) => ({
            locX: Number(location?.locX),
            locY: Number(location?.locY),
            locZ: Number(location?.locZ || 0),
            source: 'location'
        }))
        .filter((location) => Number.isFinite(location.locX) && Number.isFinite(location.locY));
    if (direct.length) return direct;

    const bounds = (spawn?.zone?.bounds || [])
        .map((location) => ({ locX: Number(location?.locX), locY: Number(location?.locY), locZ: (Number(location?.minZ || 0) + Number(location?.maxZ || 0)) / 2 }))
        .filter((location) => Number.isFinite(location.locX) && Number.isFinite(location.locY));
    if (!bounds.length) return [];
    return [{
        locX: round(bounds.reduce((sum, point) => sum + point.locX, 0) / bounds.length, 2),
        locY: round(bounds.reduce((sum, point) => sum + point.locY, 0) / bounds.length, 2),
        locZ: round(bounds.reduce((sum, point) => sum + point.locZ, 0) / bounds.length, 2),
        source: 'zone',
        zoneId: spawn?.zone?.id || null
    }];
}

// Which mobs drop or spoil an item, kept compact: of the generated source records the readers use only the mob id
// (in catalogue order, which the stable level/name sort of itemDetail keeps for ties) and the count. Owns the
// layout (one Int32Array of mob ids per item and kind); callers read through count and mobIds only.
const SOURCE_KINDS = Object.freeze(['drops', 'spoils']);
function compactItemSources(items) {
    const byKind = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, new Map()]));
    for (const item of items) {
        for (const kind of SOURCE_KINDS) {
            const records = item.sources?.[kind] || [];
            if (!records.length) continue;
            const ids = new Int32Array(records.length);
            records.forEach((record, index) => {
                const mobId = Number(record.mobId);
                if (!Number.isSafeInteger(mobId) || mobId < 0 || mobId > 0x7fffffff) {
                    throw new Error(`Knowledge base item ${item.id} has a non-int32 ${kind} mob id ${record.mobId}`);
                }
                ids[index] = mobId;
            });
            byKind[kind].set(Number(item.id), ids);
        }
        // The full records (names, levels, per-rate chances) are ~10 MB that no reader uses.
        item.sources = null;
    }
    const idsOf = (itemId, kind) => byKind[kind]?.get(Number(itemId));
    return Object.freeze({
        count: (itemId, kind) => idsOf(itemId, kind)?.length || 0,
        mobIds: (itemId, kind) => Array.from(idsOf(itemId, kind) || [])
    });
}

// One parsed copy per data directory, shared by every service over it (the game's item and drop dialogs and the
// world observer). Input: the directory's generated JSON, which does not change while the server runs.
const loadedByDir = new Map();
function loadData(dataDir) {
    const key = path.resolve(dataDir);
    if (loadedByDir.has(key)) return loadedByDir.get(key);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(key, `${name}.json`), 'utf8'));
    const items = read('items');
    const mobs = read('mobs');
    const skills = read('skills');
    const spawns = read('spawns');
    const manifest = read('manifest');
    const data = Object.freeze({
        items,
        mobs,
        skills,
        spawns,
        manifest,
        itemSources: compactItemSources(items),
        itemById: new Map(items.map((item) => [Number(item.id), item])),
        mobById: new Map(mobs.map((mob) => [Number(mob.id), mob])),
        skillById: new Map(skills.map((skill) => [String(skill.key || `${skill.id}:${skill.level}`), skill])),
        spawnById: new Map(spawns.map((spawn) => [String(spawn.id), spawn]))
    });
    loadedByDir.set(key, data);
    return data;
}

function createKnowledgeBaseService({ dataDir, progressionRates, iconFor = null,
    catalogueFactory = createExportedCatalogue, nativeCatalogue = null, nativeSkills = null } = {}) {
    if (!dataDir) throw new Error('Knowledge base dataDir is required');
    if (!progressionRates) throw new Error('Knowledge base progressionRates is required');
    let cache = null;

    // The shared data plus this service's catalogue (its native relations); iconFor applies per request.
    function load() {
        if (cache) return cache;
        const data = loadData(dataDir);
        cache = { ...data, catalogue: catalogueFactory(data, { nativeCatalogue }) };
        return cache;
    }

    function rateProfile() {
        const profile = progressionRates.profile();
        return {
            preset: String(profile.preset || 'custom'),
            multiplier: Number(profile.multiplier || 1),
            adena: Number(profile.adena || 1),
            drop: Number(profile.drop || 1),
            spoil: Number(profile.spoil || 1),
            assumption: 'same-level solo kill; Deep Blue penalty is not applied'
        };
    }

    function meta() {
        const data = load();
        return {
            schemaVersion: Number(data.manifest.schemaVersion || 1),
            counts: data.manifest.counts,
            rateProfile: rateProfile(),
            itemCategories: [
                { key: 'all', label: 'All items' },
                { key: 'weapons', label: 'Weapons' },
                { key: 'armor', label: 'Armor' },
                { key: 'jewelry', label: 'Jewelry' },
                { key: 'consumables', label: 'Consumables' },
                { key: 'recipes', label: 'Recipes' },
                { key: 'materials', label: 'Materials' },
                { key: 'quest', label: 'Quest' },
                { key: 'other', label: 'Other' }
            ],
            grades: ['all', ...ITEM_GRADE_ORDER],
            itemDirectory: itemDirectorySummary(data.items),
            npcFilters: npcFilterSummary(data.mobs, data.skillById)
        };
    }

    function pageResult(items, page, limit) {
        const normalizedLimit = Math.min(MAX_PAGE_SIZE, positiveInteger(limit, DEFAULT_PAGE_SIZE));
        const total = items.length;
        const pages = Math.max(1, Math.ceil(total / normalizedLimit));
        const normalizedPage = Math.min(pages, positiveInteger(page, 1));
        const start = (normalizedPage - 1) * normalizedLimit;
        return {
            page: normalizedPage,
            pages,
            limit: normalizedLimit,
            total,
            items: items.slice(start, start + normalizedLimit)
        };
    }

    function listItems({ q = '', category = 'all', grade = 'all', page = 1, limit = DEFAULT_PAGE_SIZE, exactFirst = false } = {}) {
        const data = load();
        const needle = normalize(q);
        const selectedCategory = normalize(category) || 'all';
        const selectedGrade = normalize(grade) || 'all';
        const results = data.items
            .filter(playerFacingItem)
            .filter((item) => !needle || normalize(`${item.name} ${item.id} ${item.kind}`).includes(needle))
            .filter((item) => selectedCategory === 'all' || itemCategory(item.kind) === selectedCategory)
            .filter((item) => selectedGrade === 'all' || itemGrade(item) === selectedGrade)
            .sort((left, right) => (exactFirst && needle
                ? Number(normalize(right.name) === needle || String(right.id) === needle) - Number(normalize(left.name) === needle || String(left.id) === needle)
                : 0) || left.name.localeCompare(right.name) || Number(left.id) - Number(right.id))
            .map((item) => itemSummary(item, iconFor, data.itemSources));
        return { ...pageResult(results, page, limit), rateProfile: rateProfile() };
    }

    function listNpcs({ q = '', minLevel = 1, maxLevel = 99, raid = 'all', weakness = '', hpMultiplier = '', page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
        const data = load();
        const needle = normalize(q);
        const minimum = Math.max(1, Number(minLevel) || 1);
        const maximum = Math.max(minimum, Number(maxLevel) || 99);
        const raidFilter = normalize(raid) || 'all';
        const knownWeaknesses = new Set(NPC_WEAKNESSES.map(({ key }) => key));
        const selectedWeaknesses = new Set(commaSeparatedValues(weakness).filter((key) => knownWeaknesses.has(key)));
        const selectedHpMultipliers = new Set(commaSeparatedValues(hpMultiplier)
            .map(Number).filter((value) => Number.isFinite(value) && value > 0).map((value) => round(value)));
        const results = data.mobs
            .map((npc) => ({ npc, traits: npcCombatTraits(npc, data.skillById) }))
            .filter(({ npc }) => !needle || normalize(`${npc.name} ${npc.id} ${npc.kind}`).includes(needle))
            .filter(({ npc }) => Number(npc.level) >= minimum && Number(npc.level) <= maximum)
            .filter(({ npc }) => raidFilter === 'all' || Boolean(npc.raidBoss) === (raidFilter === 'raid'))
            .filter(({ traits }) => !selectedWeaknesses.size || traits.weaknesses.some((key) => selectedWeaknesses.has(key)))
            .filter(({ traits }) => !selectedHpMultipliers.size || selectedHpMultipliers.has(traits.hpMultiplier))
            .sort(({ npc: left }, { npc: right }) => Number(left.level) - Number(right.level) || left.name.localeCompare(right.name) || Number(left.id) - Number(right.id))
            .map(({ npc }) => npcSummary(npc, data.skillById));
        return { ...pageResult(results, page, limit), rateProfile: rateProfile() };
    }

    function npcSpawns(npc) {
        const data = load();
        return (npc?.spawnIds || []).map((id) => data.catalogue.spawn(id)).filter(Boolean).map((spawn) => ({
            id: String(spawn.id),
            period: String(spawn.period || 'always'),
            total: Number(spawn.total || 0),
            respawnSeconds: Number(spawn.respawnSeconds || 0),
            randomBiasSeconds: Number(spawn.randomBiasSeconds || 0),
            zoneId: spawn?.zone?.id || null,
            mapPoints: spawnMapPoints(spawn)
        }));
    }

    function relatedNpcs(relations, idField) {
        const data = load();
        return (relations || [])
            .map((relation) => Number(relation?.[idField] ?? relation))
            .filter((id) => Number.isSafeInteger(id) && id > 0)
            .map((id) => npcSummary(data.catalogue.npc(id) || { id }, data.skillById));
    }

    function npcDetail(id) {
        const data = load();
        const npc = data.catalogue.npc(id);
        if (!npc) return null;
        const drops = scaledRewardGroups(npc.drops, 'drop', npc.level, progressionRates, iconFor);
        const spoils = scaledRewardGroups(npc.spoils, 'spoil', npc.level, progressionRates, iconFor);
        return {
            ...npcSummary(npc, data.skillById),
            title: String(npc?.template?.template?.title || ''),
            race: String(npc?.template?.traits?.race || ''),
            undead: NpcTraits.isUndead(npc?.template?.traits),
            hostile: Boolean(npc?.template?.template?.hostile),
            stats: npc.defaultEffectiveStats,
            progression: npc.progression,
            collision: npc?.template?.collision || null,
            drops,
            spoils,
            minions: relatedNpcs(npc.minions, 'minionId'),
            minionOf: relatedNpcs(npc.minionOf, 'bossId'),
            skills: (npc.skillIds || []).map((skillId) => {
                const skill = data.skillById.get(String(skillId));
                return skill ? {
                    key: String(skillId),
                    id: Number(skill.id),
                    level: Number(skill.level || 1),
                    name: String(skill.name || `Skill ${skill.id}`),
                    semantic: skill.semantic || null
                } : { key: String(skillId), name: `Skill ${skillId}` };
            }),
            spawns: npcSpawns(npc),
            rateProfile: rateProfile()
        };
    }

    function itemDetail(id) {
        const data = load();
        const item = data.catalogue.item(id);
        if (!item) return null;
        const template = item.template || {};
        const sourceDetails = (kind) => data.catalogue.sourcesForItem(item.id, { kind }).map((source) => {
            const npc = data.catalogue.npc(source.mobId);
            if (!npc) return null;
            const groups = scaledRewardGroups(kind === 'drops' ? npc.drops : npc.spoils, kind === 'drops' ? 'drop' : 'spoil', npc.level, progressionRates, iconFor);
            return {
                ...npcSummary(npc, data.skillById),
                ...aggregateItemResults(groups, item.id)
            };
        }).filter(Boolean).sort((left, right) => Number(left.level) - Number(right.level) || left.name.localeCompare(right.name));

        return {
            ...itemSummary(item, iconFor, data.itemSources),
            template: {
                mass: Number(template?.template?.mass || 0),
                price: Number(template?.template?.price || 0),
                slot: Number(template?.etc?.slot || 0),
                crystals: Number(template?.etc?.cristals || 0),
                soulshot: Number(template?.etc?.soulshot || 0),
                spiritshot: Number(template?.etc?.spiritshot || 0)
            },
            stats: template?.stats || {},
            sources: {
                drops: sourceDetails('drops'),
                spoils: sourceDetails('spoils')
            },
            rateProfile: rateProfile()
        };
    }

    function itemOverview(id) {
        const data = load();
        const item = data.catalogue.item(id);
        return item ? itemSummary(item, iconFor, data.itemSources) : null;
    }

    function listSkills({ q = '', page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
        const needle = normalize(q);
        const unique = new Map();
        const native = typeof nativeSkills === 'function' ? nativeSkills() : nativeSkills;
        const rows = [...(native || []).map(skill => ({ id: skill.selfId, name: skill.template?.name })), ...load().skills];
        for (const skill of rows) {
            if (needle && !normalize(`${skill.name} ${skill.id}`).includes(needle)) continue;
            if (!unique.has(Number(skill.id))) unique.set(Number(skill.id), { id: Number(skill.id), name: String(skill.name || `Skill ${skill.id}`) });
        }
        return pageResult([...unique.values()].sort((a, b) => a.name.localeCompare(b.name)), page, limit);
    }

    function skillDetail(id) {
        const native = typeof nativeSkills === 'function' ? nativeSkills() : nativeSkills;
        const playerSkill = native?.find(skill => Number(skill.selfId) === Number(id));
        if (playerSkill) {
            const first = playerSkill.levels?.[0] || {};
            return { id: Number(id), name: playerSkill.template?.name, passive: playerSkill.template?.passive,
                level: first.level, levelCount: playerSkill.levels?.length || 0,
                range: playerSkill.template?.distance, mpCost: first.mp, power: first.power,
                hitTime: playerSkill.time?.hitTime, reuseMs: playerSkill.time?.reuse,
                source: 'native_player_skill', observation: 'First catalog level shown. This does not prove the bot learned it; inspect_self skills gives learned levels.' };
        }
        const rows = load().skills.filter(skill => Number(skill.id) === Number(id));
        if (!rows.length) return null;
        const skill = rows[0];
        return { id: Number(skill.id), name: skill.name, passive: skill.passive,
            level: Number(skill.level), levelCount: rows.length, semantic: skill.semantic || null,
            observation: 'Catalog skill level shown, not proof this bot learned it. Read inspect_self skills for learned levels.' };
    }

    return Object.freeze({ itemDetail, itemOverview, listItems, listNpcs, listSkills, skillDetail, meta, npcDetail,
        catalogue: () => load().catalogue,
        relations: (kind, id, options) => load().catalogue.relations(kind, id, options) });
}

module.exports = {
    createKnowledgeBaseService,
    itemCategory,
    itemDirectorySummary,
    itemGrade,
    npcCombatTraits,
    playerFacingItem,
    spawnMapPoints
};
