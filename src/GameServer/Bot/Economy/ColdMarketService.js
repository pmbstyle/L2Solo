const Diagnostics = require('./EconomyDiagnostics');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const OfferOrder = require('./OfferOrder');
const OfferQuery = require('./OfferQuery');

function purchaseObservation(state, selfId, requested, budget, phase, reason, extra) {
    if (!Diagnostics.active()) return;
    Diagnostics.count('market', phase, reason);
    if (!Diagnostics.enabled(state?.characterId)) return;
    Diagnostics.push({ owner: Number(state.characterId), phase, reason, item: Number(selfId), requested: Number(requested),
        wallet: Number(state.adena ?? state.inventory?.[57]?.amount), budget, available: budget,
        reserve: Number(state.stats?.money?.[2]), owned: Number(state.inventory?.[selfId]?.amount || 0),
        decisionSeq: Number(state.stats?.decisionSeq), activityLeaf: Number(state.stats?.activityLeaf),
        revision: Number(state.simulation?.revision), wishKey: state.stats?.wishFocus?.[0], town: state.currentRegion,
        errandAt: Number(state.stats?.marketErrand?.at), ...extra });
}

const RETRY_DELAY_MS = 15 * 60 * 1000;
// A bound on an errand the bot has not carried out (no route, a party that
// keeps it): after it the job that sent it plans again.
const ERRAND_MS = CombinedErrands.ERRAND_MS;

// A failed purchase writes the bot's pre-trade state back as cold. While the
// job awaited the trade the bot may have been activated: its row is hot and
// belongs to the actor in the world (LifeState.hotRow, the AFK sync's rule);
// a cold write here would roll its wallet back although the items moved. The
// hot row is handed back unchanged and the cold side redoes the goal later.
function hotResult(state, reason) {
    const hot = LifeState.hotRow(state.characterId);
    return hot ? { state: hot, purchased: false, reason, wanted: false, remoteOffer: null } : null;
}

function retryAfterFailedPurchase(state, goal, reason) {
    const hot = hotResult(state, reason);
    if (hot) return Promise.resolve(hot);
    if (reason === 'no_affordable_offer') MarketTelemetry.noOffer();
    else if (reason === 'offer_changed') MarketTelemetry.offerChanged();
    else if (reason === 'purchase_failed' || reason === 'persist_failed') MarketTelemetry.purchaseFailed();
    const timestamp = Date.now();
    const retryState = {
        ...state,
        stats: {
            ...(state.stats || {}),
            marketRetryAfter: timestamp + RETRY_DELAY_MS,
            marketWanted: {
                ...(state.stats?.marketWanted || {}),
                itemId: goal.target.itemId,
                itemName: goal.target.itemName,
                lastMissingAt: timestamp
            },
            marketLead: null
        }
    };
    const wanted = TradeChat.maybeAnnounceWanted(retryState, goal);
    const returnState = GoalExecutor.finishMarketVisit(wanted.state) || wanted.state;
    return LifeState.upsertState(returnState, 'market_no_offer_return').then((saved) => ({
        state: saved || returnState,
        purchased: false,
        reason,
        wanted: wanted.announced,
        remoteOffer: null
    }));
}

function finishBlockedPurchase(state, goal, reason) {
    const hot = hotResult(state, reason);
    if (hot) return Promise.resolve(hot);
    const stats = {
        ...(state.stats || {}),
        marketRetryAfter: null,
        marketWanted: null,
        marketLead: null
    };
    if (Number(stats.equipmentPlan?.target?.selfId || 0) === Number(goal?.target?.itemId || 0)) {
        delete stats.equipmentPlan;
        delete stats.partyRequest;
    }
    const completedState = { ...state, stats, timing: { ...(state.timing || {}), nextResolveAt: Date.now() } };
    const returning = GoalExecutor.finishMarketVisit(completedState) || completedState;
    return LifeState.upsertState(returning, `market_purchase_${reason}`).then((saved) => (
        GoalState.applyPurchase(state.characterId, goal, 1).then(() => ({
            state: saved || returning,
            purchased: false,
            reason,
            remoteOffer: null
        }))
    ));
}

function observePurchase(offer, units, state) {
    try { MarketTelemetry.purchase(offer, units, {
        buyerCharacterId: state.characterId, buyerName: state.name, town: state.currentRegion
    }); } catch (error) { utils.infoWarn('BotMarket', 'committed purchase telemetry deferred: %s', error.message); }
}

// Buys `options.qty` (one by default) of a found offer for a cold bot: a
// board record through AfkTradeService (one deal transaction), otherwise an
// NPC or a configured city merchant. No goal or travel change; an NPC
// purchase records the bot as shopping unless options.keepActivity (a
// purchase made for it where it hunts).
function buyOffer(state, offer, options = {}) {
    if (!options.economyCommand && !MarketOpportunity.botCanBuy(offer)) return Promise.resolve({ purchased: false, blocked: true, reason: 'configured_supply_retired' });
    const qty = Math.max(1, Math.floor(Number(options.qty) || 1));
    const blocker = options.economyCommand ? null : LifeState.marketPurchaseBlocker(state, offer, qty);
    if (blocker) { if (Diagnostics.active()) purchaseObservation(state, offer.selfId, qty, undefined, 'purchase_refusal', blocker);
        return Promise.resolve({ purchased: false, blocked: true, reason: blocker }); }
    if (['afk_player_store', 'afk_bot_store'].includes(offer.sourceType)) {
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        return AfkTrade.buyFromShop(
            state.characterId,
            offer.store,
            offer.selfId,
            qty,
            { lineId: offer.lineId, expectedPrice: offer.price, expectedRevision: offer.expectedRevision ?? offer.revision,
                coldState: state, autoEquip: options.autoEquip, economyCommand: options.economyCommand,
                funding: PurchaseFunding.nativeTerms(options, offer.selfId) }
        ).then((trade) => {
            const done = AfkTrade.committedTrade(trade, state.characterId);
            if (!done.committed) throw new Error('cold_state_sync_failed');
            // Native commit includes the buyer's experience exactly once.
            const buyer = done.state || state;
            const units = Number(trade.amount ?? trade.units ?? 0), spent = Number(trade.totalPrice ?? trade.spent ?? 0);
            const diagnostics = require('./EconomyDiagnostics');
            if (diagnostics.enabled(state.characterId)) diagnostics.push({ owner: state.characterId,
                phase: 'native_purchase', trigger: 'public_quote', reason: trade.replayed ? 'replayed' : 'committed',
                source: offer.sourceType, item: Number(offer.selfId), actual: units, spent, quote: Number(offer.price),
                town: offer.town, recordId: Number(offer.recordId), lineId: Number(offer.lineId),
                revision: Number(offer.expectedRevision ?? offer.revision), nativeId: Number(trade.eventId),
                commandId: trade.economyCommand?.[0], sequence: trade.economyCommand?.[2] });
            if (!trade.replayed) observePurchase(offer, units, buyer);
            if (Object.isExtensible(options)) options.economyCommand = trade.economyCommand;
            return { state: buyer, purchased: units > 0, units, spent, hot: done.hot,
                offer, sellerState: null, economyCommand: trade.economyCommand };
        }).catch((error) => {
            utils.infoWarn('BotMarket', 'AFK market purchase failed for %s: %s', state.name, error.message);
            return { state: LifeState.cachedState(state.characterId) || state, purchased: false, reason: 'offer_changed' };
        });
    }
    const reserved = !options.economyCommand;
    if (reserved && !MarketOpportunity.reserve(offer, qty)) return Promise.resolve({ purchased: false, reason: 'offer_changed' });
    return buyNpcStack(state, offer.selfId, qty, Number(offer.price), PurchaseFunding.nativeTerms(options, offer.selfId), options.economyCommand, options.autoEquip).then(async (purchase) => {
        if (!purchase) {
            if (reserved) MarketOpportunity.release(offer, qty);
            return { purchased: false, reason: 'persist_failed' };
        }
        let updated = purchase.state;
        if (Object.isExtensible(options)) options.economyCommand = purchase.economyCommand;
        if (options.autoEquip !== false && Number(offer.equipSlot || 0) > 0) {
            try { updated = await LifeState.syncExternalInventory(state.characterId, 'afk_trade_npc_purchase', updated) || updated; }
            catch (error) { utils.infoWarn('BotMarket', 'committed NPC inventory delivery deferred: %s', error.message); }
        }
        return { state: updated, purchased: purchase.units > 0, units: purchase.units, spent: purchase.spent,
            offer, sellerState: null, hot: !!LifeState.hotRow(state.characterId), economyCommand: purchase.economyCommand };
    }).catch((err) => {
        if (reserved) MarketOpportunity.release(offer, qty);
        utils.infoWarn('BotMarket', 'cold purchase failed for %s: %s', state.name, err.message);
        return { purchased: false, reason: 'purchase_failed' };
    });
}

// What sells an item at a fixed price in each town: the NPC shops and the
// configured shot merchants until 3.6 (their stock never runs out for a cold bot, as
// the author's cold NPC restock had it).
function staticOffers(selfId) {
    return [...MarketOpportunity.npcOffersAll(selfId),
        ...MarketOpportunity.fixedStoreOffers(selfId)];
}

// The bot's round trip to a town in Adena, from its farming place
// (OfferOrder.tripCost); none to the town it is shopping in.
function tripFrom(state, timestamp = Date.now()) {
    const here = state?.activity === 'shopping' ? state.currentRegion || null : null;
    const origin = OfferOrder.farmingOrigin(state, (spotId) => invoke('GameServer/Bot/AI/SpotService').findById(spotId));
    const trip = OfferOrder.tripCost(state, { origin, timestamp });
    return (town) => (town === here ? 0 : trip ? trip(town) : 0);
}

// Keep the originating valuation through a trip. Zero is a real rate: it
// must not fall back to an unrelated funded item in the current packet.
function fundingTerms(options = {}) {
    const terms = {};
    for (const name of ['r', 'valueHours', 'survivalCost']) {
        if (options[name] !== undefined && options[name] !== null && Number.isFinite(Number(options[name]))) {
            terms[name] = Number(options[name]);
        }
    }
    return terms;
}

function purchaseMoney(state, plan, spent = 0) {
    const wallet = PurchaseFunding.budget(state);
    const limit = Number.isFinite(plan.money) ? Math.max(0, plan.money - spent) : Infinity;
    let funded;
    if (plan.purpose === 'clan') {
        // The treasury part was already credited by ClanMarketService. It
        // is excluded from personal free money before adding its remainder.
        const clanPart = Math.min(wallet, Math.max(0, Number(plan.tag?.clanPart || 0) - spent));
        funded = clanPart + PurchaseFunding.spendable({ ...state, adena: wallet - clanPart }, 0, { free: true });
    } else {
        const terms = fundingTerms(plan);
        const options = { itemId: plan.selfId, ...terms };
        // An old errand has no valuation. It may still restore its actual
        // missing survival kit, never the former general purchasing cap.
        if (plan.purpose === 'shots' || (terms.r === undefined && terms.valueHours === undefined)) {
            options.survivalCost = invoke('GameServer/Bot/Economy/EconomyContext').basics(state).kitCost(plan.selfId, Number(plan.npcPrice) || null);
        }
        funded = PurchaseFunding.spendable(state, 0, options);
    }
    return Math.max(0, Math.floor(Math.min(wallet, limit, funded)));
}

function purchaseTerms(state, plan, spent = 0) {
    const terms = fundingTerms(plan);
    if (plan.purpose === 'clan') return { ...terms, free: true,
        clanPart: Math.min(PurchaseFunding.budget(state), Math.max(0, Number(plan.tag?.clanPart || 0) - spent)) };
    if (plan.purpose === 'shots' || (terms.r === undefined && terms.valueHours === undefined)) {
        terms.survivalCost = invoke('GameServer/Bot/Economy/EconomyContext').basics(state).kitCost(plan.selfId, Number(plan.npcPrice) || null);
    }
    return terms;
}

// The one purchase path of a cold bot (б5, D1, user 2026-10-05): every
// board purchase is a trip to the seller's town. planPurchase picks the town
// (OfferQuery.cheapestTown over the board and the NPC shops, the bot's round
// trip included; none to the town it is shopping in); acquire buys there at
// once when the bot stands in it, else leaves it an errand and starts the
// author's market trip (GoalExecutor.beginMarketTravel); on arrival
// tryPurchase buys the errand (buyHere). One trip per purchase.
function planPurchase(state, selfId, amount, options = {}) {
    const { money = Infinity, maxPrice = Infinity, npc = true, towns = null,
        timestamp = Date.now(), cost = null } = options;
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    let plan;
    if (options.sourcePlan) {
        const source = options.sourcePlan;
        if (!source.town || towns && !towns.includes(source.town) || Number(source.selfId) !== Number(selfId)) return null;
        const quotes = (source.lines || []).slice(0, 5).map(entry => entry.line);
        let npcPrice = 0;
        if (npc && Number.isSafeInteger(Number(source.npc)) && Number(source.npc) > 0) {
            const lineCost = (source.lines || []).slice(0, 5).reduce((sum, entry) => sum + Number(entry.price) * Number(entry.count), 0);
            const price = Number(source.npcPrice ?? (Number(source.cost) - lineCost) / Number(source.npc));
            if (staticOffers(selfId).some(offer => offer.town === source.town && Number(offer.price) === price)) npcPrice = price;
        }
        const filled = OfferQuery.fill(quotes, amount, { money, maxPrice, npcPrice, excludeOwner: state?.characterId });
        if (filled.units < amount || !Number.isFinite(Number(source.landed))) return null;
        plan = { ...filled, town: source.town, npcPrice, whole: true,
            landed: filled.cost + Math.max(0, Number(source.landed) - Number(source.cost || 0)) };
    } else if (options.quoteDepth) {
        const groups = new Map(), board = AfkTrade.boardIndex();
        const quotes = board.list(selfId, AfkTrade.SELL);
        for (let at = 0; at < Math.min(5, quotes.length); at++) {
            const line = quotes[at];
            if (Number(line.ownerId) === Number(state.characterId) || towns && !towns.includes(line.town)) continue;
            if (!groups.has(line.town)) groups.set(line.town, { lines: [], npcPrice: 0 });
            groups.get(line.town).lines.push(line);
        }
        // An errand retains its finite quote depth, including a legal NPC
        // remainder. Arrival must not turn that selected source into a board-
        // only query or expand to the full public market.
        if (npc) for (const offer of staticOffers(selfId)) {
            if (towns && !towns.includes(offer.town)) continue;
            if (!groups.has(offer.town)) groups.set(offer.town, { lines: [], npcPrice: 0 });
            const group = groups.get(offer.town), price = Number(offer.price);
            if (price > 0) group.npcPrice = group.npcPrice ? Math.min(group.npcPrice, price) : price;
        }
        const trip = cost || tripFrom(state, timestamp);
        for (const [town, group] of groups) {
            const filled = OfferQuery.fill(group.lines, amount, { money, maxPrice, npcPrice: group.npcPrice,
                excludeOwner: state?.characterId });
            const landed = filled.cost + Number(trip(town));
            if (filled.units < amount || !Number.isFinite(landed)) continue;
            if (!plan || landed < plan.landed) plan = { town, ...filled, npcPrice: group.npcPrice, landed, whole: true };
        }
    } else plan = OfferQuery.cheapestTown(AfkTrade.boardIndex(), selfId, {
        amount, money, maxPrice, towns, excludeOwner: state?.characterId,
        npcOffers: npc ? staticOffers(selfId) : [],
        cost: cost || tripFrom(state, timestamp)
    });
    if (Diagnostics.active()) purchaseObservation(state, selfId, amount, money, 'purchase_plan', plan ? 'source_selected' : 'no_affordable_source',
        Diagnostics.enabled(state.characterId) ? { planned: Number(plan?.units || 0), remaining: Math.max(0, amount - Number(plan?.units || 0)),
            cost: Number(plan?.cost), town: plan?.town, source: plan?.npc > 0 ? 'npc_and_board' : 'board', unitPrice: Number(plan?.npcPrice),
            caller: options.purpose || 'planPurchase' } : undefined);
    return plan ? { ...plan, selfId: Number(selfId), amount: Number(amount), money, ...fundingTerms(options),
        ...(options.purpose ? { purpose: options.purpose } : {}), ...(options.tag ? { tag: options.tag } : {}) } : null;
}

// Buys a plan in the town the bot stands in: each board line one deal, then
// the NPC for the rest (also the units of a line that changed meanwhile),
// within the plan's money. Returns { state, units, spent, hot }.
async function buyHere(state, plan, options = {}) {
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    let current = state;
    let units = 0;
    let spent = 0;
    for (const entry of plan.lines || []) {
        if (current.phase !== 'cold' || LifeState.hotRow(current.characterId)) return { state: current, units, spent, hot: true };
        if (units >= plan.amount) break;
        const offer = AfkTrade.offerOf(entry.line, plan.town);
        if (!offer || Number(offer.price) !== Number(entry.price)) continue;
        const count = Math.max(0, Math.min(entry.count, plan.amount - units,
            Math.floor(purchaseMoney(current, plan, spent) / Number(offer.price))));
        if (!(count > 0)) continue;
        const bought = await buyOffer(current, offer, { qty: count, autoEquip: false, ...purchaseTerms(current, plan, spent) });
        current = bought.state || current;
        if (!bought.purchased) continue;
        units += Number(bought.units || 0);
        spent += Number(bought.spent || 0);
        if (options.goal && bought.units > 0) {
            await GoalState.applyPurchase(current.characterId, options.goal.expectedGoal, bought.units);
            const snapshot = GoalState.snapshot(current.characterId);
            options.goal = { expectedGoal: snapshot.current, updatedAt: snapshot.updatedAt };
        }
        if (bought.hot || LifeState.hotRow(current.characterId)) return { state: current, units, spent, hot: true };
    }
    if (current.phase !== 'cold' || LifeState.hotRow(current.characterId)) return { state: current, units, spent, hot: true };
    if (options.skipNpc) return { state: current, units, spent, hot: false };
    // A saved plan may predate group F or a rate change. Only a current
    // NPC/shot-table quote in this town can supply its remainder.
    const quotedPrice = Number(plan.npcPrice || 0);
    const npcPrice = staticOffers(plan.selfId).some((offer) => offer.town === plan.town
        && Number(offer.price) === quotedPrice) ? quotedPrice : 0;
    const money = npcPrice > 0 ? purchaseMoney(current, plan, spent) : 0;
    const rest = npcPrice > 0 ? Math.max(0, Math.min(plan.amount - units, Math.floor(money / npcPrice))) : 0;
    if (Diagnostics.active()) purchaseObservation(current, plan.selfId, plan.amount - units, money, 'npc_remainder',
        !npcPrice ? 'no_current_npc_quote' : rest < plan.amount - units ? 'funding_partial' : 'funded',
        Diagnostics.enabled(current.characterId) ? { planned: rest, actual: units, unitPrice: npcPrice, source: 'npc', town: plan.town } : undefined);
    if (rest > 0) {
        let bought;
        if (options.goal || options.errand) {
            const NpcRestock = require('./NpcRestockPlan');
            const offer = NpcRestock.quoteFor(plan.selfId, plan.town, npcPrice);
            const basics = invoke('GameServer/Bot/Economy/EconomyContext').basics(current);
            const baskets = NpcRestock.collect(current, { town: plan.town, seller: offer,
                shots: basics.stock('shots').itemId !== Number(plan.selfId),
                potions: basics.stock('potions').itemId !== Number(plan.selfId), scrolls: Number(plan.selfId) !== 736,
                extras: [{ selfId: plan.selfId, amount: rest, offer, funding: purchaseTerms(current, plan, spent),
                    goal: options.goal, errand: options.errand, autoEquip: options.autoEquip === true }] });
            if (baskets[0]) {
                const receipt = await require('./NpcPurchaseBasket').purchase(current, baskets[0]);
                const line = receipt.lines.find(row => Number(row.selfId) === Number(plan.selfId));
                bought = receipt.ok ? { ...receipt, units: Number(line?.amount || 0),
                    spent: Number(line?.amount || 0) * npcPrice } : null;
            }
        } else bought = await buyNpcStack(current, plan.selfId, rest, npcPrice, purchaseTerms(current, plan, spent), null, false);
        if (bought) {
            current = bought.state;
            units += bought.units;
            spent += bought.spent;
            if (bought.hot || LifeState.hotRow(current.characterId)) return {
                state: LifeState.hotRow(current.characterId) || current, units, spent, hot: true,
                progressApplied: !!options.goal && units > 0 };
        }
    }
    if (Diagnostics.active()) purchaseObservation(state, plan.selfId, plan.amount, plan.money, 'purchase_result',
        units >= plan.amount ? 'filled' : npcPrice > 0 && money < (plan.amount - units) * npcPrice ? 'funding_partial'
            : Number(plan.units || 0) < plan.amount ? 'supply_partial' : 'source_changed_or_refused',
        Diagnostics.enabled(state.characterId) ? { planned: Number(plan.units), actual: units, remaining: Math.max(0, plan.amount - units), spent, town: plan.town } : undefined);
    return { state: current, units, spent, hot: false, progressApplied: !!options.goal && units > 0 };

}

// The NPC part of a stack purchase, the author's fenced cold write
// (Database.purchaseNpcInventoryItem, as his cold shot restock made it): the
// bag and the wallet in one transaction, the cold state following. null when
// refused.
async function buyNpcStack(state, selfId, amount, unitPrice, funding = {}, original = null, autoEquip = true) {
    const Basket = require('./NpcPurchaseBasket');
    const seller = Basket.sellerFor(selfId, state.currentRegion, unitPrice);
    if (!seller) {
        // Configured town merchants retain their native singleton owner;
        // they cannot be attributed to a physical NPC's shop list.
        const configured = () => MarketOpportunity.fixedStoreOffers(selfId).some(offer =>
            offer.town === state.currentRegion && Number(offer.price) === unitPrice);
        if (!configured()) return null;
        const Commit = require('./EconomyCommit');
        const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(selfId));
        const admitted = await Commit.admit(state, Commit.KINDS.npcBuy, original);
        let result;
        try { result = await invoke('Database').purchaseNpcInventoryItem(state.characterId, {
            selfId, amount, unitPrice, autoEquip, name: template?.template?.name || `Item ${selfId}`,
            stackable: !!template?.etc?.stackable, slot: Number(template?.etc?.slot || 0),
            coldState: admitted.state, economyCommand: admitted.command,
            funding: { ...funding, itemId: selfId }, validate: () => {
                if (!configured()) throw Error('configured_quote_changed');
            }
        }); } finally { Commit.finish(state.characterId, admitted.command); }
        if (!result?.ok) return null;
        const current = result.coldLifeRow ? Commit.acceptRow(result.coldLifeRow) : admitted.state;
        if (!result.replayed) observePurchase({ sourceType: 'configured_store', selfId, price: unitPrice }, result.amount, current);
        return { ...result, state: current, units: Number(result.amount),
            economyCommand: admitted.command, hot: !!LifeState.hotRow(state.characterId) };
    }
    const purchase = await Basket.purchase(state, { seller, original,
        lines: [{ selfId, amount, unitPrice, autoEquip, funding: { ...funding, itemId: selfId } }] });
    if (!purchase?.ok) return null;

    return purchase;
}

// The bot's errand while it still stands (ERRAND_MS), else null.
function pendingErrand(state, timestamp = Date.now()) {
    const errands = CombinedErrands.pending(state, timestamp);
    return errands.find(errand => errand.town === state?.currentRegion) || errands[0] || null;
}

function errandGoal(errand) {
    return { type: 'market_errand', status: 'active', target: { itemId: errand.selfId, amount: errand.amount },
        plan: { expectedBenefit: 'market_errand', marketTown: errand.town, purpose: errand.purpose } };
}

function goalForErrand(state, errand) {
    const snapshot = GoalState.snapshot(state.characterId), goal = snapshot?.current;
    return goal?.type === 'market_errand' && goal.status === 'active'
        && Number(goal.target?.itemId) === Number(errand.selfId)
        && Number(goal.target?.amount) === Number(errand.amount)
        && goal.plan?.purpose === errand.purpose && goal.plan?.marketTown === errand.town
        ? { expectedGoal: goal, updatedAt: snapshot.updatedAt } : null;
}

// Reuse the nullable native tag for the two bounded source flags. A one-
// element route tag replaces null without growing each of eight obligations.
function savedRouteTag(options) {
    if (options.tag != null) return options.tag;
    return options.quoteDepth ? [options.npc === false ? -5 : 5] : options.npc === false ? [-1] : null;
}

function savedRoute(errand) {
    const tag = errand.tag;
    if (Array.isArray(tag) && tag.length === 1 && [5, -5, -1].includes(tag[0])) {
        return { npc: tag[0] > 0, quoteDepth: Math.abs(tag[0]) === 5 ? 5 : undefined, tag: null };
    }
    return { npc: errand.npc !== false && (tag?.offer?.sourceType === undefined || tag.offer.sourceType === 'npc'),
        quoteDepth: errand.quoteDepth, tag };
}

// A cold bot needs `amount` of an item for `purpose` (a shot restock, a
// crafter's input, a clan order...): it buys where it stands when that town
// is the cheapest with the trip, else it keeps an errand and goes there.
// Returns { state, bought, units, traveling, plan }; `persist` false leaves
// the state unsaved (a caller that saves it). A bot in a party keeps the
// errand: its party's market break takes it there (NeedsEvaluator).
async function acquire(state, selfId, amount, options = {}) {
    // ARCH-NOTE: a saved cap outlives the packet that admitted it. Recheck
    // at planning, arrival and each debit using the originating valuation.
    options = { ...options, money: purchaseMoney(state, { ...options, selfId: Number(selfId) }) };
    const visitTown = state.stats?.travel?.townName || (state.activity === 'shopping' ? state.currentRegion : null);
    const local = visitTown ? planPurchase(state, selfId, amount, { ...options, towns: [visitTown] }) : null;
    const plan = local || planPurchase(state, selfId, amount, options);
    if (Diagnostics.active()) purchaseObservation(state, selfId, amount, options.money, 'acquire_request', plan ? 'planned' : 'no_source',
        Diagnostics.enabled(state.characterId) ? { planned: Number(plan?.units || 0), caller: options.purpose || 'acquire', town: plan?.town } : undefined);
    if (!plan) return { state, bought: false, units: 0, traveling: false, plan: null };
    if (state.activity === 'shopping' && plan.town === state.currentRegion) {
        const bought = await buyHere(state, plan);
        return { state: bought.state, bought: bought.units > 0, units: bought.units, spent: bought.spent, traveling: false, plan, hot: bought.hot };
    }
    const errand = { selfId: Number(selfId), amount: Number(amount), town: plan.town, money: Number.isFinite(plan.money) ? plan.money : null,
        maxPrice: Number.isFinite(options.maxPrice) ? options.maxPrice : null, purpose: options.purpose || 'supply',
        tag: savedRouteTag(options), at: Number(options.timestamp || Date.now()), ...fundingTerms(options) };
    const withErrand = CombinedErrands.enqueue(state, errand);
    const from = state.activity === 'shopping' ? { ...withErrand, activity: 'hunting' } : withErrand;
    const travel = state.party?.partyId || state.partyId || (state.activity === 'shopping' && state.stats?.townVisit?.completed !== true)
        ? null : GoalExecutor.beginMarketTravel(from, errandGoal(errand));
    if (travel && state.activity === 'shopping') travel.stats.marketReturn = state.stats?.marketReturn || travel.stats.marketReturn;
    const next = travel || withErrand;
    if (Diagnostics.active()) purchaseObservation(state, selfId, amount, options.money, 'market_travel', travel ? 'departed' : state.party?.partyId || state.partyId ? 'party_wait' : 'town_visit_wait',
        Diagnostics.enabled(state.characterId) ? { errandAt: errand.at, town: errand.town, planned: Number(plan.units), caller: errand.purpose } : undefined);
    if (options.persist === false) return { state: next, bought: false, units: 0, traveling: !!travel, plan };
    const saved = await LifeState.upsertState(next, travel ? `market_errand_${errand.purpose}` : 'market_errand_kept');
    return { state: saved || next, bought: false, units: 0, traveling: !!travel && !!saved, plan };
}

// A selected craft's total inputs, rather than independent blind requests.
// Board inputs keep their deals; local NPC remainders settle by real seller.
// Re-entry checks the current bag, so already acquired inputs are not bought
// again before the craft has actually consumed them.
async function acquireMaterials(state, requirements) {
    if (requirements.length > 12) {
        let current = state, spent = 0, units = 0;
        for (let at = 0; at < requirements.length; at += 12) {
            const part = await acquireMaterials(current, requirements.slice(at, at + 12));
            current = part.state; spent += part.spent; units += part.units;
            if (!part.ready || part.hot) return { ...part, state: current, spent, units };
        }
        return { state: current, ready: true, spent, units };
    }
    let current = state, spent = 0, units = 0;
    const extras = [];
    const held = (value, id) => {
        const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(value);
        return require('./WealthCraftDecision').freeAmount(value,
            value.inventory?.[id] || { selfId: Number(id), amount: 0 }, reserved);
    };
    for (const requirement of requirements) {
        const missing = Math.max(0, Number(requirement.amount) - held(current, requirement.selfId));
        if (!missing) continue;
        const options = requirement.options || {};
        const terms = { ...options, selfId: Number(requirement.selfId),
            money: purchaseMoney(current, { ...options, selfId: Number(requirement.selfId) }) };
        const plan = planPurchase(current, requirement.selfId, missing, terms);
        if (!plan || current.activity !== 'shopping' || plan.town !== current.currentRegion) {
            const bought = await acquire(current, requirement.selfId, missing, options);
            current = bought.state || current; spent += Number(bought.spent || 0); units += Number(bought.units || 0);
            if (bought.hot || bought.traveling || current.stats?.marketErrand) return { ...bought, state: current, ready: false, spent, units };
            continue;
        }
        const board = await buyHere(current, plan, { skipNpc: true });
        current = board.state; spent += board.spent; units += board.units;
        if (board.hot) return { state: current, ready: false, hot: true, spent, units };
        const left = Math.max(0, Number(requirement.amount) - held(current, requirement.selfId));
        const offer = options.npc === false ? null
            : require('./NpcRestockPlan').quoteFor(requirement.selfId, current.currentRegion, Number(plan.npcPrice) || null);
        if (offer && left > 0 && offer.price <= Number(options.maxPrice ?? Infinity)) extras.push({
            selfId: requirement.selfId, amount: left, offer, money: Math.max(0, terms.money - board.spent),
            funding: purchaseTerms(current, { ...terms, npcPrice: offer.price }) });
    }
    const result = await require('./NpcRestockPlan').purchase(current, {
        town: current.currentRegion, extras, potions: false, scrolls: false, shots: false });
    current = result.state;
    for (const receipt of result.receipts) { spent += Number(receipt.spent || 0); units += Number(receipt.units || 0); }
    return { state: current, spent, units, hot: !!LifeState.hotRow(current.characterId),
        ready: requirements.every(row => held(current, row.selfId) >= Number(row.amount)) };
}

// On arrival: the errand of the town the bot stands in, bought there (the
// plan made again for this town, as the board stands now); what it bought
// stays as stats.lastErrand for the job that sent it (a clan's order).
// Returns null without one, or when it lapsed (ERRAND_MS: the job that sent
// it plans again).
async function buyErrand(state, options = {}) {
    const errand = pendingErrand(state);
    if (!errand || state.activity !== 'shopping' || errand.town !== state.currentRegion) return null;
    const terms = { towns: [errand.town], purpose: errand.purpose, ...savedRoute(errand), ...fundingTerms(errand),
        money: errand.money ?? Infinity, maxPrice: errand.maxPrice ?? Infinity };
    const plan = planPurchase(state, errand.selfId, errand.amount,
        { ...terms, money: purchaseMoney(state, { ...terms, selfId: errand.selfId }) });
    const bought = plan ? await buyHere(state, plan, { ...options, goal: goalForErrand(state, errand),
        ...(!options.skipNpc && !plan.lines?.length ? { errand } : {}) }) : { state, units: 0, hot: false };
    if (bought.hot) return { state: bought.state, purchased: bought.units > 0, reason: 'bot_went_hot' };
    const rest = Math.max(0, Number(errand.amount) - Number(bought.units || 0));
    if (Diagnostics.active()) purchaseObservation(state, errand.selfId, errand.amount, plan?.money, 'errand_result', rest === 0 ? 'filled' : !plan ? 'no_source' : 'partial',
        Diagnostics.enabled(state.characterId) ? { errandAt: errand.at, actual: Number(bought.units || 0), remaining: rest, spent: Number(bought.spent), town: errand.town } : undefined);
    const active = CombinedErrands.pending(bought.state).find(other => CombinedErrands.key(other) === CombinedErrands.key(errand));
    if (!active || Number(active.at) !== Number(errand.at) || Number(active.amount) !== Number(errand.amount)) {
        return { state: bought.state, purchased: bought.units > 0, units: bought.units, reason: 'errand_changed' };
    }
    const after = CombinedErrands.complete(bought.state, errand);
    // Keep a physical partial fill. A quote/funding refusal with no current
    // plan returns to the originating job instead of retaining a stale cap.
    const remainder = { ...errand, amount: rest,
        ...(errand.purpose === 'clan' ? { tag: { ...errand.tag,
            clanPart: Math.max(0, Number(errand.tag?.clanPart || 0) - Number(bought.spent || 0)) } } : {}) };
    const remaining = rest > 0 && plan ? CombinedErrands.enqueue(after, remainder) : after;
    const cleared = { ...remaining, stats: { ...remaining.stats,
        lastErrand: { purpose: errand.purpose, selfId: errand.selfId, units: bought.units, tag: errand.tag || null, at: Date.now() } } };
    const saved = await LifeState.upsertState(cleared, bought.units > 0 ? 'market_errand_bought' : 'market_errand_no_offer');
    if (rest === 0 || !plan) await GoalState.clear(state.characterId, 'completed').catch(() => null);
    return { state: saved || cleared, purchased: bought.units > 0, units: bought.units,
        reason: bought.units > 0 ? 'market_errand_bought' : 'market_errand_no_offer' };
}

const ColdMarketService = {
    tryPurchase(state, goal) {
        if (!state || state.phase === 'hot' || state.activity !== 'shopping') return Promise.resolve({ state, purchased: false, reason: 'not_shopping' });
        const errand = pendingErrand(state);
        if (errand?.town === state.currentRegion) return buyErrand(state);
        if (goal?.type === 'market_errand' && errand) {
            // The errand's town is another one: the bot goes on there.
            return acquire(state, errand.selfId, errand.amount, { money: errand.money ?? Infinity,
                maxPrice: errand.maxPrice ?? Infinity, purpose: errand.purpose, towns: [errand.town],
                ...savedRoute(errand), ...fundingTerms(errand) })
                .then((result) => ({ state: result.state, purchased: result.bought, reason: 'market_errand_town' }));
        }
        const expectedBenefit = goal?.plan?.expectedBenefit;
        const activeGearPurchase = goal?.type === 'upgrade_gear'
            && (!expectedBenefit || ['market_search_for_weapon', 'market_search_for_gear'].includes(expectedBenefit));
        const activeMaterialPurchase = goal?.type === 'buy_craft_material'
            && (!expectedBenefit || expectedBenefit === 'market_buy_craft_material');
        if ((goal?.status && goal.status !== 'active') || (!activeGearPurchase && !activeMaterialPurchase) || !goal.target?.itemId) {
            return Promise.resolve({ state, purchased: false, reason: 'no_purchase_goal' });
        }
        if (activeMaterialPurchase && (!Number.isSafeInteger(Number(goal.target.amount)) || Number(goal.target.amount) <= 0)) {
            return Promise.resolve({ state, purchased: false, reason: 'purchase_quantity_unknown' });
        }
        const acceptedGoal = GoalState.snapshot(state.characterId)?.current;
        const diagnostics = require('./EconomyDiagnostics');
        const diagnosticGoalRevision = diagnostics.enabled(state.characterId) ? GoalState.snapshot(state.characterId)?.updatedAt : null;
        if (acceptedGoal && JSON.stringify(acceptedGoal) !== JSON.stringify(goal)) {
            return Promise.resolve({ state, purchased: false, reason: 'stale_purchase_goal' });
        }
        if (goal.plan?.marketTown && String(goal.plan.marketTown) !== String(state.currentRegion)) {
            if (state.stats?.townVisit && state.stats.townVisit.completed !== true) {
                return Promise.resolve({ state, purchased: false, reason: 'other_town_deferred' });
            }
            const travel = GoalExecutor.beginMarketTravel({ ...state, activity: 'hunting' }, goal);
            if (travel) {
                travel.stats.marketReturn = state.stats?.marketReturn || travel.stats.marketReturn;
                return LifeState.upsertState(travel, 'market_destination_corrected').then((saved) => ({
                    state: saved || state, purchased: false, reason: 'market_destination_corrected'
                }));
            }
            return retryAfterFailedPurchase(state, goal, 'different_market_town');
        }

        const lowTierGearPurchase = activeGearPurchase && Number(state.level || 1) < 40;
        // What the bot may spend (PurchaseFunding.spendable): its wallet above
        // the operating reserve, as the planner priced the purchase. A buy ad's
        // escrow is not in the wallet a shop is paid from.
        const offer = MarketOpportunity.bestOffer(goal.target.itemId, {
            town: state.currentRegion,
            budget: goal.plan?.weaponBridge ? PurchaseFunding.budget(state)
                : PurchaseFunding.spendable(state, 0, { itemId: goal.target.itemId }),
            buyerCharacterId: state.characterId
        });
        if (!offer) {
            const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
            if (BotAfkMarket.canTradeRemotely(state, goal)) {
                return BotAfkMarket.reconcile(state, goal).then((remote) => ({
                    state: remote.state || state,
                    purchased: false,
                    reason: remote.changed ? 'afk_buy_store_opened' : 'afk_buy_store_unchanged',
                    buyStore: remote.shop || null,
                    wanted: true,
                    remoteOffer: null
                }));
            }
            // A stale NG/D goal should be replanned instead of creating a WTB
            // shop. Concrete player and NPC offers are both considered above.
            if (lowTierGearPurchase) return finishBlockedPurchase(state, goal, 'low_tier_offer_missing');
            return BuyStoreService.open(state, goal).catch((error) => {
                utils.infoWarn('BotMarket', 'failed to open buy store for %s: %s', state.name, error?.message || String(error));
                return { opened: false };
            }).then((opened) => {
                if (!opened.opened) {
                    const plazaFull = String(opened.reason || '').startsWith('plaza_full:');
                    return retryAfterFailedPurchase(state, goal, plazaFull ? opened.reason : 'no_affordable_offer');
                }
                MarketTelemetry.noOffer();
                return {
                    state: opened.state,
                    purchased: false,
                    reason: 'buy_store_opened',
                    buyStore: opened.store,
                    wanted: true,
                    remoteOffer: null
                };
            });
        }
        if (activeMaterialPurchase) {
            // NeedsEvaluator has already converted captured stock into the
            // remaining need. Reuse errand execution and its native funding;
            // subtract committed units, never the current bag a second time.
            const terms = { ...fundingTerms(goal.plan), purpose: goal.plan?.purpose || 'supply',
                selfId: Number(goal.target.itemId) };
            const plan = planPurchase(state, terms.selfId, Number(goal.target.amount), {
                ...terms, money: purchaseMoney(state, terms), towns: [state.currentRegion]
            });
            if (!plan) return retryAfterFailedPurchase(state, goal, 'no_affordable_offer');
            const snapshot = GoalState.snapshot(state.characterId);
            return buyHere(state, plan, { goal: { expectedGoal: goal, updatedAt: snapshot?.updatedAt } }).then(async bought => {
                const progress = bought.progressApplied || (bought.units > 0 ? await GoalState.applyPurchase(state.characterId, goal, bought.units) : null);
                if (diagnosticGoalRevision !== null) diagnostics.push({ owner: state.characterId,
                    revision: Number(bought.state?.simulation?.revision), goalRevision: diagnosticGoalRevision,
                    trigger: 'purchase_goal', phase: 'purchase_commit', reason: bought.units >= Number(goal.target.amount) ? 'filled' : bought.units > 0 ? 'partial' : 'no_fill',
                    item: Number(goal.target.itemId), need: Number(goal.target.amount), actual: bought.units,
                    remaining: Math.max(0, Number(goal.target.amount) - bought.units), spent: bought.spent, goalApplied: progress ? 1 : 0,
                    town: state.currentRegion, wishKey: goal.plan?.wishKey });
                return { ...bought, purchased: bought.units > 0,
                    reason: bought.units > 0 ? 'market_material_bought' : 'market_material_no_fill' };
            });
        }
        offer.buyerCharacterId = Number(state.characterId);
        offer.equipSlot = Number(goal.target.itemSlot || 0) || undefined;
        const snapshot = GoalState.snapshot(state.characterId);
        const execution = offer.sourceType === 'npc' ? buyHere(state, { selfId: goal.target.itemId, amount: 1,
            town: state.currentRegion, npcPrice: Number(offer.price), lines: [], ...fundingTerms(goal.plan) },
        { goal: { expectedGoal: goal, updatedAt: snapshot?.updatedAt }, autoEquip: true })
            .then(bought => ({ ...bought, purchased: bought.units > 0 })) : buyOffer(state, offer);
        return execution.then((bought) => {
            if (!bought.purchased) {
                return bought.blocked ? finishBlockedPurchase(state, goal, bought.reason) : retryAfterFailedPurchase(state, goal, bought.reason);
            }
            return (bought.progressApplied ? Promise.resolve() : GoalState.applyPurchase(state.characterId, goal, Number(bought.units || 0))).then(() => {
                if (diagnosticGoalRevision !== null) diagnostics.push({ owner: state.characterId,
                    goalRevision: diagnosticGoalRevision, trigger: 'purchase_goal', phase: 'purchase_commit', reason: 'filled',
                    item: Number(goal.target.itemId), need: 1, actual: Number(bought.units || 0), remaining: 0,
                    spent: bought.spent, town: state.currentRegion, source: offer.sourceType,
                    recordId: offer.recordId, lineId: offer.lineId, quote: offer.price, wishKey: goal.plan?.wishKey });
                return bought;
            });
        });
    },
    async finishTownErrands(state) {
        if (!state || state.activity !== 'shopping' || state.phase === 'hot') return state;
        let current = state;
        // A finite snapshot; every purchase replans against current quotes and current wallet.
        for (const errand of CombinedErrands.pending(state, Date.now(), state.currentRegion)) {
            if (LifeState.hotRow(current.characterId)) return LifeState.hotRow(current.characterId);
            if (!CombinedErrands.pending(current).some(other => CombinedErrands.key(other) === CombinedErrands.key(errand)
                && Number(other.at) === Number(errand.at) && Number(other.amount) === Number(errand.amount))) continue;
            const next = await buyErrand(CombinedErrands.withPending(current, [errand,
                ...CombinedErrands.pending(current).filter(other => CombinedErrands.key(other) !== CombinedErrands.key(errand))]), { skipNpc: true });
            current = next?.state || current;
            if (next?.reason === 'bot_went_hot') return current;
        }
        const plan = ShotStock.planForState(current);
        const localPrices = staticOffers(plan.selfId).filter(offer => offer.town === current.currentRegion);
        const unitPrice = localPrices.length ? Math.min(...localPrices.map(offer => Number(offer.price))) : 0;
        const restock = ShotStock.restockPlan(current, { plan, unitPrice });
        if (restock.needed && restock.amount > 0) {
            const purchase = planPurchase(current, plan.selfId, restock.targetAmount - restock.currentAmount, {
                towns: [current.currentRegion], money: restock.cost, purpose: 'shots'
            });
            if (purchase) {
                const bought = await buyHere(current, purchase, { skipNpc: true });
                current = bought.state;
                if (bought.hot) return current;
            }
        }
        // Board deals remain at their own owner. Their current NPC remainders,
        // healing kit and escape scrolls share the exact real seller basket.
        const extras = [];
        for (const errand of CombinedErrands.pending(current, Date.now(), current.currentRegion)) {
            const route = savedRoute(errand);
            if (route.npc === false) continue;
            const offer = require('./NpcRestockPlan').quoteFor(errand.selfId, current.currentRegion);
            if (!offer || errand.maxPrice !== null && errand.maxPrice !== undefined && offer.price > errand.maxPrice) continue;
            extras.push({ selfId: errand.selfId, amount: errand.amount, offer, errand,
                goal: goalForErrand(current, errand), money: errand.money,
                funding: purchaseTerms(current, { ...errand, npcPrice: offer.price }) });
        }
        const bought = await require('./NpcRestockPlan').purchase(current, { town: current.currentRegion, extras });
        current = bought.state;
        if (LifeState.hotRow(current.characterId)) return current;
        return { ...current, stats: { ...current.stats,
            // ARCH-NOTE: the completed cold visit uses the same clock as the hot town event.
            visitEvery: require('./TownVisitInterval').arrived(current.stats),
            townVisit: current.stats?.townVisit ? { ...current.stats.townVisit, completed: true } : null } };
    },
    buyOffer,
    tripFrom,
    planPurchase,
    buyHere,
    acquire,
    acquireMaterials,
    errandGoal,
    pendingErrand
};

ColdMarketService.RETRY_DELAY_MS = RETRY_DELAY_MS;
ColdMarketService.ERRAND_MS = ERRAND_MS;
module.exports = ColdMarketService;
