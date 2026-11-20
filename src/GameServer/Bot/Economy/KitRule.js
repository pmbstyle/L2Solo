'use strict';

// The kit rule: what shots and potions a bot keeps (kitReader: stock, kitCost,
// the survival reserve) and the hours its stock is sized for (bagHours: the
// hunting hours to a full bag after the visit's sale, ConsumableTarget). Pure
// over the state and rates it is given; read by EconomyContext (hot and cold,
// worker and main) and the spot table generator for its reference bot.

const ClassProgression = invoke('GameServer/ClassProgression');
const ItemIndex = require('../../Item/ItemTemplateIndex');
const Floor = require('../Population/SurvivalFloor');
const ConsumableTarget = require('./ConsumableTarget');

const positive = value => Math.max(0, Number(value) || 0);
const NOTHING_SOLD = Object.freeze({ slots: 0, load: 0 });
const SCROLL_OF_ESCAPE = 736;

// The one kit rule, hot and cold, worker and main: stock(kind),
// kitCost(id) and the survival reserve over the build's rates (kitRates: use
// per hour, benefit per unit, the hours to a full bag; StatsPacket.kitRates
// publishes them) and the live bag, wallet and prices. A kind's target is a
// full bag's use plus the reserve (ConsumableTarget) for a kind worth
// carrying, never less than one hour of use (its line); shots that cannot be restocked keep what the bag holds; the rest
// bottles only as many as the wallet buys above the reserve. rates null (no
// build has rated the kit yet): the bag is held as it is, nothing is bought
// and the reserve is empty. Prices go through the caller's price reader, so
// each read joins the review's inputs. scrollHours: the hours a Scroll of
// Escape saves, read only when a scroll is priced (a build solves its route
// lazily). The scroll is no survival item: one is carried
// per outing when the walk it saves is worth more than it costs at the bot's
// hour, none in towns karma closes; a broke bot walks. It is no part of the
// reserve; a purchase pays it from money the queue does not hold (ScrollStock).
// One per outing is our rule, not C4.
// The survival kit is priced at the NPC's list price (StaticMerchantPricing.
// botNpcListPrice, kept per item), not the bot's estimate: the reserve holds
// that, and a restock's survival tranche spends that share (kitCost) at any
// counter; a town's tax above it, as any optional unit, is paid from the
// money above the reserve at its stock wish's rank (PurchaseFunding.
// stockAllowance, quoteScale). The estimate where no NPC sells the item.
function survivalPrice(id, price) {
    const list = Number(invoke('GameServer/Bot/Economy/StaticMerchantPricing').botNpcListPrice(id));
    return Number.isFinite(list) && list > 0 ? list : price(id);
}
function kitReader(rates, bag, wallet, price, scrollHours = () => positive(rates?.scrollHours)) {
    const held = !rates;
    // Shots are used while the bag holds some or a restock pays (ShotStock.usePolicy).
    const base = kind => {
        const shots = kind === 'shots';
        const itemId = shots ? bag.shotId : bag.potionId, current = shots ? bag.shots : bag.potions;
        const canRestock = !held && (shots ? rates.shotsCanRestock : true);
        const use = held ? 0 : !shots ? positive(rates.potionUse)
            : (current > 0 ? rates.shotsPay : canRestock) ? positive(rates.shotUse) : 0;
        const restUse = held || shots ? 0 : positive(rates.potionRestUse);
        const line = Math.ceil(use);
        // Forecast consumption may be fractional; both purchase tranches use
        // the same whole-unit survival stock so their sum remains executable.
        const survivalTarget = held ? current : canRestock ? line : Math.min(current, line);
        return { shots, itemId, current, canRestock, use, restUse, line, survivalTarget,
            survivalMissing: Math.max(0, survivalTarget - current), survivalPrice: survivalPrice(itemId, price),
            benefitPerUnit: use + restUse > 0 ? positive(shots ? rates.shotBenefit : rates.potionBenefit) : 0 };
    };
    const kit = [base('shots'), base('potions')];
    // The survival reserve: the kit's missing survival units at their list price.
    const hours = held ? 0 : positive(rates.bagHours);
    // The refill: a full bag's use plus the reserve of a kind worth restocking,
    // never under its line (the bot's usual purchase). The reserve holds it at
    // the NPC list price whatever the bag holds now, so gear never takes the next
    // kit's money; a town counter spends of it what the bag misses.
    const refill = row => row.canRestock ? Math.max(row.line, ConsumableTarget.target(row.use, hours)) : 0;
    const reserve = kit.reduce((sum, row) => sum + refill(row) * row.survivalPrice, 0);
    const stock = kind => {
        if (kind === 'scrolls') {
            const current = bag.scrolls, unitPrice = price(736);
            const target = held ? current : bag.closed ? 0 : current >= 1 || scrollHours() * bag.hour > unitPrice ? 1 : 0;
            const missing = Math.max(0, target - current);
            const benefitPerUnit = current < target ? scrollHours() : 0;
            return { itemId: 736, usePerHour: 0, current, hours: Infinity, targetHours: hours, target,
                survivalTarget: 0, survivalMissing: 0, missing, unitPrice, survivalPrice: survivalPrice(736, price),
                benefitPerUnit, benefitHours: missing * benefitPerUnit, needed: false };
        }
        const row = kit[kind === 'shots' ? 0 : 1], { itemId, current, use, restUse, line } = row;
        // The rest bottles (RestPotion.stockUse) beside the survival use: a
        // full bag's, at most what the wallet buys above the reserve.
        const restCap = restUse > 0 ? current + Math.floor(Math.max(0, positive(wallet) - reserve) / Math.max(1, price(itemId))) : 0;
        const wanted = Math.max(line, ConsumableTarget.target(use, hours),
            Math.min(ConsumableTarget.target(use + restUse, hours), restCap));
        // Useful owned stock need not justify expensive replacement stock.
        const target = held ? current : row.canRestock ? wanted : Math.min(current, wanted);
        const missing = Math.max(0, target - Math.max(current, row.survivalTarget));
        // needed: a zero use has a zero survival target.
        return { itemId, ...(row.shots ? { beginnerCurrent: bag.beginner } : {}), current, line, refill: refill(row),
            target, survivalTarget: row.survivalTarget, missing, survivalMissing: row.survivalMissing, unitPrice: price(itemId),
            survivalPrice: row.survivalPrice, needed: current < row.survivalTarget,
            usePerHour: use, ...(row.shots && rates?.policy ? rates.policy : {}), hours: use > 0 ? current / use : Infinity,
            targetHours: hours, benefitPerUnit: row.benefitPerUnit, benefitHours: missing * row.benefitPerUnit };
    };
    // The kit's survival tranche: without a quote the reserve's own share
    // (its list price); with a known executable quote its whole missing units
    // at that quote, once (PurchaseFunding.survivalTranche: the counter counts
    // the share beside the queue's money and never refuses the kit itself).
    const kitCost = (id, unitPrice = null) => {
        const quoted = Number.isFinite(unitPrice) && unitPrice > 0;
        return kit.filter(row => row.itemId === Number(id)).reduce((sum, row) => sum
            + Math.max(0, refill(row) - row.current) * (quoted ? unitPrice : row.survivalPrice), 0);
    };
    return { stock, kitCost, reserve };
}
// The hunting hours to a full bag after the visit's sale (ConsumableTarget.
// bagHours): the free slots over the row's new stacks an hour, or the load left
// under the first weight step over the row's drop load an hour and the stock's
// own weight. state: the bot's bag before the visit (race, inventory, party,
// the last sale visit's unplaced kinds); row: { stacks, load } an hour; kit:
// { shotItemId, potionItemId, beginnerId, beginnerCurrent, shotUse, potionUse }
// (potionUse with the rest bottles); maxLoad: the bot's; sold: { slots, load }
// the visit's sale empties (never a kind the last visit could not place).
// Infinity when nothing bounds the hours.
function bagHours(state, { row, kit, maxLoad, sold = NOTHING_SOLD }) {
    const Data = invoke('GameServer/DataCache');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const race = state.stats?.race ?? (Data.classTemplates == null ? undefined : ClassProgression.firstClassRow(Data.classTemplates, state.stats?.classId || 0))?.template?.race;
    const { shotItemId, potionItemId, beginnerId = null, beginnerCurrent = 0, shotUse, potionUse } = kit;
    const amount = selfId => positive(state.inventory?.[selfId]?.amount);
    // ARCH-NOTE: size the bag interval on the bag after its
    // planned kit stacks exist. Otherwise an empty shot/potion row uses
    // no slot, its refill uses one, and the shorter interval immediately
    // sells part of that refill back to the NPC. Existing stacks retain
    // the exact physical free-slot formula; zero-use stock reserves none.
    // The Scroll of Escape the same visit buys (kitReader stock('scrolls'))
    // takes its slot and weight too, so a bag with or without its scroll
    // forecasts the same hours.
    const scrollMissing = !amount(SCROLL_OF_ESCAPE);
    const plannedSlots = Number(shotUse > 0 && !amount(shotItemId) && !beginnerCurrent)
        + Number(potionUse > 0 && !amount(potionItemId)) + Number(scrollMissing);
    const held = Floor.stateInventory(state, Data.items);
    // The whole bag; a solo bot also turns back at the half bag, counted as
    // the trip rule counts it (ItemDisposition.inventoryCleanupNeed: the goods
    // the last sale visit did not try, a held fact of that visit). A party
    // member sells from the field and uses the whole bag.
    const wholeFree = Floor.inventoryLimit(race) - (held.slots - sold.slots) - plannedSlots;
    const tried = Array.isArray(state.stats?.marketSellSeen?.items) ? new Set(state.stats.marketSellSeen.items.map(Number)) : null;
    const solo = !(state.party?.partyId || state.partyId);
    const halfFree = solo ? Floor.SOLO_BAG_SLOTS - (Disposition.inventorySlotCount(state, tried) - sold.slots) - plannedSlots : Infinity;
    const free = Math.max(0, Math.min(wholeFree, halfFree));
    // The load left under the first weight step after the sale, the shots
    // and potions being sized not counted (their weight is the rule's), the
    // scroll to be bought counted.
    const mass = selfId => positive(ItemIndex.find(Data.items, Number(selfId))?.template?.mass);
    const kitLoad = amount(shotItemId) * mass(shotItemId)
        + (beginnerId ? beginnerCurrent * mass(beginnerId) : 0)
        + amount(potionItemId) * mass(potionItemId);
    const freeLoad = Floor.loadLimit(maxLoad) - (held.load - sold.load - kitLoad) - (scrollMissing ? mass(SCROLL_OF_ESCAPE) : 0);
    return ConsumableTarget.bagHours({
        slotHours: free === 0 ? 0 : row.stacks > 0 ? free / row.stacks : Infinity,
        freeLoad, loadPerHour: positive(row.load),
        stock: [{ use: shotUse, mass: mass(shotItemId) }, { use: potionUse, mass: mass(potionItemId) }] });
}

module.exports = { kitReader, survivalPrice, bagHours };
