const fs = require('fs');
const path = require('path');

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

function itemSummary(item, iconFor) {
    const template = item?.template || {};
    const icon = iconFor?.(null, item.id, item.name, item.kind) || null;
    return {
        id: Number(item.id),
        name: String(item.name || `Item ${item.id}`),
        kind: String(item.kind || 'Other'),
        category: itemCategory(item.kind),
        grade: itemGrade(item),
        price: Math.max(0, Number(template?.template?.price || 0)),
        iconUrl: icon?.url || null,
        hasDropSources: Boolean(item?.sources?.drops?.length),
        hasSpoilSources: Boolean(item?.sources?.spoils?.length),
        sourceCount: Number(item?.sources?.drops?.length || 0) + Number(item?.sources?.spoils?.length || 0)
    };
}

function npcSummary(npc) {
    return {
        id: Number(npc.id),
        name: String(npc.name || `NPC ${npc.id}`),
        level: Number(npc.level || 0),
        kind: String(npc.kind || 'Monster'),
        aiType: String(npc.aiType || ''),
        raidBoss: Boolean(npc.raidBoss),
        directSpawn: Boolean(npc?.availability?.directSpawn),
        knownReachable: Boolean(npc?.availability?.knownReachable),
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

function spoilSelectionChance(group, itemIndex) {
    const items = group?.items || [];
    const start = items.slice(0, itemIndex)
        .reduce((total, item) => total + Math.max(0, Number(item?.chance) || 0), 0);
    const end = start + Math.max(0, Number(items[itemIndex]?.chance) || 0);
    return Math.max(0, Math.min(100, end) - Math.min(100, start)) / 100;
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
                    : spoilSelectionChance(group, itemIndex);
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

function createKnowledgeBaseService({ dataDir, progressionRates, iconFor = null } = {}) {
    if (!dataDir) throw new Error('Knowledge base dataDir is required');
    if (!progressionRates) throw new Error('Knowledge base progressionRates is required');
    let cache = null;

    function load() {
        if (cache) return cache;
        const read = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8'));
        const items = read('items');
        const mobs = read('mobs');
        const skills = read('skills');
        const spawns = read('spawns');
        const manifest = read('manifest');
        cache = {
            items,
            mobs,
            skills,
            spawns,
            manifest,
            itemById: new Map(items.map((item) => [Number(item.id), item])),
            mobById: new Map(mobs.map((mob) => [Number(mob.id), mob])),
            skillById: new Map(skills.map((skill) => [String(skill.key || `${skill.id}:${skill.level}`), skill])),
            spawnById: new Map(spawns.map((spawn) => [String(spawn.id), spawn]))
        };
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
            itemDirectory: itemDirectorySummary(data.items)
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

    function listItems({ q = '', category = 'all', grade = 'all', page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
        const data = load();
        const needle = normalize(q);
        const selectedCategory = normalize(category) || 'all';
        const selectedGrade = normalize(grade) || 'all';
        const results = data.items
            .filter(playerFacingItem)
            .filter((item) => !needle || normalize(`${item.name} ${item.id} ${item.kind}`).includes(needle))
            .filter((item) => selectedCategory === 'all' || itemCategory(item.kind) === selectedCategory)
            .filter((item) => selectedGrade === 'all' || itemGrade(item) === selectedGrade)
            .sort((left, right) => left.name.localeCompare(right.name) || Number(left.id) - Number(right.id))
            .map((item) => itemSummary(item, iconFor));
        return { ...pageResult(results, page, limit), rateProfile: rateProfile() };
    }

    function listNpcs({ q = '', minLevel = 1, maxLevel = 99, raid = 'all', page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
        const data = load();
        const needle = normalize(q);
        const minimum = Math.max(1, Number(minLevel) || 1);
        const maximum = Math.max(minimum, Number(maxLevel) || 99);
        const raidFilter = normalize(raid) || 'all';
        const results = data.mobs
            .filter((npc) => !needle || normalize(`${npc.name} ${npc.id} ${npc.kind}`).includes(needle))
            .filter((npc) => Number(npc.level) >= minimum && Number(npc.level) <= maximum)
            .filter((npc) => raidFilter === 'all' || Boolean(npc.raidBoss) === (raidFilter === 'raid'))
            .sort((left, right) => Number(left.level) - Number(right.level) || left.name.localeCompare(right.name) || Number(left.id) - Number(right.id))
            .map(npcSummary);
        return { ...pageResult(results, page, limit), rateProfile: rateProfile() };
    }

    function npcSpawns(npc) {
        const data = load();
        return (npc?.spawnIds || []).map((id) => data.spawnById.get(String(id))).filter(Boolean).map((spawn) => ({
            id: String(spawn.id),
            period: String(spawn.period || 'always'),
            total: Number(spawn.total || 0),
            respawnSeconds: Number(spawn.respawnSeconds || 0),
            randomBiasSeconds: Number(spawn.randomBiasSeconds || 0),
            zoneId: spawn?.zone?.id || null,
            mapPoints: spawnMapPoints(spawn)
        }));
    }

    function npcDetail(id) {
        const data = load();
        const npc = data.mobById.get(Number(id));
        if (!npc) return null;
        const drops = scaledRewardGroups(npc.drops, 'drop', npc.level, progressionRates, iconFor);
        const spoils = scaledRewardGroups(npc.spoils, 'spoil', npc.level, progressionRates, iconFor);
        return {
            ...npcSummary(npc),
            title: String(npc?.template?.template?.title || ''),
            race: String(npc?.template?.traits?.race || ''),
            undead: Boolean(npc?.template?.traits?.undead),
            hostile: Boolean(npc?.template?.template?.hostile),
            stats: npc.defaultEffectiveStats,
            progression: npc.progression,
            collision: npc?.template?.collision || null,
            drops,
            spoils,
            minions: (npc.minions || []).map((minionId) => npcSummary(data.mobById.get(Number(minionId)) || { id: minionId })),
            minionOf: (npc.minionOf || []).map((bossId) => npcSummary(data.mobById.get(Number(bossId)) || { id: bossId })),
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
        const item = data.itemById.get(Number(id));
        if (!item) return null;
        const template = item.template || {};
        const sourceDetails = (kind) => (item?.sources?.[kind] || []).map((source) => {
            const npc = data.mobById.get(Number(source.mobId));
            if (!npc) return null;
            const groups = scaledRewardGroups(kind === 'drops' ? npc.drops : npc.spoils, kind === 'drops' ? 'drop' : 'spoil', npc.level, progressionRates, iconFor);
            return {
                ...npcSummary(npc),
                ...aggregateItemResults(groups, item.id)
            };
        }).filter(Boolean).sort((left, right) => Number(left.level) - Number(right.level) || left.name.localeCompare(right.name));

        return {
            ...itemSummary(item, iconFor),
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

    return Object.freeze({ itemDetail, listItems, listNpcs, meta, npcDetail });
}

module.exports = {
    createKnowledgeBaseService,
    itemCategory,
    itemDirectorySummary,
    itemGrade,
    playerFacingItem,
    spawnMapPoints
};
