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
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');

const RETRY_DELAY_MS = 15 * 60 * 1000;
// A bound on an errand the bot has not carried out (no route, a party that
// keeps it): after it the job that sent it plans again.
const ERRAND_MS = 30 * 60 * 1000;

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
        GoalState.clear(state.characterId, 'completed').then(() => ({
            state: saved || returning,
            purchased: false,
            reason,
            remoteOffer: null
        }))
    ));
}

// Buys `options.qty` (one by default) of a found offer for a cold bot: a
// board record through AfkTradeService (one deal transaction), otherwise an
// NPC or a configured city merchant. No goal or travel change; an NPC
// purchase records the bot as shopping unless options.keepActivity (a
// purchase made for it where it hunts).
function buyOffer(state, offer, options = {}) {
    if (!MarketOpportunity.botCanBuy(offer)) return Promise.resolve({ purchased: false, blocked: true, reason: 'configured_supply_retired' });
    const qty = Math.max(1, Math.floor(Number(options.qty) || 1));
    const blocker = LifeState.marketPurchaseBlocker(state, offer, qty);
    if (blocker) return Promise.resolve({ purchased: false, blocked: true, reason: blocker });
    if (['afk_player_store', 'afk_bot_store'].includes(offer.sourceType)) {
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        return AfkTrade.buyFromShop(
            state.characterId,
            offer.store,
            offer.selfId,
            qty,
            { lineId: offer.lineId, expectedPrice: offer.price, coldState: state, autoEquip: options.autoEquip }
        ).then((trade) => {
            const done = AfkTrade.committedTrade(trade, state.characterId);
            if (!done.committed) throw new Error('cold_state_sync_failed');
            // Native commit includes the buyer's experience exactly once.
            const buyer = done.state || state;
            MarketTelemetry.purchase(offer, qty, {
                buyerCharacterId: buyer.characterId,
                buyerName: buyer.name,
                town: buyer.currentRegion
            });
            return { state: buyer, purchased: true, offer, sellerState: null };
        }).catch((error) => {
            utils.infoWarn('BotMarket', 'AFK market purchase failed for %s: %s', state.name, error.message);
            return { purchased: false, reason: 'offer_changed' };
        });
    }
    if (!MarketOpportunity.reserve(offer, qty)) return Promise.resolve({ purchased: false, reason: 'offer_changed' });
    return LifeState.applyMarketPurchase(state, offer, qty, options).then((updated) => {
        if (!updated) {
            MarketOpportunity.release(offer, qty);
            return { purchased: false, reason: 'persist_failed' };
        }
        MarketTelemetry.purchase(offer, qty, {
            buyerCharacterId: updated.characterId,
            buyerName: updated.name,
            town: updated.currentRegion
        });
        return { state: updated, purchased: true, offer, sellerState: null };
    }).catch((err) => {
        MarketOpportunity.release(offer, qty);
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

// The one purchase path of a cold bot (б5, D1, user 2026-10-05): every
// board purchase is a trip to the seller's town. planPurchase picks the town
// (OfferQuery.cheapestTown over the board and the NPC shops, the bot's round
// trip included; none to the town it is shopping in); acquire buys there at
// once when the bot stands in it, else leaves it an errand and starts the
// author's market trip (GoalExecutor.beginMarketTravel); on arrival
// tryPurchase buys the errand (buyHere). One trip per purchase.
function planPurchase(state, selfId, amount, { money = Infinity, maxPrice = Infinity, npc = true, towns = null,
    timestamp = Date.now(), cost = null } = {}) {
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const plan = OfferQuery.cheapestTown(AfkTrade.boardIndex(), selfId, {
        amount, money, maxPrice, towns, excludeOwner: state?.characterId,
        npcOffers: npc ? staticOffers(selfId) : [],
        cost: cost || tripFrom(state, timestamp)
    });
    return plan ? { ...plan, selfId: Number(selfId), amount: Number(amount), money } : null;
}

// Buys a plan in the town the bot stands in: each board line one deal, then
// the NPC for the rest (also the units of a line that changed meanwhile),
// within the plan's money. Returns { state, units, spent, hot }.
async function buyHere(state, plan) {
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    let current = state;
    let units = 0;
    let spent = 0;
    for (const entry of plan.lines || []) {
        const offer = AfkTrade.offerOf(entry.line, plan.town);
        if (!offer || Number(offer.price) !== Number(entry.price)) continue;
        const bought = await buyOffer(current, offer, { qty: entry.count, autoEquip: false });
        if (!bought.purchased) continue;
        if (LifeState.hotRow(current.characterId)) return { state: current, units: units + entry.count, spent, hot: true };
        current = bought.state;
        units += entry.count;
        spent += entry.count * entry.price;
    }
    // A saved plan may predate group F or a rate change. Only a current
    // NPC/shot-table quote in this town can supply its remainder.
    const quotedPrice = Number(plan.npcPrice || 0);
    const npcPrice = staticOffers(plan.selfId).some((offer) => offer.town === plan.town
        && Number(offer.price) === quotedPrice) ? quotedPrice : 0;
    const money = Math.min(Number.isFinite(plan.money) ? plan.money - spent : Infinity, Number(current.adena || 0));
    const rest = npcPrice > 0 ? Math.max(0, Math.min(plan.amount - units, Math.floor(money / npcPrice))) : 0;
    if (rest > 0) {
        const bought = await buyNpcStack(current, plan.selfId, rest, npcPrice);
        if (bought) {
            current = bought;
            units += rest;
            spent += rest * npcPrice;
        }
    }
    return { state: current, units, spent, hot: false };
}

// The NPC part of a stack purchase, the author's fenced cold write
// (Database.purchaseNpcInventoryItem, as his cold shot restock made it): the
// bag and the wallet in one transaction, the cold state following. null when
// refused.
async function buyNpcStack(state, selfId, amount, unitPrice) {
    const Database = invoke('Database');
    const name = ItemTemplateIndex.find(invoke('GameServer/DataCache').items, Number(selfId))?.template?.name || `Item ${selfId}`;
    const purchase = await Database.purchaseNpcInventoryItem(state.characterId, { selfId, name, amount, unitPrice, coldState: state });
    if (!purchase?.ok) return null;
    MarketTelemetry.purchase({ sourceType: 'npc', selfId, price: unitPrice }, amount, {
        buyerCharacterId: state.characterId, buyerName: state.name, town: state.currentRegion
    });
    if (purchase.coldLifeRow) return LifeState.acceptLifecycleRow(purchase.coldLifeRow);
    const balance = Math.max(0, Number(state.adena || 0) - Number(purchase.spent ?? amount * unitPrice));
    const paid = { ...state, adena: balance, inventory: { ...(state.inventory || {}),
        57: { ...(state.inventory?.['57'] || {}), selfId: 57, amount: balance } } };
    const refreshed = await LifeState.refreshInventory(paid) || paid;
    return await LifeState.upsertState(refreshed, 'market_npc_stack') || refreshed;
}

// The bot's errand while it still stands (ERRAND_MS), else null.
function pendingErrand(state, timestamp = Date.now()) {
    const errand = state?.stats?.marketErrand;
    return errand && timestamp - Number(errand.at || 0) < ERRAND_MS ? errand : null;
}

function errandGoal(errand) {
    return { type: 'market_errand', status: 'active', target: { itemId: errand.selfId, amount: errand.amount },
        plan: { expectedBenefit: 'market_errand', marketTown: errand.town, purpose: errand.purpose } };
}

// A cold bot needs `amount` of an item for `purpose` (a shot restock, a
// crafter's input, a clan order...): it buys where it stands when that town
// is the cheapest with the trip, else it keeps an errand and goes there.
// Returns { state, bought, units, traveling, plan }; `persist` false leaves
// the state unsaved (a caller that saves it). A bot in a party keeps the
// errand: its party's market break takes it there (NeedsEvaluator).
async function acquire(state, selfId, amount, options = {}) {
    const plan = planPurchase(state, selfId, amount, options);
    if (!plan) return { state, bought: false, units: 0, traveling: false, plan: null };
    if (state.activity === 'shopping' && plan.town === state.currentRegion) {
        const bought = await buyHere(state, plan);
        return { state: bought.state, bought: bought.units > 0, units: bought.units, traveling: false, plan, hot: bought.hot };
    }
    const errand = { selfId: Number(selfId), amount: Number(amount), town: plan.town, money: Number.isFinite(plan.money) ? plan.money : null,
        maxPrice: Number.isFinite(options.maxPrice) ? options.maxPrice : null, purpose: options.purpose || 'supply',
        tag: options.tag || null, at: Number(options.timestamp || Date.now()) };
    const withErrand = { ...state, stats: { ...(state.stats || {}), marketErrand: errand } };
    const from = state.activity === 'shopping' ? { ...withErrand, activity: 'hunting' } : withErrand;
    const travel = state.party?.partyId || state.partyId ? null : GoalExecutor.beginMarketTravel(from, errandGoal(errand));
    if (travel && state.activity === 'shopping') travel.stats.marketReturn = state.stats?.marketReturn || travel.stats.marketReturn;
    const next = travel || withErrand;
    if (options.persist === false) return { state: next, bought: false, units: 0, traveling: !!travel, plan };
    const saved = await LifeState.upsertState(next, travel ? `market_errand_${errand.purpose}` : 'market_errand_kept');
    return { state: saved || next, bought: false, units: 0, traveling: !!travel && !!saved, plan };
}

// On arrival: the errand of the town the bot stands in, bought there (the
// plan made again for this town, as the board stands now); what it bought
// stays as stats.lastErrand for the job that sent it (a clan's order).
// Returns null without one, or when it lapsed (ERRAND_MS: the job that sent
// it plans again).
async function buyErrand(state) {
    const errand = pendingErrand(state);
    if (!errand || state.activity !== 'shopping' || errand.town !== state.currentRegion) return null;
    const plan = planPurchase(state, errand.selfId, errand.amount, { towns: [errand.town],
        money: errand.money ?? Infinity, maxPrice: errand.maxPrice ?? Infinity });
    const bought = plan ? await buyHere(state, plan) : { state, units: 0, hot: false };
    if (bought.hot) return { state: bought.state, purchased: bought.units > 0, reason: 'bot_went_hot' };
    const cleared = { ...bought.state, stats: { ...(bought.state.stats || {}), marketErrand: null,
        lastErrand: { purpose: errand.purpose, selfId: errand.selfId, units: bought.units, tag: errand.tag || null, at: Date.now() } } };
    const saved = await LifeState.upsertState(cleared, bought.units > 0 ? 'market_errand_bought' : 'market_errand_no_offer');
    await GoalState.clear(state.characterId, 'completed').catch(() => null);
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
                maxPrice: errand.maxPrice ?? Infinity, purpose: errand.purpose, tag: errand.tag, towns: [errand.town] })
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
        if (goal.plan?.marketTown && String(goal.plan.marketTown) !== String(state.currentRegion)) {
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
            budget: PurchaseFunding.spendable(state),
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
        offer.buyerCharacterId = Number(state.characterId);
        offer.equipSlot = Number(goal.target.itemSlot || 0) || undefined;
        return buyOffer(state, offer).then((bought) => {
            if (!bought.purchased) {
                return bought.blocked ? finishBlockedPurchase(state, goal, bought.reason) : retryAfterFailedPurchase(state, goal, bought.reason);
            }
            return GoalState.clear(state.characterId, 'completed').then(() => bought);
        });
    },
    buyOffer,
    tripFrom,
    planPurchase,
    buyHere,
    acquire,
    errandGoal,
    pendingErrand
};

ColdMarketService.RETRY_DELAY_MS = RETRY_DELAY_MS;
ColdMarketService.ERRAND_MS = ERRAND_MS;
module.exports = ColdMarketService;
