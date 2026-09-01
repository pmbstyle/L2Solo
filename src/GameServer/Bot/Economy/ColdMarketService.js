const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');

const RETRY_DELAY_MS = 15 * 60 * 1000;

function retryAfterFailedPurchase(state, goal, reason) {
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
            return Promise.resolve({ state, purchased: false, reason: 'different_market_town' });
        }

        const lowTierGearPurchase = activeGearPurchase && Number(state.level || 1) < 40;
        const offer = MarketOpportunity.bestOffer(goal.target.itemId, {
            town: state.currentRegion,
            budget: state.adena,
            buyerCharacterId: state.characterId
        });
        if (!offer) {
            // A stale NG/D goal should be replanned instead of creating a WTB
            // shop. Concrete player and NPC offers are both considered above.
            if (lowTierGearPurchase) return finishBlockedPurchase(state, goal, 'low_tier_offer_missing');
            return BuyStoreService.open(state, goal).catch((error) => {
                utils.infoWarn('BotMarket', 'failed to open buy store for %s: %s', state.name, error?.message || String(error));
                return { opened: false };
            }).then((opened) => {
                if (!opened.opened) return retryAfterFailedPurchase(state, goal, 'no_affordable_offer');
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
        const blocker = LifeState.marketPurchaseBlocker(state, offer, 1);
        if (blocker) return finishBlockedPurchase(state, goal, blocker);
        if (offer.sourceType === 'afk_player_store') {
            return invoke('GameServer/AfkTrade/AfkTradeService').buyFromShop(
                state.characterId,
                offer.store,
                offer.selfId,
                1,
                { expectedPrice: offer.price, coldState: state }
            ).then((trade) => {
                if (!trade.coldState) throw new Error('cold_state_sync_failed');
                MarketTelemetry.purchase(offer, 1, {
                    buyerCharacterId: trade.coldState.characterId,
                    buyerName: trade.coldState.name,
                    town: trade.coldState.currentRegion
                });
                return GoalState.clear(state.characterId, 'completed').then(() => ({
                    state: trade.coldState,
                    purchased: true,
                    offer,
                    sellerState: null
                }));
            }).catch((error) => {
                utils.infoWarn('BotMarket', 'AFK market purchase failed for %s: %s', state.name, error.message);
                return retryAfterFailedPurchase(state, goal, 'offer_changed');
            });
        }
        if (!MarketOpportunity.reserve(offer, 1)) return retryAfterFailedPurchase(state, goal, 'offer_changed');

        return LifeState.applyMarketPurchase(state, offer).then((updated) => {
            if (!updated) {
                MarketOpportunity.release(offer, 1);
                return retryAfterFailedPurchase(state, goal, 'persist_failed');
            }
            const settlement = offer.sourceType === 'cold_store' ? ListingService.settle(offer, 1) : Promise.resolve(null);
            return settlement.then((sellerState) => {
                MarketTelemetry.purchase(offer, 1, {
                    buyerCharacterId: updated.characterId,
                    buyerName: updated.name,
                    town: updated.currentRegion
                });
                return GoalState.clear(state.characterId, 'completed').then(() => ({
                state: updated,
                purchased: true,
                offer,
                sellerState
                }));
            });
        }).catch((err) => {
            MarketOpportunity.release(offer, 1);
            utils.infoWarn('BotMarket', 'cold purchase failed for %s: %s', state.name, err.message);
            return retryAfterFailedPurchase(state, goal, 'purchase_failed');
        });
    }
};

ColdMarketService.RETRY_DELAY_MS = RETRY_DELAY_MS;
module.exports = ColdMarketService;
