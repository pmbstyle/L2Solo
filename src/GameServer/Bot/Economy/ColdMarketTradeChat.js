const Config = invoke('GameServer/Bot/Population/PopulationConfig');
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

function reset() {
    TradeChat.reset();
}

module.exports = { maybeAnnounceWanted, offerText, wantedText, reset };
