const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');

const RETRY_DELAY_MS = 15 * 60 * 1000;

function retryAfterFailedPurchase(state, goal, reason) {
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
            // A wanted ad is not a reason to idle in Giran.  Keep the demand
            // and retry window, then return to the material route until the
            // next market attempt is due.
            return retryAfterFailedPurchase(state, goal, 'no_affordable_offer');
        }
        if (!MarketOpportunity.reserve(offer, 1)) return retryAfterFailedPurchase(state, goal, 'offer_changed');
        offer.buyerCharacterId = Number(state.characterId);

        return LifeState.applyMarketPurchase(state, offer).then((updated) => {
            if (!updated) {
                MarketOpportunity.release(offer, 1);
                return retryAfterFailedPurchase(state, goal, 'persist_failed');
            }
            const settlement = offer.sourceType === 'cold_store' ? ListingService.settle(offer, 1) : Promise.resolve(null);
            return settlement.then((sellerState) => GoalState.clear(state.characterId, 'completed').then(() => ({
                state: updated,
                purchased: true,
                offer,
                sellerState
            })));
        }).catch((err) => {
            MarketOpportunity.release(offer, 1);
            utils.infoWarn('BotMarket', 'cold purchase failed for %s: %s', state.name, err.message);
            return retryAfterFailedPurchase(state, goal, 'purchase_failed');
        });
    }
};

ColdMarketService.RETRY_DELAY_MS = RETRY_DELAY_MS;
module.exports = ColdMarketService;
