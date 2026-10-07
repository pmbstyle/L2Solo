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
// hour (BotHuntEfficiency.huntIncome). Their hour over their income per kill
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
    const hour = HuntEfficiency.huntIncome({ level: best.level, stats: {} }, timestamp);
    return { price: withinWalls(item, kills * hour.perKill), kills, hours: kills * hour.perKill / hour.perHour,
        spotId: best.spotId, npcId: best.npcId, kind: best.kind, level: best.level, hourSource: hour.source, source: 'drop' };
}

// `made`: the price comes from making the item (a crafted one, a crystal), not
// from hunting it. The floor is the NPC buy-back for every item. The ceiling
// is the NPC shop price, and a made item has it only where an NPC sells it: the
// NPC is then the buyer's other source. A D+ shot or a crystal that no NPC
// sells has no ceiling (E91, user 2026-10-07: the market balances it); with
// the ceiling at the NPC price scaled by the rate, a D shot was clamped to 20
// while its cost is 58. A hunted item keeps the ceiling.
function withinWalls(item, price, { made = false } = {}) {
    const base = Number(item.template?.price || 0);
    if (base > 0) {
        const floor = NpcSellRules.npcBuyPrice(base);
        const open = made && !Number.isFinite(invoke('GameServer/Bot/Economy/BotMarketPricing').npcPrice({ selfId: item.selfId }));
        const ceiling = open ? Infinity : NpcShopPriceScale.price(base, ProgressionRates.profile().multiplier);
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
    if (!recipe) return null;
    if (depth >= MAX_CRAFT_DEPTH) {
        // Cut short: what is priced from here is no full price to keep.
        options.cut = true;
        return null;
    }
    const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
    let materials = 0;
    for (const material of recipe.materials || []) {
        const npc = BotMarketPricing.npcPrice({ selfId: material.selfId });
        const unit = Number.isFinite(npc) ? npc : cachedFirstPrice(material.selfId, options, depth + 1);
        if (!(unit > 0)) return null;
        materials += unit * Number(material.amount || 0);
    }
    const level = crafterLevel(recipe.level);
    if (!level) return null;
    const seconds = Number(recipe.mpCost || 0) / seatedMpPerSecond(level);
    const hour = HuntEfficiency.huntIncome({ level, stats: {} }, options.timestamp);
    const labour = seconds / 3600 * hour.perHour;
    const count = Math.max(1, Number(recipe.productCount || 1));
    return { price: withinWalls(item, (materials + labour) / count, { made: true }), materials: materials / count, labour: labour / count,
        crafterLevel: level, source: 'craft' };
}

// The gear that breaks into each crystal, with its crystal count: crystal
// selfId -> [{ gear, crystals }], static data built once.
let gearByCrystal = null;
function crystalSources(id) {
    if (!gearByCrystal) {
        gearByCrystal = new Map();
        for (const gear of DataCache.items) {
            const crystals = Number(gear?.etc?.cristals || 0);
            const crystalId = CRYSTAL_IDS[String(gear?.etc?.rank || '').toUpperCase()];
            if (!(crystals > 0) || !crystalId) continue;
            if (!gearByCrystal.has(crystalId)) gearByCrystal.set(crystalId, []);
            gearByCrystal.get(crystalId).push({ gear, crystals });
        }
    }
    return gearByCrystal.get(id) || null;
}

function crystalPrice(id, item, options) {
    const sources = crystalSources(id);
    if (!sources) return null;
    let best = null;
    for (const { gear, crystals } of sources) {
        const drop = dropPrice(Number(gear.selfId), gear, options.spots, options.timestamp);
        if (!drop) continue;
        const unit = drop.price / crystals;
        if (!best || unit < best.unit) best = { unit, gearId: Number(gear.selfId) };
    }
    return best ? { price: withinWalls(item, best.unit, { made: true }), gearId: best.gearId, source: 'crystal' } : null;
}

// A shot of no grade, by the one item classifier (MarketCounters.counterOf).
function noGradeShotPrice(item) {
    if (invoke('GameServer/Bot/Economy/MarketCounters').counterOf(item.selfId) !== 'shot none') return null;
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

// The first price for the market's readers (PriceBelief) and of a recipe's
// materials, kept an hour of this thread's clock: it moves only with the
// static base hunting income. A price whose recipe chain was cut at MAX_CRAFT_DEPTH
// (deep inside another item's materials) is used there but not kept: the
// item's own price, asked at the top, prices its whole chain.
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map();
function cachedFirstPrice(itemId, options = {}, depth = 0) {
    const id = Number(itemId);
    const kept = cache.get(id);
    const clock = Date.now();
    if (kept && clock - kept.at < CACHE_MS) return kept.value;
    const own = { spots: options.spots || [], timestamp: Number(options.timestamp || clock), cut: false };
    const value = priceOf(id, own, depth)?.price ?? null;
    if (own.cut) options.cut = true;
    else cache.set(id, { at: clock, value });
    return value;
}

module.exports = { firstPrice, cachedFirstPrice, resetCache() { cache.clear(); } };
