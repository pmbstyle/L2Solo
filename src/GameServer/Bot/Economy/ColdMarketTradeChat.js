const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ServerResponse = invoke('GameServer/Network/Response');

let lastGlobalAdAt = 0;

function coldActor(state) {
    return {
        fetchId: () => Number(state?.characterId || 0),
        fetchName: () => state?.name || 'Bot'
    };
}

function realPlayerSessions() {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).filter((session) => (
        session.socket &&
        typeof session.socket.write === 'function' &&
        session.accountId &&
        !String(session.accountId).startsWith('bot_')
    ));
}

function offerText(store) {
    const names = (store.items || [])
        .filter((item) => Number(item.count) > 0)
        .slice(0, 3)
        .map((item) => item.name || `Item ${item.selfId}`);
    if (!names.length) return '';
    return `WTS ${names.join(', ')}. Sitting in ${store.town || 'town'}.`;
}

function wantedText(state, goal) {
    const item = goal?.target?.itemName || `Item ${goal?.target?.itemId || ''}`.trim();
    if (!goal?.target?.itemId) return '';
    return `WTB ${item} — ${state.currentRegion || 'Giran'}.`.slice(0, 120);
}

function maybeAnnounceWanted(state, goal, timestamp = Date.now()) {
    const wanted = state?.stats?.marketWanted || {};
    if (Config.marketTradeChatEnabled === false || state?.activity !== 'shopping' || !goal?.target?.itemId) return { state, announced: false, reason: 'not_waiting_for_gear' };
    if (Number(wanted.lastTradeAdAt || 0) + Config.marketTradeChatIntervalMs > timestamp) return { state, announced: false, reason: 'cooldown' };
    if (lastGlobalAdAt > 0 && timestamp - lastGlobalAdAt < Config.marketTradeChatGlobalMinIntervalMs) return { state, announced: false, reason: 'global_cooldown' };
    const text = wantedText(state, goal);
    const players = realPlayerSessions();
    if (!text || !players.length) return { state, announced: false, reason: 'no_audience' };
    const packet = ServerResponse.speak(coldActor(state), { kind: 8, text });
    players.forEach((session) => session.dataSendToMe(packet));
    lastGlobalAdAt = timestamp;
    return { state: { ...state, stats: { ...(state.stats || {}), marketWanted: { itemId: goal.target.itemId, itemName: goal.target.itemName, lastTradeAdAt: timestamp } } }, announced: true, text };
}

function announceRemoteOffer(offer) {
    if (offer?.sourceType !== 'cold_store' || !offer.sellerState) return false;
    const players = realPlayerSessions();
    if (!players.length) return false;
    const text = `WTS ${offer.itemName} in ${offer.town || 'town'} for ${offer.price}.`.slice(0, 120);
    const packet = ServerResponse.speak(coldActor(offer.sellerState), { kind: 8, text });
    players.forEach((session) => session.dataSendToMe(packet));
    console.info('BotMarket :: %s answered WTB: %s', offer.sourceName, text);
    return true;
}

function maybeAnnounce(state, timestamp = Date.now()) {
    const store = state?.stats?.marketStore;
    if (Config.marketTradeChatEnabled === false || state?.activity !== 'merchant' || !store) {
        return Promise.resolve({ state, announced: false, reason: 'not_merchant' });
    }
    const lastTradeAdAt = Number(store.lastTradeAdAt || 0);
    if (Number(store.expiresAt || 0) <= timestamp || (lastTradeAdAt > 0 && lastTradeAdAt + Config.marketTradeChatIntervalMs > timestamp)) {
        return Promise.resolve({ state, announced: false, reason: 'cooldown' });
    }
    if (lastGlobalAdAt > 0 && timestamp - lastGlobalAdAt < Config.marketTradeChatGlobalMinIntervalMs) {
        return Promise.resolve({ state, announced: false, reason: 'global_cooldown' });
    }

    const text = offerText(store).slice(0, 120);
    const players = realPlayerSessions();
    if (!text || !players.length) return Promise.resolve({ state, announced: false, reason: 'no_audience' });

    const packet = ServerResponse.speak(coldActor(state), { kind: 8, text });
    players.forEach((session) => session.dataSendToMe(packet));
    lastGlobalAdAt = timestamp;

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
    lastGlobalAdAt = 0;
}

module.exports = { maybeAnnounce, maybeAnnounceWanted, announceRemoteOffer, offerText, wantedText, reset };
