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

const ColdMarketService = {
    tryPurchase(state, goal) {
        if (!state || state.phase === 'hot' || state.activity !== 'shopping') return Promise.resolve({ state, purchased: false, reason: 'not_shopping' });
        if (!['upgrade_gear', 'buy_craft_material'].includes(goal?.type) || !goal.target?.itemId) return Promise.resolve({ state, purchased: false, reason: 'no_purchase_goal' });

        const offer = MarketOpportunity.bestOffer(goal.target.itemId, {
            town: state.currentRegion,
            budget: state.adena,
            buyerCharacterId: state.characterId
        });
        if (!offer) {
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
        if (!MarketOpportunity.reserve(offer, 1)) return retryAfterFailedPurchase(state, goal, 'offer_changed');
        offer.buyerCharacterId = Number(state.characterId);

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
