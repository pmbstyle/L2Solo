const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');

const RETRY_DELAY_MS = 15 * 60 * 1000;

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

// Buys one unit of a found offer for a cold bot: a board record through
// AfkTradeService (one deal transaction), otherwise an NPC or a configured
// city merchant. No goal or travel change; an NPC purchase records the bot
// as shopping unless options.keepActivity (a purchase made for it where it
// hunts).
function buyOffer(state, offer, options = {}) {
    const blocker = LifeState.marketPurchaseBlocker(state, offer, 1);
    if (blocker) return Promise.resolve({ purchased: false, blocked: true, reason: blocker });
    if (['afk_player_store', 'afk_bot_store'].includes(offer.sourceType)) {
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        return AfkTrade.buyFromShop(
            state.characterId,
            offer.store,
            offer.selfId,
            1,
            { lineId: offer.lineId, expectedPrice: offer.price, coldState: state }
        ).then((trade) => {
            const done = AfkTrade.committedTrade(trade, state.characterId);
            if (!done.committed) throw new Error('cold_state_sync_failed');
            // A buyer that went hot keeps its row: the job goes on with its own state.
            const buyer = done.state || state;
            MarketTelemetry.purchase(offer, 1, {
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
    if (!MarketOpportunity.reserve(offer, 1)) return Promise.resolve({ purchased: false, reason: 'offer_changed' });
    return LifeState.applyMarketPurchase(state, offer, 1, options).then((updated) => {
        if (!updated) {
            MarketOpportunity.release(offer, 1);
            return { purchased: false, reason: 'persist_failed' };
        }
        MarketTelemetry.purchase(offer, 1, {
            buyerCharacterId: updated.characterId,
            buyerName: updated.name,
            town: updated.currentRegion
        });
        return { state: updated, purchased: true, offer, sellerState: null };
    }).catch((err) => {
        MarketOpportunity.release(offer, 1);
        utils.infoWarn('BotMarket', 'cold purchase failed for %s: %s', state.name, err.message);
        return { purchased: false, reason: 'purchase_failed' };
    });
}

const ColdMarketService = {
    tryPurchase(state, goal) {
        if (!state || state.phase === 'hot' || state.activity !== 'shopping') return Promise.resolve({ state, purchased: false, reason: 'not_shopping' });
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
    buyOffer
};

ColdMarketService.RETRY_DELAY_MS = RETRY_DELAY_MS;
module.exports = ColdMarketService;
