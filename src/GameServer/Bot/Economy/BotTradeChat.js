const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const AfkTradeChatSelection = invoke('GameServer/Bot/Economy/AfkTradeChatSelection');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');

const HISTORY_LIMIT = 2048;
const AFK_RECHECK_MS = 30000;
const history = new Map();
const lastItemAt = new Map();
const lastTownAt = new Map();
let nextGlobalAt = 0;
let nextFlushAt = 0;
let nextAfkScanAt = 0;
let afkAdsSent = 0;

function id(source) { return Number(source?.actor?.fetchId?.() || source?.characterId || 0); }
function price(value) {
    const amount = Math.round(Number(value));
    if (!Number.isSafeInteger(amount) || amount <= 0) return '';
    if (amount < 1000) return `${amount} adena`;
    const unit = amount >= 1000000 ? 1000000 : 1000;
    const rounded = Math.round(amount / unit * 10) / 10;
    if (unit === 1000 && rounded >= 1000) return '1kk';
    return `${rounded}${unit === 1000000 ? 'kk' : 'k'}`;
}

function players() {
    return (invoke('GameServer/World/World').user?.sessions || []).filter(session =>
        session.accountId && !String(session.accountId).startsWith('bot_') &&
        session.socket && typeof session.socket.write === 'function' && session.actor?.fetchIsOnline?.() !== false);
}

function label(item) {
    const readable = name => name && !/[{}_]/.test(name) && !/^(?:Item|Material)\s+\d+$/i.test(name);
    const name = readable(item.name) ? item.name : ItemTemplateIndex.find(invoke('GameServer/DataCache').items, item.selfId)?.template?.name;
    if (!readable(name)) return '';
    return `${Number(item.enchant || 0) > 0 ? `+${Number(item.enchant)} ` : ''}${String(name).replace(/\s+/g, ' ').trim()}`;
}

function offerText(store, source = {}) {
    if (!store) return '';
    const side = Number(store.storeType || 1) === 3 ? 'buy' : 'sell';
    const rawTown = store.town || source.currentRegion || '';
    const town = rawTown && !/[{}_]|\d/.test(rawTown) ? String(rawTown).slice(0, 30) : 'town';
    const templates = Speech.voices[`trade.${side}`];
    const overhead = Math.max(...templates.map(([, text]) => text.length - '{goods}'.length - '{town}'.length));
    const available = 120 - town.length - overhead;
    const lines = [];
    for (const item of store.items || []) {
        if (Number(item.count) <= 0) continue;
        const name = label(item), cost = price(item.price);
        if (!name || !cost) continue;
        const displayed = parseFloat(cost) * (cost.endsWith('kk') ? 1000000 : cost.endsWith('k') ? 1000 : 1);
        const suffix = ` - ${displayed !== Number(item.price) ? '~' : ''}${cost} each`;
        const full = `${name}${suffix}`;
        if (lines.length && [...lines, full].join(', ').length > available) break;
        const room = available - suffix.length;
        if (room < 8) continue;
        lines.push(full.length <= available ? full : `${name.slice(0, room - 3).trimEnd()}...${suffix}`);
        if (lines.length >= 2) break;
    }
    if (!lines.length) return '';
    return Voice.line(`trade.${side}`, source, { goods: lines.join(', '), town });
}

function afkOfferText(shop, line) {
    const name = label(line);
    if (!name) return '';
    const side = Number(shop.storeType) === 3 ? 'WTB' : 'WTS';
    const town = String(shop.town || 'town').replace(/[{}_]/g, '').slice(0, 30);
    const suffix = ` x${Number(line.count)} — ${Number(line.price).toLocaleString('en-US')} Adena ea, ${town}. PM me.`;
    const room = 120 - side.length - 1 - suffix.length;
    if (room < 8) return '';
    return `${side} ${name.length > room ? `${name.slice(0, room - 3).trimEnd()}...` : name}${suffix}`;
}

function ready(source, now = Date.now()) {
    return Config.marketTradeChatEnabled !== false && !Identity.isStaticService(source) && id(source) > 0 &&
        now >= nextGlobalAt && now - (history.get(id(source))?.at ?? -Infinity) >= Config.marketTradeChatIntervalMs;
}

function deliver(source, text, now = Date.now()) {
    if (!text || !ready(source, now)) return false;
    const audience = players();
    if (!audience.length) return false;
    const actor = source.actor || { fetchId: () => id(source), fetchName: () => source.name || 'Bot' };
    const packet = invoke('GameServer/Network/Response').speak(actor, { kind: 8, text: text.slice(0, 120) });
    let sent = false;
    for (const session of audience) {
        try { session.dataSendToMe(packet); sent = true; }
        catch (error) { utils.infoWarn('BotTradeChat', 'delivery failed: %s', error.message); }
    }
    if (!sent) return false;
    if (!history.has(id(source)) && history.size >= HISTORY_LIMIT) history.delete(history.keys().next().value);
    history.set(id(source), { at: now, text });
    nextGlobalAt = now + Config.marketTradeChatGlobalMinIntervalMs;
    return true;
}

function announceAfk(now) {
    if (now < nextAfkScanAt) return false;
    nextAfkScanAt = now + AFK_RECHECK_MS;
    const shops = invoke('GameServer/AfkTrade/AfkTradeService').activeShops();
    const preferredSide = afkAdsSent % 3 === 2 ? 3 : 1;
    const candidate = AfkTradeChatSelection.choose(shops, {
        now, lastItemAt, lastOwnerAt: history, lastTownAt, preferredSide
    });
    if (!candidate) return false;
    const { shop, line, type } = candidate;
    const source = { characterId: Number(shop.ownerId), name: shop.ownerName || 'Bot', afkTradeAd: true };
    const text = afkOfferText(shop, line);
    if (!deliver(source, text, now)) return false;
    const key = AfkTradeChatSelection.itemKey(type, line);
    if (!lastItemAt.has(key) && lastItemAt.size >= HISTORY_LIMIT) lastItemAt.delete(lastItemAt.keys().next().value);
    lastItemAt.set(key, now);
    lastTownAt.set(String(shop.town), now);
    afkAdsSent += 1;
    return true;
}

// The board's records are announced in the global chat budget. Inspect them
// only when a message slot opens, never on every bot tick.
function flush(now = Date.now()) {
    if (now < nextFlushAt) return;
    nextFlushAt = now + 1000;
    if (Config.marketTradeChatEnabled === false) return;
    if (now < nextGlobalAt) return;
    if (!players().length) return;
    announceAfk(now);
}

function safe(fn) {
    return (...args) => {
        try { return fn(...args); }
        catch (error) { utils.infoWarn('BotTradeChat', 'ad skipped: %s', error.message); return { announced: false, reason: 'ad_error' }; }
    };
}

module.exports = { price, offerText, ready, deliver, flush: safe(flush),
    snapshot: () => ({ history: history.size, afkItemHistory: lastItemAt.size }),
    reset() { history.clear(); lastItemAt.clear(); lastTownAt.clear();
        nextGlobalAt = 0; nextFlushAt = 0;
        nextAfkScanAt = 0;
        afkAdsSent = 0; } };
