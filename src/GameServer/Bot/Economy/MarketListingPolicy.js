const BeginnerShots = require('../../Items/C4BeginnerShots');
const LotPolicy = require('./MarketLotPolicy');
const BoardRules = require('../../AfkTrade/BoardRules');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const KnowledgeLearning = invoke('GameServer/Bot/AI/KnowledgeLearning');
const { MAX_GEAR_COPIES_PER_TYPE } = require('./WarehouseRules');
const TradeDemand = require('./MarketTradeDemand');


function isGear(item = {}) {
    return String(item.kind || '').startsWith('Weapon.') || String(item.kind || '').startsWith('Armor.');
}

// Public interest and recent completed purchases earn scarce board space.
// Quote depth is a ranking signal, never funded or guaranteed receipts.
// Unobserved stock uses the old stable price order only for spare places.
function prioritizeListings(listings = [], { board, characterId = 0, timestamp = Date.now() } = {}) {
    const score = item => {
        let bidUnits = 0, bidPrice = 0;
        for (const line of board?.list(item.selfId, BoardRules.BUY) || []) {
            if (Number(line.ownerId) === Number(characterId) || Number(line.enchant || 0) !== Number(item.enchant || 0)) continue;
            bidUnits += Number(line.count); bidPrice = Math.max(bidPrice, Number(line.price));
        }
        const flow = !item.enchant ? TradeDemand.forecast(item.selfId, null, timestamp) : null;
        const count = Math.max(0, Number(item.count) || 0), price = Math.max(0, Number(item.price) || 0);
        return [bidUnits > 0 && bidPrice >= price ? 2 : bidUnits > 0 || flow ? 1 : 0,
            Math.max(Math.min(count, bidUnits) * Math.min(price, bidPrice),
                Math.min(count, flow?.applicableUnits || 0) * price)];
    };
    const scores = new Map(listings.map(item => [item, score(item)]));
    return listings.slice().sort((left, right) => scores.get(right)[0] - scores.get(left)[0]
        || scores.get(right)[1] - scores.get(left)[1]
        || Number(right.price || 0) - Number(left.price || 0)
        || Number(right.enchant || 0) - Number(left.enchant || 0)
        || Number(isGear(right)) - Number(isGear(left))
        || Number(left.selfId) - Number(right.selfId));
}

// Physical and quest rules remain hard constraints. All other candidates
// go through the shared expected-value decision after ItemDisposition has
// reserved equipped items, personal stock and outstanding obligations.
function classify(state, item) {
    if (!item || Number(item.selfId || 0) <= 0 || Number(item.count || 0) <= 0) {
        return { action: 'ignore', reason: 'invalid_item' };
    }
    if (BeginnerShots.isRestricted(item.selfId)) return { action: 'ignore', reason: 'beginner_shot' };
    if (ItemDisposition.isQuestItem(item)) return { action: 'ignore', reason: 'quest_item' };
    if (!invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(item.selfId))
        return { action: 'ignore', reason: 'no_acquisition_source' };
    if (!LotPolicy.viable(item)) return { action: 'ignore', reason: 'invalid_item' };
    if (ItemDisposition.isNpcOnlyItem(item, undefined, state)) {
        return { action: 'npc', reason: 'npc_only_item' };
    }
    return { action: 'market', reason: 'market' };
}

// What the bot's thread knows for pricing on the main thread: its persona,
// the board index, the NPC shops and the spots for its trips. options may
// replace any (tests, offline digests).
function traderContext(state, options = {}) {
    return MarketPricing.traderContext(state, {
        timestamp: Number(options.now) || Date.now(),
        persona: options.persona ?? BotPersona.of(state),
        board: Object.hasOwn(options, 'board') ? options.board : invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
        npcOffersFor: options.npcOffersFor
            || ((selfId) => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(selfId)),
        findSpot: options.findSpot || ((spotId) => invoke('GameServer/Bot/AI/SpotService').findById(spotId)),
        economy: options.economy,
        tripCost: options.tripCost,
        knowledgeEnabled: options.knowledgeEnabled,
        demandFor: options.demandFor,
        ownStock: options.ownStock,
        canSell: options.canSell,
        derivedDemandValue: options.derivedDemandValue,
        derivedDemandSupported: options.derivedDemandSupported
    });
}

// What main knows for pricing from the worker's accepted card, without a
// forecast: the persona, the money packet and the card's worths; no hunt,
// stock or recipe build. A reader of economy.price (an enchanted line's
// belief, MarketPricing.beliefFor) takes traderContext. options as
// MarketPricing.traderContext's deps (board, npcOffersFor, canSell, ...).
function cardTraderContext(state, options = {}) {
    const persona = BotPersona.of(state), packet = state.stats?.money;
    // lazy: worker the coordinator's accepted decisions live on main only
    const prepared = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided?.(state);
    const worth = id => ColdEconomyDecision.preparedCardWorth(prepared,
        id, state, Number(packet?.[1]), persona?.understanding, KnowledgeLearning.knowledgeEnabled());
    return MarketPricing.traderContext(state, {
        npcOffersFor: selfId => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(selfId), // lazy: worker main-only NPC shops
        ...options,
        board: Object.hasOwn(options, 'board') ? options.board : invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(), // lazy: worker main-only board
        persona, preparedWorth: worth, preparedBuffer: prepared?.data,
        economy: { persona, hourAdena: Number(packet?.[0]), moneyPrice: Number(packet?.[1]), gapHorizonHours: NaN, worth } });
}

// Board slots of a bot (user, 2026-10-05): 3 shop lines + 5 sell ads.
const BOARD_SLOTS = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.sell_ad;

// The bot's sale at a market visit or a review (group E): the author's hard
// rules first; every other item goes by one expected-value decision (the
// board at its best ask, the NPC buy-back now, a buy ad answered in its town,
// or keeping it), one roll. Public interest and recent purchases rank the
// bounded slots, including held listings, before the unknown waiting stock.
// A line the bot already has keeps its price
// (its own look reprices it or takes it back, MarketPricing.look). options: now
// (the decision point), slots (board slots), kept (selfId -> price of its
// lines), stored (selfId -> units in the warehouse), plus traderContext's.
// Returns { candidates, decisions, listings, npc, warehouse, answers };
// selected listings carry their line pricing state. Answers are the buy
// ads it chose to sell into ({ item, line, count }: the bot sells there when
// it is in the ad's town, the side that acts travels).
function evaluate(state, options = {}) {
    const ctx = traderContext(state, options);
    const craftReservations = ctx.economy?.craftReservations
        || ItemDisposition.selectedCraftAmounts(state, ctx.economy?.network);
    const candidates = ItemDisposition.saleCandidates(state, { ...options, unlimited: true,
        reserved: { ...options.reserved, ...craftReservations } });
    const decisionPoint = options.decisionPoint ?? (Number(options.now) || ctx.timestamp);
    const kept = options.kept || new Map((ctx.board?.ownerLines?.(Number(state.characterId)) || [])
        .filter(line => line.storeType === BoardRules.SELL)
        .map(line => [`${line.selfId}:${line.enchant || 0}`, line.price]));
    const liquidate = invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state);
    const decisions = [];
    const forBoard = [];
    for (const item of candidates) {
        const selectedAnswerRecord = Number(options.selectedAnswer?.selfId) === Number(item.selfId)
            && Number(options.selectedAnswer?.enchant || 0) === Number(item.enchant || 0)
            ? Number(options.selectedAnswer.recordId) : 0;
        const marketOnly = ItemDisposition.isGradeCrystal(item);
        const hard = classify(state, item);
        if (hard.action !== 'market') {
            decisions.push({ ...hard, item });
            continue;
        }
        const keptKey = `${item.selfId}:${item.enchant || 0}`;
        if (kept.has(keptKey) || !item.enchant && kept.has(Number(item.selfId))) {
            // Only unreserved conditional stock can answer from the field.
            // Reuse the sale decision, preserving the held ask unless it
            // actually chooses the opposite bid. Backed custody stays native.
            if (options.conditionalKept?.has(keptKey) && ctx.board?.first(item.selfId, 3,
                { excludeOwner: ctx.characterId, enchant: item.enchant || 0 })) {
                const chosen = MarketPricing.disposition(item, ctx, {
                    town: state.currentRegion, room: roomFor(item, options.stored), stockQuote: true,
                    standingPrice: kept.get(keptKey) ?? kept.get(Number(item.selfId)),
                    rollKey: ['dispose', ctx.characterId, item.selfId, decisionPoint], selectedAnswerRecord
                });
                if (chosen.action === 'ad') {
                    decisions.push({ action: 'ad', reason: 'expected_value', item, priced: chosen.priced,
                        gain: chosen.gain, answer: chosen.answer });
                    continue;
                }
            }
            decisions.push({ action: 'list', reason: 'kept_line', item: { ...item, price: kept.get(keptKey) ?? kept.get(Number(item.selfId)),
                marketReason: 'kept_line' } });
            continue;
        }
        const town = MarketTownPolicy.targetTownForItems(state, [item], options);
        const chosen = MarketPricing.disposition(item, ctx, {
            // A market quote can wait for a buyer even when this adventurer
            // otherwise liquidates surplus instead of warehousing it.
            town, room: options.stockQuotes === true || marketOnly ? 1 : liquidate ? 0 : roomFor(item, options.stored),
            stockQuote: options.stockQuotes === true || marketOnly,
            rollKey: ['dispose', ctx.characterId, item.selfId, decisionPoint], selectedAnswerRecord
        });
        // A valid ask without a known buyer waits on the market. It creates
        // no assumed receipts; physical reservations were removed above.
        const ask = chosen.priced?.ask;
        const action = (ask?.stockQuote || marketOnly && ask?.price > 0 && !ask.npc) && chosen.action !== 'ad' ? 'list'
            : marketOnly && ['keep', 'npc'].includes(chosen.action) ? 'keep'
            : chosen.action === 'keep' ? liquidate ? 'npc' : 'warehouse' : chosen.action;
        const decision = { action,
            reason: chosen.priced?.ask?.stockQuote ? 'stock_quote' : 'expected_value', item,
            priced: chosen.priced, gain: chosen.gain, answer: chosen.answer,
            // Attention to a free quote uses its possible spread, never expected receipts.
            slotWeight: chosen.priced?.ask?.stockQuote
                ? Math.max(0, chosen.priced.ask.price - chosen.priced.market.buyback) : chosen.gain };
        decisions.push(decision);
        if (decision.action === 'list') forBoard.push(decision);
    }
    for (const decision of forBoard) {
        const price = decision.priced.ask.price;
        decision.item = { ...decision.item, price, marketReason: decision.reason,
            pricing: MarketPricing.lineState(decision.item.selfId, ctx, { price, storeType: BoardRules.SELL, enchant: decision.item.enchant || 0 }) };
    }
    const slots = Math.max(0, Math.floor(Number(options.slots ?? BOARD_SLOTS)));
    const chosen = new Set(prioritizeListings(decisions.filter(row => row.action === 'list').map(row => row.item), ctx).slice(0, slots));
    for (const decision of decisions) {
        if (decision.action !== 'list' || chosen.has(decision.item)) continue;
        // Grade crystals wait for a market slot; cleanup must not turn them
        // into NPC receipts when more expensive loot fills the board.
        decision.action = ItemDisposition.isGradeCrystal(decision.item) ? 'keep' : liquidate ? 'npc' : 'warehouse';
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
            .map((decision) => ({ item: decision.item, line: decision.answer.line, count: decision.answer.count,
                receipts: decision.answer.receipts }))
    };
}

// Both the economy plan and bilateral consent evaluate the same physical bag
// and held lines. Backed stock is shown only for listing reconciliation;
// meeting admission still separately checks the seller's actual free stock.
function ownSaleInputs(state, own, options = {}) {
    const kept = new Map(own.filter(line => line.storeType === BoardRules.SELL)
        .map(line => [`${line.selfId}:${line.enchant || 0}`, line.price]));
    const inventory = { ...state.inventory };
    for (const line of own) {
        if (line.storeType !== BoardRules.SELL || line.custodyPolicy === 1) continue;
        const row = inventory[line.selfId] || { selfId: line.selfId, amount: 0 };
        inventory[line.selfId] = { ...row, amount: Number(row.amount || 0) + line.count,
            instances: [...(row.instances || []), { id: -line.lineId, amount: line.count, enchant: line.enchant, equipped: false }] };
    }
    const conditionalKept = new Set(own.filter(line => line.storeType === BoardRules.SELL && line.custodyPolicy === 1)
        .map(line => `${line.selfId}:${line.enchant || 0}`));
    for (const line of own) if (line.storeType === BoardRules.SELL && line.custodyPolicy !== 1)
        conditionalKept.delete(`${line.selfId}:${line.enchant || 0}`);
    return { state: { ...state, inventory }, options: { ...options, stockQuotes: true,
        slots: BOARD_SLOTS, kept, conditionalKept, stored: new Map() } };
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
    classify,
    evaluate,
    ownSaleInputs,
    isGear,
    prioritizeListings,
    traderContext,
    cardTraderContext,
    actorState,
    npcSaleForActor
};
