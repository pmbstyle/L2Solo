const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');

const ColdMarketService = {
    tryPurchase(state, goal) {
        if (!state || state.phase === 'hot' || state.activity !== 'shopping') return Promise.resolve({ state, purchased: false, reason: 'not_shopping' });
        if (goal?.type !== 'upgrade_gear' || !goal.target?.itemId) return Promise.resolve({ state, purchased: false, reason: 'no_purchase_goal' });

        const offer = MarketOpportunity.bestOffer(goal.target.itemId, {
            town: state.currentRegion,
            budget: state.adena
        });
        if (!offer) return Promise.resolve({ state, purchased: false, reason: 'no_affordable_offer' });
        if (!MarketOpportunity.reserve(offer, 1)) return Promise.resolve({ state, purchased: false, reason: 'offer_changed' });

        return LifeState.applyMarketPurchase(state, offer).then((updated) => {
            if (!updated) {
                MarketOpportunity.release(offer, 1);
                return { state, purchased: false, reason: 'persist_failed' };
            }
            return GoalState.clear(state.characterId, 'completed').then(() => ({
                state: updated,
                purchased: true,
                offer
            }));
        }).catch((err) => {
            MarketOpportunity.release(offer, 1);
            utils.infoWarn('BotMarket', 'cold purchase failed for %s: %s', state.name, err.message);
            return { state, purchased: false, reason: 'purchase_failed' };
        });
    }
};

module.exports = ColdMarketService;
