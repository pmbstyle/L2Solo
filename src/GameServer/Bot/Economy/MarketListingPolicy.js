const BeginnerShots = require('../../Items/C4BeginnerShots');
const LotPolicy = require('./MarketLotPolicy');
const Packet = require('./StatsPacket');
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
const ArrowStock = require('../../Inventory/ArrowStock');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const Diagnostics = require('./EconomyDiagnostics');
const { textDigest } = require('../Fnv1a');


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
    if (ArrowStock.isArrow(item) && !(ArrowStock.saleAmounts(state).get(Number(item.selfId)) > 0))
        return { action: 'keep', reason: 'archer_ammunition' };
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
        id, state, Number(Packet.moneyPrice(packet)), persona?.understanding, KnowledgeLearning.knowledgeEnabled());
    return MarketPricing.traderContext(state, {
        npcOffersFor: selfId => invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(selfId), // lazy: worker main-only NPC shops
        ...options,
        board: Object.hasOwn(options, 'board') ? options.board : invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(), // lazy: worker main-only board
        persona, preparedWorth: worth, preparedVersion: ColdEconomyDecision.usefulnessVersion(prepared),
        economy: { persona, hourAdena: Number(Packet.hourAdena(packet)), moneyPrice: Number(Packet.moneyPrice(packet)), gapHorizonHours: NaN, worth } });
}

// Board slots of a bot (user, 2026-10-05): 3 shop lines + 5 sell ads.
const BOARD_SLOTS = BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.sell_ad;

function listedAmounts(lines) {
    const amounts = new Map();
    for (const line of lines) {
        if (line.storeType !== BoardRules.SELL || !(line.count > 0)) continue;
        const key = `${line.selfId}:${line.enchant || 0}`;
        amounts.set(key, Number(amounts.get(key) || 0) + Number(line.count));
    }
    return amounts;
}

function saleLot(item, offset, count) {
    const lot = { ...item, count };
    if (item.objectIds?.length === item.count) {
        lot.objectIds = item.objectIds.slice(offset, offset + count);
        lot.objectId = lot.objectIds[0];
    } else {
        delete lot.objectIds;
        delete lot.objectId;
    }
    return lot;
}

// The facts an item's sale roll stands on (maintainer, 2026-11-05): the bag's
// units of the item and its price revision (the board's lines of it, a content
// digest both threads compute alike, and its deal count). No new fact, no new
// roll: an unchanged bag and market give the same answer, a bot does not
// change its mind with nothing new (a realism trade for a stable board).
function rollFacts(state, ctx, selfId) {
    const id = Number(selfId);
    return [Number(state.inventory?.[id]?.amount || 0), ctx.board?.itemFingerprint?.(id) ?? '',
        invoke('GameServer/Bot/Economy/MarketCounters').itemDeals(id).deals];
}

// A held disposition stands on exactly what MarketPricing.disposition reads:
// the lot and its options, the item's roll facts, its counter's deals and flow
// (belief index, demand history), the trader (persona traits over the hour,
// money price and gap horizon), the money price itself (not monotone in it:
// it prices risk, residual and wait), the item's worth and own stock, its
// knowledge state, and the route table (EconomicTrip.key, at the hour); the
// NPC shop rows are the worker's catalogue, fixed per worker start. Time
// alone moves nothing: a demand forecast or first price that decays with the
// clock refreshes at the item's next fact. An item a foreign conditional bid
// answers is not held: that bid's admission reads its buyer's state.
// base: the digest of the inputs every item of one sale shares (evaluate's
// holdBase), ~20 characters in front of the item's own ~100.
function holdKey(base, item, ctx, opts) {
    const id = Number(item.selfId), Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    const counter = Counters.counterOf(id), stock = ctx.ownStock?.groups?.get(`${id}:${Number(item.enchant || 0)}`);
    return base + JSON.stringify([id, Number(item.enchant || 0), Number(item.count), opts.town ?? null, opts.room,
        opts.stockQuote, Number(opts.standingPrice || 0), opts.selectedAnswerRecord, opts.rollKey.slice(3),
        Counters.revisionOf(counter), Counters.meetingRevisionOf(counter), Number(ctx.marketTrades?.[counter] || 0),
        ctx.economy?.worth?.(id) ?? null, ctx.ownStock?.known ?? null,
        stock ? [stock.units, stock.listedUnits, stock.prices?.size || 0] : null]);
}

function foreignConditionalBid(ctx, selfId) {
    return (ctx.board?.list(selfId, BoardRules.BUY) || []).some(line => line.custodyPolicy === 1
        && Number(line.ownerId) !== Number(ctx.characterId));
}

// What evaluate and its callers read of a disposition: the action, gain and
// answer, the ask's price, stock quote and NPC flag, the buy-back; the rest
// (the ask's values, the market's rivals, the belief) is not held.
function heldDisposition(chosen) {
    const ask = chosen.priced?.ask;
    return { action: chosen.action, gain: chosen.gain, answer: chosen.answer || null,
        priced: chosen.priced ? { ask: ask && { price: ask.price, stockQuote: ask.stockQuote, npc: ask.npc },
            market: { buyback: chosen.priced.market.buyback } } : null };
}

// The bot's sale at a market visit or a review (group E): the author's hard
// rules first; every other item goes by one expected-value decision (the
// board at its best ask, the NPC buy-back now, a buy ad answered in its town,
// or keeping it), one roll. Public interest and recent purchases rank the
// bounded slots, including held listings, before the unknown waiting stock.
// A line the bot already has keeps its price
// (its own look reprices it or takes it back, MarketPricing.look). options: now,
// decisionPoint (a roll of its own, e.g. one meeting; else the item's facts,
// rollFacts), saleHold (a Map the caller keeps per bot: held dispositions, see
// holdKey), slots (board slots), kept (item/enchant -> price),
// keptCounts (item/enchant -> actual listed units), stored (warehouse units),
// plus traderContext's. Without an escrow projection only conditional lines
// retain bag stock; a backed shop has already removed its own units.
// Returns { candidates, decisions, listings, npc, warehouse, answers };
// selected listings carry their line pricing state. Answers are the buy
// ads it chose to sell into ({ item, line, count }: the bot sells there when
// it is in the ad's town, the side that acts travels).
function evaluate(state, options = {}) {
    const ctx = traderContext(state, options);
    const hold = options.saleHold instanceof Map ? options.saleHold : null;
    const holdBase = hold ? textDigest(JSON.stringify([ctx.moneyPrice, ctx.hour, ctx.trader, ctx.knowledgeEnabled,
        invoke('GameServer/Bot/Economy/EconomicTrip').key(state)])) : null;
    const heldKeys = hold ? new Set() : null;
    const disposition = (item, opts) => {
        // An enchanted lot's belief reads its replacement and scroll prices (beliefFor): not held.
        if (!hold || Number(item.enchant || 0) > 0) return MarketPricing.disposition(item, ctx, opts);
        if (foreignConditionalBid(ctx, item.selfId)) {
            if (Diagnostics.active()) Diagnostics.count('sale_hold', 'built', 'conditional_bid');
            return MarketPricing.disposition(item, ctx, opts);
        }
        const key = holdKey(holdBase, item, ctx, opts);
        heldKeys.add(key);
        let chosen = hold.get(key);
        if (Diagnostics.active()) Diagnostics.count('sale_hold', chosen ? 'kept' : 'built', chosen ? 'same_inputs' : 'inputs_moved');
        if (!chosen) hold.set(key, chosen = heldDisposition(MarketPricing.disposition(item, ctx, opts)));
        return chosen;
    };
    const rollKey = item => ['dispose', ctx.characterId, item.selfId,
        ...(options.decisionPoint != null ? [options.decisionPoint] : rollFacts(state, ctx, item.selfId))];
    const craftReservations = ItemDisposition.selectedCraftAmounts(state, ctx.economy?.network);
    const candidates = ItemDisposition.saleCandidates(state, { ...options, unlimited: true,
        reserved: { ...options.reserved, ...craftReservations } });
    const owned = (ctx.board?.ownerLines?.(Number(state.characterId)) || [])
        .filter(line => line.storeType === BoardRules.SELL);
    const kept = options.kept || new Map(owned
        .map(line => [`${line.selfId}:${line.enchant || 0}`, line.price]));
    const keptCounts = options.keptCounts || listedAmounts(owned.filter(line => line.custodyPolicy === 1));
    const liquidate = invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state);
    const decisions = [];
    const forBoard = [];
    const dispose = (item, canList) => {
        const marketOnly = ItemDisposition.isGradeCrystal(item);
        const town = MarketTownPolicy.targetTownForItems(state, [item], options);
        const chosen = disposition(item, {
            town, room: canList && (options.stockQuotes === true || marketOnly) ? 1
                : liquidate ? 0 : roomFor(item, options.stored),
            stockQuote: canList && (options.stockQuotes === true || marketOnly),
            rollKey: rollKey(item),
            selectedAnswerRecord: Number(options.selectedAnswer?.selfId) === Number(item.selfId)
                && Number(options.selectedAnswer?.enchant || 0) === Number(item.enchant || 0)
                ? Number(options.selectedAnswer.recordId) : 0
        });
        const ask = chosen.priced?.ask;
        let action = (ask?.stockQuote || marketOnly && ask?.price > 0 && !ask.npc) && chosen.action !== 'ad' ? 'list'
            : marketOnly && ['keep', 'npc'].includes(chosen.action) ? 'keep'
            : chosen.action === 'keep' ? liquidate ? 'npc' : 'warehouse' : chosen.action;
        // One non-stackable instance fits a new line. An existing gear line
        // cannot silently acquire the bag's other copies at its standing price either.
        const blocked = action === 'list' && !canList;
        if (blocked) action = marketOnly ? 'keep' : liquidate ? 'npc' : 'warehouse';
        const decision = { action,
            reason: blocked ? 'no_board_slot' : ask?.stockQuote ? 'stock_quote' : 'expected_value', item,
            priced: chosen.priced, gain: chosen.gain, answer: chosen.answer,
            slotWeight: ask?.stockQuote
                ? Math.max(0, ask.price - chosen.priced.market.buyback) : chosen.gain };
        decisions.push(decision);
        if (decision.action === 'list') forBoard.push(decision);
    };
    for (const item of candidates) {
        const selectedAnswerRecord = Number(options.selectedAnswer?.selfId) === Number(item.selfId)
            && Number(options.selectedAnswer?.enchant || 0) === Number(item.enchant || 0)
            ? Number(options.selectedAnswer.recordId) : 0;
        const hard = classify(state, item);
        if (hard.action !== 'market') {
            decisions.push({ ...hard, item });
            continue;
        }
        const keptKey = `${item.selfId}:${item.enchant || 0}`;
        const standing = kept.has(keptKey) || !item.enchant && kept.has(Number(item.selfId));
        const stackable = ItemTemplateIndex.find(DataCache.items, item.selfId)?.etc?.stackable === true;
        // A stackable line takes the bag's further units at its price (its own look
        // reprices it); a gear line keeps its listed copies and the rest are disposed.
        const held = !standing ? 0 : stackable ? item.count : Math.min(item.count, Math.max(0, Math.floor(
            Number(keptCounts.get(keptKey) ?? (!item.enchant ? keptCounts.get(Number(item.selfId)) : 0)) || 0)));
        if (held > 0) {
            // Only unreserved conditional stock can answer from the field.
            // Reuse the sale decision, preserving the held ask unless it
            // actually chooses the opposite bid. Backed custody stays native.
            if (options.conditionalKept?.has(keptKey) && ctx.board?.first(item.selfId, 3,
                { excludeOwner: ctx.characterId, enchant: item.enchant || 0 })) {
                const chosen = disposition(item, {
                    town: state.currentRegion, room: roomFor(item, options.stored), stockQuote: true,
                    standingPrice: kept.get(keptKey) ?? kept.get(Number(item.selfId)),
                    rollKey: rollKey(item), selectedAnswerRecord
                });
                if (chosen.action === 'ad') {
                    decisions.push({ action: 'ad', reason: 'expected_value', item, priced: chosen.priced,
                        gain: chosen.gain, answer: chosen.answer });
                    continue;
                }
            }
            decisions.push({ action: 'list', reason: 'kept_line', item: { ...saleLot(item, 0, held), price: kept.get(keptKey) ?? kept.get(Number(item.selfId)),
                marketReason: 'kept_line' } });
        }
        const remaining = item.count - held;
        if (!remaining) continue;
        const listingCount = standing ? 0 : stackable ? remaining : 1;
        if (listingCount) dispose(saleLot(item, held, listingCount), true);
        if (remaining > listingCount) dispose(saleLot(item, held + listingCount, remaining - listingCount), false);
    }
    for (const decision of forBoard) {
        const price = decision.priced.ask.price;
        decision.item = { ...decision.item, price, marketReason: decision.reason,
            pricing: MarketPricing.lineState(decision.item.selfId, ctx, { price, storeType: BoardRules.SELL, enchant: decision.item.enchant || 0 }) };
    }
    // The hold keeps only this sale's items: a sold, moved or repriced one leaves it.
    if (hold) for (const key of hold.keys()) if (!heldKeys.has(key)) hold.delete(key);
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
            // Escrow is retained before the free bag copies of this type.
            instances: [{ id: -line.lineId, amount: line.count, enchant: line.enchant, equipped: false },
                ...(row.instances || (row.amount > 0 ? [{ id: 0, amount: row.amount,
                    enchant: row.enchant || 0, equipped: row.equipped }] : []))] };
    }
    const conditionalKept = new Set(own.filter(line => line.storeType === BoardRules.SELL && line.custodyPolicy === 1)
        .map(line => `${line.selfId}:${line.enchant || 0}`));
    for (const line of own) if (line.storeType === BoardRules.SELL && line.custodyPolicy !== 1)
        conditionalKept.delete(`${line.selfId}:${line.enchant || 0}`);
    return { state: { ...state, inventory }, options: { ...options, stockQuotes: true,
        slots: BOARD_SLOTS, kept, keptCounts: listedAmounts(own), conditionalKept, stored: options.stored || new Map() } };
}

// Room to keep an item: gear keeps two copies in the warehouse
// (BotWarehouseService), anything else has room.
function roomFor(item, stored) {
    if (!isGear(item) || !stored) return 1;
    const kept = Number(stored.get?.(Number(item.selfId)) ?? stored[Number(item.selfId)] ?? 0);
    return Math.max(0, Math.min(1, (MAX_GEAR_COPIES_PER_TYPE - kept) / Math.max(1, Number(item.count) || 1)));
}

// A bot in the world seen by the cold rules: its saved life state with the
// live bag, level, class and load limit of the actor.
function actorState(session) {
    const actor = session.actor;
    const inventory = invoke('GameServer/Bot/Population/BotLifeState').inventorySummaryFromItems(actor.backpack.fetchItems());
    return {
        ...(session.coldLifeState || {}),
        characterId: Number(actor.fetchId()),
        level: Number(actor.fetchLevel?.() || session.coldLifeState?.level || 1),
        adena: Number(inventory['57']?.amount || 0),
        inventory,
        stats: { ...(session.coldLifeState?.stats || {}), classId: Number(actor.fetchClassId?.() || 0) },
        ...(actor.fetchMaxLoad?.() > 0 ? { maxLoad: Number(actor.fetchMaxLoad()) } : {})
    };
}

// What a bot in the world sells to the NPC, by selfId and count: the cold
// visit's NPC sale (evaluate().npc) on the actor's own bag. The hot town visit
// sells exactly this and keeps it out of the warehouse, as the cold visit sells
// before it stores.
function npcSaleForActor(session) {
    const sale = new Map();
    for (const line of npcSaleCandidatesForActor(session)) {
        sale.set(Number(line.selfId), Number(sale.get(Number(line.selfId)) || 0) + Number(line.count || 0));
    }
    return sale;
}

function npcSaleCandidatesForActor(session) {
    if (!session?.actor?.backpack?.fetchItems) return [];
    return evaluate(actorState(session), { unlimited: true, allowPreTradeCleanup: true }).npc;
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
    npcSaleForActor,
    npcSaleCandidatesForActor
};
