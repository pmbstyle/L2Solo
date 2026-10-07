const LotPolicy = require('./MarketLotPolicy');
const BoardRules = require('../../AfkTrade/BoardRules');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const { MAX_GEAR_COPIES_PER_TYPE } = require('./WarehouseRules');

const MARKET_GEAR_MIN_BASE_PRICE = ItemDisposition.NPC_LIQUIDATION_MAX_UNIT_PRICE;
const NPC_SURPLUS_GEAR_MAX_BASE_PRICE = 50000;

let newbieItemSource = null;
let newbieItemIds = new Set();

function starterItemIds() {
    const source = DataCache.newbieItems || [];
    if (newbieItemSource !== source) {
        newbieItemSource = source;
        newbieItemIds = new Set(source.flatMap((row) => (row.items || []).map((item) => Number(item.selfId || 0))).filter(Boolean));
    }
    return newbieItemIds;
}

function isGear(item = {}) {
    return String(item.kind || '').startsWith('Weapon.') || String(item.kind || '').startsWith('Armor.');
}

function surplusGearDecision(item, reason) {
    const ordinary = item.npcComparable !== false && Number(item.enchant || 0) <= 0;
    const common = isGear(item) && ordinary
        && Number(item.basePrice || 0) <= NPC_SURPLUS_GEAR_MAX_BASE_PRICE;
    return { action: common ? 'npc' : 'warehouse', reason };
}

// The author's hard rules for what never enters the board: an invalid item,
// a lot too small to list, NPC-only junk, the starter kit, cheap C+ gear.
// Anything else is the market's: { action:
// 'market' }, priced and placed by the one expected-value decision.
function classify(state, item) {
    if (!item || Number(item.selfId || 0) <= 0 || Number(item.count || 0) <= 0) {
        return { action: 'ignore', reason: 'invalid_item' };
    }
    if (!LotPolicy.viable(item)) return { action: 'warehouse', reason: 'small_material_lot' };
    if (ItemDisposition.isNpcOnlyItem(item)) {
        return { action: 'npc', reason: 'npc_only_item' };
    }
    if (starterItemIds().has(Number(item.selfId))) {
        return isGear(item) ? surplusGearDecision(item, 'starter_kit')
            : { action: 'npc', reason: 'starter_kit' };
    }
    const lowGradeGear = isGear(item)
        && ItemDisposition.gradeIndex(item.rank) < ItemDisposition.gradeIndex('c');
    if (isGear(item) && !lowGradeGear && Number(item.basePrice || 0) <= MARKET_GEAR_MIN_BASE_PRICE) {
        return surplusGearDecision(item, 'low_value_gear');
    }
    return { action: 'market', reason: 'market' };
}

// What the bot's thread knows for pricing on the main thread: its persona,
// the board index, the NPC shops and the spots for its trips. options may
// replace any (tests, offline digests).
function traderContext(state, options = {}) {
    return MarketPricing.traderContext(state, {
        timestamp: Number(options.now) || Date.now(),
        persona: options.persona ?? invoke('GameServer/Bot/AI/BotPersona').of(state),
        board: Object.hasOwn(options, 'board') ? options.board : invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
        npcOffersFor: options.npcOffersFor
            || ((selfId) => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(selfId)),
        findSpot: options.findSpot || ((spotId) => invoke('GameServer/Bot/AI/SpotService').findById(spotId)),
        economy: options.economy,
        knowledgeEnabled: options.knowledgeEnabled
    });
}

// Board slots of a bot (user, 2026-10-05): 3 shop lines + 5 sell ads.
const BOARD_SLOTS = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.sell_ad;

// The bot's sale at a market visit or a review (group E): the author's hard
// rules first; every other item goes by one expected-value decision (the
// board at its best ask, the NPC buy-back now, a buy ad answered in its town,
// or keeping it), one roll; the
// items for the board compete for its free slots by their gain over the NPC,
// one weighted roll. A line the bot already has keeps its slot and its price
// (its own look reprices it or takes it back, MarketPricing.look). options: now
// (the decision point), slots (board slots), kept (selfId -> price of its
// lines), stored (selfId -> units in the warehouse), plus traderContext's.
// Returns { candidates, decisions, listings, npc, warehouse, answers };
// selected listings carry their line pricing state. Answers are the buy
// ads it chose to sell into ({ item, line, count }: the bot sells there when
// it is in the ad's town, the side that acts travels).
function evaluate(state, options = {}) {
    const candidates = ItemDisposition.saleCandidates(state, { ...options, unlimited: true });
    const ctx = traderContext(state, options);
    const decisionPoint = Number(options.now) || ctx.timestamp;
    const kept = options.kept || new Map();
    const decisions = [];
    const forBoard = [];
    let keptLines = 0;
    for (const item of candidates) {
        const hard = classify(state, item);
        // A lot too small to list still answers a buy ad that asks for it:
        // the lot rule is the board's, the ad's buyer chose the amount.
        const smallLot = hard.reason === 'small_material_lot'
            && (MarketPricing.bestAnswer(item.selfId, ctx, { units: item.count, enchant: item.enchant })?.net || 0) > 0;
        if (hard.action !== 'market' && !smallLot) {
            decisions.push({ ...hard, item });
            continue;
        }
        const keptKey = `${item.selfId}:${item.enchant || 0}`;
        if (kept.has(keptKey) || !item.enchant && kept.has(Number(item.selfId))) {
            decisions.push({ action: 'list', reason: 'kept_line', item: { ...item, price: kept.get(keptKey) ?? kept.get(Number(item.selfId)),
                marketReason: 'kept_line' } });
            keptLines += 1;
            continue;
        }
        const town = MarketTownPolicy.targetTownForItems(state, [item], options);
        const chosen = MarketPricing.disposition(item, ctx, {
            town, room: roomFor(item, options.stored), smallLot,
            rollKey: ['dispose', ctx.characterId, item.selfId, decisionPoint]
        });
        const decision = { action: chosen.action === 'keep' ? 'warehouse' : chosen.action,
            reason: smallLot && chosen.action === 'keep' ? hard.reason : 'expected_value', item,
            priced: chosen.priced, gain: chosen.gain, answer: chosen.answer };
        decisions.push(decision);
        if (decision.action === 'list') forBoard.push(decision);
    }
    const slots = Math.max(0, Math.floor(Number(options.slots ?? BOARD_SLOTS)) - keptLines);
    const chosen = new Set(PriceDecision.chooseSlots(forBoard, slots, `slots:${ctx.characterId}:${decisionPoint}`));
    for (const decision of forBoard) {
        if (chosen.has(decision)) {
            const price = decision.priced.ask.price;
            decision.item = { ...decision.item, price, marketReason: 'expected_value',
                pricing: MarketPricing.lineState(decision.item.selfId, ctx, { price, storeType: BoardRules.SELL, enchant: decision.item.enchant || 0 }) };
            continue;
        }
        decision.action = 'warehouse';
        decision.reason = 'no_board_slot';
    }
    return {
        candidates,
        decisions,
        listings: decisions.filter((decision) => decision.action === 'list').map((decision) => decision.item),
        npc: decisions.filter((decision) => decision.action === 'npc').map((decision) => ({
            ...decision.item,
            npcPrice: NpcSellRules.npcBuyPrice(decision.item.basePrice)
        })),
        warehouse: decisions.filter((decision) => decision.action === 'warehouse').map((decision) => decision.item),
        answers: decisions.filter((decision) => decision.action === 'ad')
            .map((decision) => ({ item: decision.item, line: decision.answer.line, count: decision.answer.count }))
    };
}

// Room to keep an item: gear keeps two copies in the warehouse
// (BotWarehouseService), anything else has room.
function roomFor(item, stored) {
    if (!isGear(item) || !stored) return 1;
    const kept = Number(stored.get?.(Number(item.selfId)) ?? stored[Number(item.selfId)] ?? 0);
    return Math.max(0, Math.min(1, (MAX_GEAR_COPIES_PER_TYPE - kept) / Math.max(1, Number(item.count) || 1)));
}

// A bot in the world seen by the cold rules: its saved life state with the
// live bag, level and class of the actor.
function actorState(session) {
    const actor = session.actor;
    const inventory = invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems(actor.backpack.fetchItems());
    return {
        ...(session.coldLifeState || {}),
        characterId: Number(actor.fetchId()),
        level: Number(actor.fetchLevel?.() || session.coldLifeState?.level || 1),
        adena: Number(inventory['57']?.amount || 0),
        inventory,
        stats: { ...(session.coldLifeState?.stats || {}), classId: Number(actor.fetchClassId?.() || 0) }
    };
}

// What a bot in the world sells to the NPC, by selfId and count: the cold
// visit's NPC sale (evaluate().npc) on the actor's own bag. The hot town visit
// sells exactly this and keeps it out of the warehouse, as the cold visit sells
// before it stores.
function npcSaleForActor(session) {
    const sale = new Map();
    if (!session?.actor?.backpack?.fetchItems) return sale;
    const state = actorState(session);
    for (const line of evaluate(state, { unlimited: true, allowPreTradeCleanup: true }).npc) {
        sale.set(Number(line.selfId), Number(sale.get(Number(line.selfId)) || 0) + Number(line.count || 0));
    }
    return sale;
}

module.exports = {
    BOARD_SLOTS,
    MARKET_GEAR_MIN_BASE_PRICE,
    classify,
    evaluate,
    isGear,
    traderContext,
    actorState,
    npcSaleForActor,
    starterItemIds
};
