const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const NpcShopPriceScale = require('../../World/Generics/NpcShopPriceScale');
const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const HuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');

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
// Only drops and spoil for now: an item without a hunting source (crafted,
// sold by NPCs only, raid only, quest) returns null.
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

function firstPrice(itemId, { spots = [], timestamp = Date.now() } = {}) {
    const id = Number(itemId);
    const item = ItemTemplateIndex.find(DataCache.items, id);
    if (!item || id === 57) return null;
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
    let price = kills * hour.perKill;
    const base = Number(item.template?.price || 0);
    if (base > 0) {
        const floor = NpcSellRules.npcBuyPrice(base);
        const ceiling = NpcShopPriceScale.price(base, ProgressionRates.profile().multiplier);
        price = Math.min(ceiling, Math.max(floor, price));
    }
    return { price: Math.max(1, Math.round(price)), kills, hours: kills * hour.perKill / hour.perHour,
        spotId: best.spotId, npcId: best.npcId, kind: best.kind, level: best.level, hourSource: hour.source };
}

module.exports = { firstPrice };
