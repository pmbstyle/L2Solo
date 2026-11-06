const fs = require('fs');
const path = require('path');
const { createExportedCatalogue } = require('../GameServer/Knowledge/ExportedCatalogueAdapter');
const NpcTraits = require('../GameServer/Npc/NpcTraits');
const { openRecordFile } = require('./KnowledgeBaseRecords');
const FailureLog = require('../FailureLog');

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

// rows: itemRow results.
function itemDirectorySummary(rows) {
    const counts = new Map(ITEM_DIRECTORY.map((entry) => [entry.key, {
        ...entry,
        total: 0,
        grades: new Map()
    }]));

    (rows || []).filter((row) => row.playerFacing).forEach((row) => {
        const entry = counts.get(row.category);
        if (!entry) return;
        const grade = row.grade;
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

// What the item list, overview and detail readers use of a generated item, with its rules applied once at load:
// the raw id/name/kind (searched and sorted as generated), category, grade, price and player-facing flag, and the
// detail template fields and stats (kept so itemDetail reads no record: adena's carries ~2k source rows).
function itemRow(item) {
    const template = item?.template || {};
    return {
        id: item.id,
        name: item.name,
        kind: item.kind,
        category: itemCategory(item.kind),
        grade: itemGrade(item),
        price: Math.max(0, Number(template?.template?.price || 0)),
        playerFacing: playerFacingItem(item),
        template: Object.freeze({
            mass: Number(template?.template?.mass || 0),
            price: Number(template?.template?.price || 0),
            slot: Number(template?.etc?.slot || 0),
            crystals: Number(template?.etc?.cristals || 0),
            soulshot: Number(template?.etc?.soulshot || 0),
            spiritshot: Number(template?.etc?.spiritshot || 0)
        }),
        stats: template?.stats || {}
    };
}

function itemSummary(row, iconFor, sources) {
    const drops = sources.count(row.id, 'drops'), spoils = sources.count(row.id, 'spoils');
    const icon = iconFor?.(null, row.id, row.name, row.kind) || null;
    return {
        id: Number(row.id),
        name: String(row.name || `Item ${row.id}`),
        kind: String(row.kind || 'Other'),
        category: row.category,
        grade: row.grade,
        price: row.price,
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

// rows: mobRow results.
function npcFilterSummary(rows) {
    const weaknessCounts = new Map(NPC_WEAKNESSES.map(({ key }) => [key, 0]));
    const hpMultiplierCounts = new Map();
    (rows || []).forEach(({ traits }) => {
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

// What the NPC list, summary and filter readers use of a generated mob: the raw id/name/level/kind/raid flag
// (filtered and sorted as generated), its combat traits computed once (skills do not change while running) and
// its counts. rewardsAt: the mob's place in the compact reward groups (absent for an NPC missing from the data).
function mobRow(npc, skillById, rewardsAt = null) {
    return {
        id: npc.id,
        name: npc.name,
        level: npc.level,
        kind: npc.kind,
        aiType: npc.aiType,
        raidBoss: npc.raidBoss,
        directSpawn: Boolean(npc?.availability?.directSpawn),
        knownReachable: Boolean(npc?.availability?.knownReachable),
        traits: npcCombatTraits(npc, skillById),
        spawnCount: Number(npc?.spawnIds?.length || 0),
        dropCount: (npc?.drops || []).reduce((sum, group) => sum + Number(group?.items?.length || 0), 0),
        spoilCount: (npc?.spoils || []).reduce((sum, group) => sum + Number(group?.items?.length || 0), 0),
        rewardsAt
    };
}

function npcSummary(row) {
    return {
        id: Number(row.id),
        name: String(row.name || `NPC ${row.id}`),
        level: Number(row.level || 0),
        kind: String(row.kind || 'Monster'),
        aiType: String(row.aiType || ''),
        raidBoss: Boolean(row.raidBoss),
        directSpawn: row.directSpawn,
        knownReachable: row.knownReachable,
        weaknesses: [...row.traits.weaknesses],
        hpMultiplier: row.traits.hpMultiplier,
        spawnCount: row.spawnCount,
        dropCount: row.dropCount,
        spoilCount: row.spoilCount
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
                const spoil = kind === 'spoil' ? progressionRates.spoilItemPlan(group, rawItem,
                    { npcLevel, killerLevel: npcLevel }) : null;
                const selectionChance = kind === 'drop'
                    ? progressionRates.dropItemSelectionChance(group, rawItem, roll.itemRate)
                    : spoil.chance;
                const expectedConditionalAmount = kind === 'drop'
                    ? progressionRates.expectedDropAmount(group, rawItem, roll.itemRate)
                    : 0;
                const amountRange = kind === 'drop'
                    ? progressionRates.dropAmountRange(group, rawItem, roll.itemRate)
                    : {
                        min: spoil.minAmount,
                        max: spoil.maxAmount
                    };
                const icon = iconFor?.(null, item.itemId, item.sourceName, null) || null;
                return {
                    itemId: Number(item.itemId),
                    name: String(item.sourceName || `Item ${item.itemId}`),
                    minAmount: amountRange.min,
                    maxAmount: amountRange.max,
                    chancePercent: round((spoil ? spoil.chance : groupChance * selectionChance) * 100),
                    expectedAmountPerKill: round(spoil ? spoil.expectedYield : groupChance * selectionChance * expectedConditionalAmount),
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
function itemSourceIndex() {
    const byKind = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, new Map()]));
    function add(item) {
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
    }
    const idsOf = (itemId, kind) => byKind[kind]?.get(Number(itemId));
    return Object.freeze({
        add,
        count: (itemId, kind) => idsOf(itemId, kind)?.length || 0,
        mobIds: (itemId, kind) => Array.from(idsOf(itemId, kind) || [])
    });
}

// Every mob's drop and spoil groups, kept compact for itemDetail (adena alone reads ~2k mobs' groups) and npcDetail.
// Of a generated group the readers use its index and overall chance and, per item, its id, amounts, selection weight
// and name; the per-rate profiles are not kept (rates apply per request). Owns the layout: one Float64Array (JSON
// numbers are doubles, held exactly) with, per mob and kind, [groupCount, per group: groupIndex, overallChancePercent,
// itemCount, per item: itemId, minAmount, maxAmount, selectionWeightPercent, name index], and one table of the
// distinct names. add returns a mob's offsets; groups decodes them into the generated group shape.
const GROUP_NUMBERS = Object.freeze(['groupIndex', 'overallChancePercent']);
const REWARD_NUMBERS = Object.freeze(['itemId', 'minAmount', 'maxAmount', 'selectionWeightPercent']);
function rewardGroupIndex() {
    const values = [], names = [], nameIndex = new Map();
    let table = null;
    const number = (mob, field, value) => {
        if (typeof value !== 'number') throw new Error(`Knowledge base mob ${mob.id} has a non-number reward ${field} ${value}`);
        values.push(value);
    };
    function addGroups(mob, groups) {
        const at = values.length;
        values.push(groups.length);
        for (const group of groups) {
            GROUP_NUMBERS.forEach((field) => number(mob, field, group[field]));
            const groupItems = group.items || [];
            values.push(groupItems.length);
            for (const item of groupItems) {
                REWARD_NUMBERS.forEach((field) => number(mob, field, item[field]));
                if (typeof item.sourceName !== 'string') throw new Error(`Knowledge base mob ${mob.id} has a non-string reward name`);
                if (!nameIndex.has(item.sourceName)) nameIndex.set(item.sourceName, names.push(item.sourceName) - 1);
                values.push(nameIndex.get(item.sourceName));
            }
        }
        return at;
    }
    // The groups at an offset, or only those with an item of itemId (the others add nothing to its chance).
    function groups(at, itemId = null) {
        const result = [];
        let position = at + 1;
        for (let group = table[at]; group > 0; group--) {
            const items = [], count = table[position + 2];
            let matches = itemId === null;
            for (let item = 0, offset = position + 3; item < count; item++, offset += 5) {
                matches ||= table[offset] === Number(itemId);
                items.push({ itemId: table[offset], minAmount: table[offset + 1], maxAmount: table[offset + 2],
                    selectionWeightPercent: table[offset + 3], sourceName: names[table[offset + 4]] });
            }
            if (matches) result.push({ groupIndex: table[position], overallChancePercent: table[position + 1], items });
            position += 3 + count * 5;
        }
        return result;
    }
    return {
        add: (mob) => ({ drops: addGroups(mob, mob.drops || []), spoils: addGroups(mob, mob.spoils || []) }),
        seal() {
            table = Float64Array.from(values);
            values.length = 0;
            nameIndex.clear();
            return Object.freeze({ groups });
        }
    };
}

// The knowledge base of one data directory, shared by every service over it (the game's item and drop dialogs and the
// world observer). Input: the directory's generated JSON, which does not change while the server runs (the generator
// replaces a file by rename; the held descriptors keep the scanned bytes). In memory: the manifest, skills whole,
// item and mob rows for the list/overview/summary readers, item source mob ids and compact reward groups. Full
// item/mob/spawn records are read from disk on demand (one positioned read and parse, ~0.1 ms; a mob's spawns
// are adjacent, so one read) behind the callers' detail caches; ids are Maps to record indexes.
const loadedByDir = new Map();
function loadData(dataDir) {
    const key = path.resolve(dataDir);
    if (loadedByDir.has(key)) return loadedByDir.get(key);
    const file = (name) => path.join(key, `${name}.json`);
    const skills = JSON.parse(fs.readFileSync(file('skills'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(file('manifest'), 'utf8'));
    const skillById = new Map(skills.map((skill) => [String(skill.key || `${skill.id}:${skill.level}`), skill]));

    const items = [], itemIndex = new Map(), itemSources = itemSourceIndex();
    const mobs = [], mobIndex = new Map(), rewardIndex = rewardGroupIndex();
    const spawnIndex = new Map();
    // A failed load closes what it opened, so a later load() starts clean.
    const opened = [];
    const open = (name, visit) => {
        const reader = openRecordFile(file(name), visit);
        opened.push(reader);
        return reader;
    };
    let itemFile, mobFile, spawnFile;
    try {
        itemFile = open('items', (item, index) => {
            items.push(itemRow(item));
            itemIndex.set(Number(item.id), index);
            itemSources.add(item);
        });
        mobFile = open('mobs', (mob, index) => {
            mobs.push(mobRow(mob, skillById, rewardIndex.add(mob)));
            mobIndex.set(Number(mob.id), index);
        });
        spawnFile = open('spawns', (spawn, index) => spawnIndex.set(String(spawn.id), index));
    } catch (error) {
        opened.forEach((reader) => reader.close());
        throw error;
    }

    // A record whose id is not the one scanned at load means the file changed under the held descriptor. A failed
    // read (that, or a short read) is counted here and rethrown: the callers answer "unavailable".
    const checked = (record, id, name) => {
        if (String(record.id) !== String(id)) throw new Error(`Knowledge base ${name}.json changed since load (wanted ${id})`);
        return record;
    };
    const counted = (read) => (...args) => {
        try {
            return read(...args);
        } catch (error) {
            FailureLog.note('knowledge.record_read', error);
            throw error;
        }
    };
    const spawnIndexes = (ids) => ids.map((id) => spawnIndex.get(String(id))).filter((index) => index !== undefined);
    const records = Object.freeze({
        item: counted((id) => {
            const index = itemIndex.get(Number(id));
            if (index === undefined) return null;
            // Sources are read through itemSources (mob ids in catalogue order), not from the record.
            return { ...checked(itemFile.read(index), id, 'items'), sources: null };
        }),
        npc: counted((id) => {
            const index = mobIndex.get(Number(id));
            return index === undefined ? null : checked(mobFile.read(index), id, 'mobs');
        }),
        spawn: counted((id) => {
            const index = spawnIndex.get(String(id));
            return index === undefined ? null : checked(spawnFile.read(index), id, 'spawns');
        }),
        // The known spawns of ids, in their order (unknown ids skipped).
        spawns: counted((ids) => {
            const known = (ids || []).filter((id) => spawnIndex.has(String(id)));
            return spawnFile.readMany(spawnIndexes(known)).map((spawn, index) => checked(spawn, known[index], 'spawns'));
        }),
        allSpawns: counted(() => spawnFile.readAll())
    });
    const data = Object.freeze({
        manifest,
        skills,
        skillById,
        items,
        mobs,
        itemSources,
        rewards: rewardIndex.seal(),
        itemRow: (id) => items[itemIndex.get(Number(id))] || null,
        mobRow: (id) => mobs[mobIndex.get(Number(id))] || null,
        records
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
            npcFilters: npcFilterSummary(data.mobs)
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
            .filter((item) => item.playerFacing)
            .filter((item) => !needle || normalize(`${item.name} ${item.id} ${item.kind}`).includes(needle))
            .filter((item) => selectedCategory === 'all' || item.category === selectedCategory)
            .filter((item) => selectedGrade === 'all' || item.grade === selectedGrade)
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
            .filter((npc) => !needle || normalize(`${npc.name} ${npc.id} ${npc.kind}`).includes(needle))
            .filter((npc) => Number(npc.level) >= minimum && Number(npc.level) <= maximum)
            .filter((npc) => raidFilter === 'all' || Boolean(npc.raidBoss) === (raidFilter === 'raid'))
            .filter(({ traits }) => !selectedWeaknesses.size || traits.weaknesses.some((key) => selectedWeaknesses.has(key)))
            .filter(({ traits }) => !selectedHpMultipliers.size || selectedHpMultipliers.has(traits.hpMultiplier))
            .sort((left, right) => Number(left.level) - Number(right.level) || left.name.localeCompare(right.name) || Number(left.id) - Number(right.id))
            .map(npcSummary);
        return { ...pageResult(results, page, limit), rateProfile: rateProfile() };
    }

    function npcSpawns(npc) {
        return load().records.spawns(npc?.spawnIds).map((spawn) => ({
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
            .map((id) => npcSummary(data.mobRow(id) || mobRow({ id }, data.skillById)));
    }

    function npcDetail(id) {
        const data = load();
        // Summary and reward groups from memory, the rest from the mob's record.
        const row = data.mobRow(id);
        const npc = row && data.catalogue.npc(id);
        if (!npc) return null;
        const drops = scaledRewardGroups(data.rewards.groups(row.rewardsAt.drops), 'drop', row.level, progressionRates, iconFor);
        const spoils = scaledRewardGroups(data.rewards.groups(row.rewardsAt.spoils), 'spoil', row.level, progressionRates, iconFor);
        return {
            ...npcSummary(row),
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
        // From memory only: no record is read (adena's sources are ~2k mobs).
        const item = data.itemRow(id);
        if (!item) return null;
        const sourceDetails = (kind) => data.itemSources.mobIds(item.id, kind).map((mobId) => {
            const npc = data.mobRow(mobId);
            if (!npc) return null;
            const groups = scaledRewardGroups(data.rewards.groups(npc.rewardsAt[kind], item.id), kind === 'drops' ? 'drop' : 'spoil', npc.level, progressionRates, iconFor);
            return {
                ...npcSummary(npc),
                ...aggregateItemResults(groups, item.id)
            };
        }).filter(Boolean).sort((left, right) => Number(left.level) - Number(right.level) || left.name.localeCompare(right.name));

        return {
            ...itemSummary(item, iconFor, data.itemSources),
            template: { ...item.template },
            stats: item.stats,
            sources: {
                drops: sourceDetails('drops'),
                spoils: sourceDetails('spoils')
            },
            rateProfile: rateProfile()
        };
    }

    function itemOverview(id) {
        const data = load();
        const item = data.itemRow(id);
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
    itemGrade,
    npcCombatTraits,
    playerFacingItem,
    spawnMapPoints
};
