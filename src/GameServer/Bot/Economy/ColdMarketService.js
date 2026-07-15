const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const TradeChat = invoke('GameServer/Bot/Economy/ColdMarketTradeChat');

const RETRY_DELAY_MS = 15 * 60 * 1000;

const ColdMarketService = {
    tryPurchase(state, goal) {
        if (!state || state.phase === 'hot' || state.activity !== 'shopping') return Promise.resolve({ state, purchased: false, reason: 'not_shopping' });
        if (goal?.type !== 'upgrade_gear' || !goal.target?.itemId) return Promise.resolve({ state, purchased: false, reason: 'no_purchase_goal' });

        const offer = MarketOpportunity.bestOffer(goal.target.itemId, {
            town: state.currentRegion,
            budget: state.adena,
            buyerCharacterId: state.characterId
        });
        if (!offer) {
            const retryState = {
                ...state,
                stats: { ...(state.stats || {}), marketRetryAfter: Date.now() + RETRY_DELAY_MS,
                    marketWanted: { ...(state.stats?.marketWanted || {}), itemId: goal.target.itemId, itemName: goal.target.itemName, lastMissingAt: Date.now() } }
            };
            const wanted = TradeChat.maybeAnnounceWanted(retryState, goal);
            return LifeState.upsertState(wanted.state, 'market_no_offer').then((saved) => ({
                state: saved || wanted.state,
                purchased: false,
                reason: 'no_affordable_offer', wanted: wanted.announced
            }));
        }
        if (!MarketOpportunity.reserve(offer, 1)) return Promise.resolve({ state, purchased: false, reason: 'offer_changed' });
        offer.buyerCharacterId = Number(state.characterId);

        return LifeState.applyMarketPurchase(state, offer).then((updated) => {
            if (!updated) {
                MarketOpportunity.release(offer, 1);
                return { state, purchased: false, reason: 'persist_failed' };
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
            return { state, purchased: false, reason: 'purchase_failed' };
        });
    }
};

ColdMarketService.RETRY_DELAY_MS = RETRY_DELAY_MS;
module.exports = ColdMarketService;
