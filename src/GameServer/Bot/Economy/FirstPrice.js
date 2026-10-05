const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const NpcShopPriceScale = require('../../World/Generics/NpcShopPriceScale');
const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const HuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const { CRYSTAL_IDS } = invoke('GameServer/Items/C4EnchantRules');

// The first price of an item nobody has traded yet (design 15.4): the hours a
// bot hunts to obtain one times what an hour of bots of that level earns,
// not below the NPC buy-back and not above the NPC price.
//
// Where (design: the best spot with the item): on every ordinary spot where
// a monster drops (or, for the spoiler, spoils) the item, items per hour =
// kills per hour from the spot table x the monster's share of the spot's
// spawns x the expected amount per kill at the server's rate (the author's
// itemDropYield, with the deep-blue rule at the level the table rates the
// spot at). The spot with the most items per hour wins; its level is the
// item's level.
//
// How long: the kills needed there, 1 / (share x amount per kill), at the
// kill rate of the bots of that level, the same bots whose hour prices the
// hour (BotHuntEfficiency.hourValue). Their hour over their income per kill
// is their kills per hour, so hours x hour = kills needed x their income per
// kill. The table's own kill rate does not enter the hours: it is the bot in
// the author's planned kit, counted per hour of combat and recovery, several
// times the kill rate behind the bots' measured hour, and mixing the two
// would put every common drop at the buy-back.
//
// An item without a hunting source (group E, user 2026-10-05): a crafted one
// costs its materials (each at the NPC price when an NPC sells it, else at
// its own first price) plus the labour, the craft time (its MP over the
// seated MP regeneration of the lowest crafter able to make it) at that
// crafter's hour; a crystal costs the cheapest gear of its grade per crystal
// it breaks into; a no-grade shot the NPC price; anything else the NPC
// buy-back. Every price stays inside the NPC walls. Adena and items without
// a base price have none (null).
function npcShare(spot, reward) {
    const entries = spot?.npcEntries || [];
    const name = String(reward.template?.name || '').trim().toLowerCase();
    let total = 0;
    let matched = 0;
    for (const entry of entries) {
        const count = Math.max(1, Number(entry.count || 1));
        total += count;
        if (Number(entry.selfId) === Number(reward.selfId) || String(entry.name || '').trim().toLowerCase() === name) matched += count;
    }
    return total > 0 ? matched / total : 0;
}

// Kills per hour of the roles able to hunt the spot alone, each at the
// level the table rates the spot at for it, and the mean of those levels.
function hunt(spotId, roles) {
    let kills = 0;
    let levels = 0;
    let count = 0;
    for (const role of roles) {
        const level = SpotValueTable.referenceLevel(spotId, role, true);
        const hour = level === null ? null : SpotValueTable.value(spotId, role, level, true);
        if (!hour) continue;
        kills += hour.kills;
        levels += level;
        count += 1;
    }
    return count ? { kills: kills / count, level: Math.round(levels / count) } : null;
}

function dropPrice(id, item, spots, timestamp) {
    let best = null;
    for (const source of GearAcquisitionPlanner.sourceIndexFor(spots).get(id) || []) {
        if (source.spot?.raidBoss === true) continue;
        const share = npcShare(source.spot, source.reward);
        if (!(share > 0)) continue;
        const where = hunt(source.spot.id, source.kind === 'spoil' ? ['spoiler'] : SpotValueTable.roles());
        if (!where) continue;
        const { expectedYield } = GearAcquisitionPlanner.itemDropYield(source.reward, id, source.kind,
            { npcLevel: source.npcLevel, killerLevel: where.level });
        const perKill = share * Number(expectedYield || 0);
        const perHour = where.kills * perKill;
        if (!(perHour > 0) || (best && perHour <= best.perHour)) continue;
        best = { perHour, perKill, level: where.level, spotId: source.spot.id, npcId: Number(source.reward.selfId), kind: source.kind };
    }
    if (!best) return null;
    const kills = 1 / best.perKill;
    const hour = HuntEfficiency.hourValue({ level: best.level, stats: {} }, timestamp);
    return { price: withinWalls(item, kills * hour.perKill), kills, hours: kills * hour.perKill / hour.perHour,
        spotId: best.spotId, npcId: best.npcId, kind: best.kind, level: best.level, hourSource: hour.source, source: 'drop' };
}

function withinWalls(item, price) {
    const base = Number(item.template?.price || 0);
    if (base > 0) {
        const floor = NpcSellRules.npcBuyPrice(base);
        const ceiling = NpcShopPriceScale.price(base, ProgressionRates.profile().multiplier);
        price = Math.min(ceiling, Math.max(floor, price));
    }
    return Math.max(1, Math.round(price));
}

// The lowest crafter level with each craft level (the dwarf lines: Dwarven
// Fighter, Artisan from 20, Warsmith from 40) and its seated MP per second,
// static tables built once.
let crafterLevels = null;
function crafterLevel(craftLevel) {
    if (!crafterLevels) {
        const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
        crafterLevels = new Map();
        for (let level = 1; level <= 80; level++) {
            const found = CraftShopService.craftLevelFor({ classId: crafterClass(level), level });
            if (found && !crafterLevels.has(found)) crafterLevels.set(found, level);
        }
    }
    for (let wanted = Math.max(1, Number(craftLevel) || 1); wanted <= 10; wanted++) {
        if (crafterLevels.has(wanted)) return crafterLevels.get(wanted);
    }
    return null;
}
function crafterClass(level) {
    return level >= 40 ? 57 : level >= 20 ? 56 : 53;
}
const mpPerSecond = new Map();
function seatedMpPerSecond(level) {
    if (!mpPerSecond.has(level)) {
        const ms = invoke('GameServer/Bot/Population/BackgroundResolver').estimateRestMs(
            { level, stats: { classId: crafterClass(level) } },
            { hp: 1000, maxHp: 1000, mp: 0, maxMp: 10000 }, { requireMana: true });
        mpPerSecond.set(level, 10000 / Math.max(1, ms / 1000));
    }
    return mpPerSecond.get(level);
}

const MAX_CRAFT_DEPTH = 5;
function craftPrice(id, item, options, depth) {
    const recipe = C4RecipeItems.resolveByProductId(id);
    if (!recipe || depth >= MAX_CRAFT_DEPTH) return null;
    const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
    let materials = 0;
    for (const material of recipe.materials || []) {
        const npc = BotMarketPricing.npcPrice({ selfId: material.selfId });
        const unit = Number.isFinite(npc) ? npc : priceOf(Number(material.selfId), options, depth + 1)?.price;
        if (!(unit > 0)) return null;
        materials += unit * Number(material.amount || 0);
    }
    const level = crafterLevel(recipe.level);
    if (!level) return null;
    const seconds = Number(recipe.mpCost || 0) / seatedMpPerSecond(level);
    const hour = HuntEfficiency.hourValue({ level, stats: {} }, options.timestamp);
    const labour = seconds / 3600 * hour.perHour;
    const count = Math.max(1, Number(recipe.productCount || 1));
    return { price: withinWalls(item, (materials + labour) / count), materials: materials / count, labour: labour / count,
        crafterLevel: level, source: 'craft' };
}

function crystalPrice(id, item, options) {
    const grade = Object.keys(CRYSTAL_IDS).find((key) => CRYSTAL_IDS[key] === id);
    if (!grade) return null;
    let best = null;
    for (const gear of DataCache.items) {
        const crystals = Number(gear?.etc?.cristals || 0);
        if (!(crystals > 0) || String(gear.etc.rank || '').toUpperCase() !== grade) continue;
        const drop = dropPrice(Number(gear.selfId), gear, options.spots, options.timestamp);
        if (!drop) continue;
        const unit = drop.price / crystals;
        if (!best || unit < best.unit) best = { unit, gearId: Number(gear.selfId) };
    }
    return best ? { price: withinWalls(item, best.unit), gearId: best.gearId, source: 'crystal' } : null;
}

const GRADE_IN_NAME = /(?:^|[\s:])(D|C|B|A|S)(?:[- ]?Grade|\b)/i;
function noGradeShotPrice(item) {
    if (String(item.template?.kind || '') !== 'Other.Shot' || GRADE_IN_NAME.test(String(item.template?.name || ''))) return null;
    const npc = invoke('GameServer/Bot/Economy/BotMarketPricing').npcPrice(item);
    return Number.isFinite(npc) ? { price: Math.max(1, Math.round(npc)), source: 'npc' } : null;
}

function priceOf(id, options, depth) {
    const item = ItemTemplateIndex.find(DataCache.items, id);
    if (!item || id === 57 || !(Number(item.template?.price) > 0)) return null;
    return dropPrice(id, item, options.spots, options.timestamp)
        || craftPrice(id, item, options, depth)
        || crystalPrice(id, item, options)
        || noGradeShotPrice({ ...item, selfId: id })
        || { price: NpcSellRules.npcBuyPrice(Number(item.template.price)), source: 'buyback' };
}

function firstPrice(itemId, { spots = [], timestamp = Date.now() } = {}) {
    return priceOf(Number(itemId), { spots, timestamp }, 0);
}

// The first price for the market's readers (PriceBelief), kept an hour of
// the caller's clock: it moves only with the level bands' hours.
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map();
function cachedFirstPrice(itemId, options = {}) {
    const id = Number(itemId);
    const timestamp = Number(options.timestamp || Date.now());
    const kept = cache.get(id);
    if (kept && timestamp - kept.at < CACHE_MS && timestamp >= kept.at) return kept.value;
    const value = firstPrice(id, { spots: options.spots || [], timestamp })?.price ?? null;
    cache.set(id, { at: timestamp, value });
    return value;
}

module.exports = { firstPrice, cachedFirstPrice, resetCache() { cache.clear(); } };
