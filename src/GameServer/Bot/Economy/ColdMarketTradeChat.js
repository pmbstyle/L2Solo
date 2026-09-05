const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeChat = invoke('GameServer/Bot/Economy/BotTradeChat');

function offerText(store) { return TradeChat.offerText(store); }

function wantedText(state, goal) {
    const item = goal?.target?.itemName || `Item ${goal?.target?.itemId || ''}`.trim();
    if (!goal?.target?.itemId) return '';
    return `WTB ${item} — ${state.currentRegion || 'Giran'}.`.slice(0, 120);
}

function maybeAnnounceWanted(state, goal, timestamp = Date.now()) {
    const wanted = state?.stats?.marketWanted || {};
    if (Config.marketTradeChatEnabled === false || state?.activity !== 'shopping' || !goal?.target?.itemId) return { state, announced: false, reason: 'not_waiting_for_gear' };
    if (Number(wanted.lastTradeAdAt || 0) + Config.marketTradeChatIntervalMs > timestamp) return { state, announced: false, reason: 'cooldown' };
    if (!TradeChat.ready(state, timestamp)) return { state, announced: false, reason: 'global_cooldown' };
    const text = wantedText(state, goal);
    if (!TradeChat.deliver(state, text, timestamp)) return { state, announced: false, reason: 'no_audience' };
    return { state: { ...state, stats: { ...(state.stats || {}), marketWanted: { itemId: goal.target.itemId, itemName: goal.target.itemName, lastTradeAdAt: timestamp } } }, announced: true, text };
}

function announceRemoteOffer(offer) {
    if (offer?.sourceType !== 'cold_store' || !offer.sellerState) return false;
    const text = TradeChat.offerText({ storeType: 1, town: offer.town, items: [
        { selfId: offer.selfId, name: offer.itemName, price: offer.price, count: 1 }
    ] }, offer.sellerState);
    return TradeChat.deliver(offer.sellerState, text);
}

function maybeAnnounce(state, timestamp = Date.now()) {
    const result = TradeChat.offer(state, timestamp);
    if (!result.announced) return Promise.resolve({ state, ...result });
    const store = state.stats.marketStore;
    const text = result.text;

    const nextState = {
        ...state,
        stats: {
            ...(state.stats || {}),
            marketStore: { ...store, lastTradeAdAt: timestamp }
        }
    };
    return LifeState.upsertState(nextState, 'cold_market_trade_ad').then((saved) => {
        const persisted = saved || nextState;
        MarketOpportunity.indexColdStore(persisted);
        console.info('BotMarket :: %s trade ad: %s', state.name || 'Bot', text);
        return { state: persisted, announced: true, text };
    });
}

function reset() {
    TradeChat.reset();
}

module.exports = { maybeAnnounce, maybeAnnounceWanted, announceRemoteOffer, offerText, wantedText, reset };
