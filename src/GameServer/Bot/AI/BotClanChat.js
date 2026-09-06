const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ClanService = invoke('GameServer/Clan/ClanService');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');

const DEATH_WINDOW_MS = 20 * 60000;
const EVENT_COOLDOWN_MS = 10 * 60000;
const QUEUE_TTL_MS = 2 * 60000;
const MAX_CLANS = 64;
const MAX_PENDING = 12;
const HISTORY_LIMIT = 4096;
const queues = new Map();
const history = new Map();
const deaths = new Map();
let nextFlushAt = 0;
let itemSource = null;
let itemNames = new Map();

function id(source) { return Number(source?.actor?.fetchId?.() || source?.characterId || 0); }
function boundedSet(map, key, value, limit = HISTORY_LIMIT) {
    if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, value);
}

// Only inspect clans with real listeners. The clan cache is authoritative for
// cold membership; life-state stats can still contain a former clan id.
function audience(source, expectedClanId = 0) {
    const World = invoke('GameServer/World/World');
    const checked = new Map();
    return (World.user?.sessions || []).filter(session => {
        if (!session.accountId || String(session.accountId).startsWith('bot_') ||
            !session.socket || typeof session.socket.write !== 'function' || session.actor?.fetchIsOnline?.() === false) return false;
        const clanId = Number(session.actor?.fetchClanId?.() || 0);
        if (!clanId || expectedClanId && clanId !== expectedClanId) return false;
        if (source.actor) return Number(source.actor.fetchClanId?.() || 0) === clanId;
        if (!checked.has(clanId)) checked.set(clanId,
            ClanService.findById(clanId)?.members?.some(member => Number(member.id) === id(source)) || false);
        return checked.get(clanId);
    });
}

function itemName(itemId, supplied) {
    const DataCache = invoke('GameServer/DataCache');
    if (itemSource !== DataCache.items) {
        itemSource = DataCache.items;
        itemNames = new Map((itemSource || []).map(item => [Number(item.selfId), utils.crushOb(item).name]));
    }
    const name = itemNames.get(Number(itemId)) || supplied;
    if (!name || /^(?:Material|Item)\s+\d+$/i.test(name) || /[{}_]/.test(name)) return '';
    return String(name).replace(/\s+/g, ' ').trim();
}

function goalKey(goal) {
    if (goal?.status !== 'active') return '';
    switch (goal.type) {
        case 'upgrade_gear': case 'buy_craft_material': return `${goal.type}:${goal.target?.itemId || goal.target?.itemName || ''}`;
        case 'progress_level': return `${goal.type}:${goal.target?.level || ''}`;
        case 'earn_adena': return goal.type;
        default: return ''; // Routine recovery/selling cycles are not news.
    }
}

function isBotSession(session) {
    return session?.constructor?.name === 'BotSession' || String(session?.accountId || '').startsWith('bot_');
}

function memberBot(characterId) {
    const World = invoke('GameServer/World/World');
    const session = invoke('GameServer/Bot/BotManager').findSessionById(characterId) ||
        World.user?.sessions?.find(entry => id(entry) === characterId);
    if (session) return isBotSession(session) && !Identity.isStaticService(session) &&
        session.actor?.fetchIsOnline?.() !== false && !session.actor?.isDead?.() ? session : null;
    const cold = invoke('GameServer/Bot/Population/BotLifeState').cachedState(characterId);
    return cold?.phase === 'cold' && !Identity.isStaticService(cold) ? cold : null;
}

function onJoined(source, clanId, now = Date.now()) {
    if (Config.clanChatEnabled === false) return false;
    const speaker = source?.actor && isBotSession(source) ? source : memberBot(id(source));
    if (!speaker || !audience(speaker, clanId).length) return false;
    const clan = ClanService.findById(clanId);
    if (!clan?.members?.some(member => Number(member.id) === id(speaker))) return false;
    const candidates = [...new Set(clan.members.map(member => Number(member.id)))]
        .filter(characterId => characterId !== id(speaker))
        .map(memberBot).filter(bot => bot && audience(bot, clanId).length);
    const count = Math.min(candidates.length, 2 + Math.floor(Math.random() * 4));
    const replies = [];
    while (replies.length < count) {
        const chosen = Voice.pick(candidates, bot => Voice.styleWeight(bot, 'social') + Voice.styleWeight(bot, 'warm'));
        replies.push(id(chosen));
        candidates.splice(candidates.indexOf(chosen), 1);
    }
    return enqueue(speaker, 'joined', {}, 'joined', now, {
        clanId: Number(clanId), join: { newcomerId: id(speaker), name: speaker.actor?.fetchName?.() || speaker.name, replies, texts: [] }
    });
}

function enqueue(source, topic, values, eventKey, now, extra = {}) {
    if (Config.clanChatEnabled === false || !id(source) || Identity.isStaticService(source)) return false;
    const players = audience(source, extra.clanId);
    if (!players.length) return false;
    const clanId = Number(players[0].actor.fetchClanId());
    const key = `${clanId}:${id(source)}:${eventKey}`;
    if (now - (history.get(key) ?? -Infinity) < EVENT_COOLDOWN_MS) return false;
    // Keep only a compact identity, never a cold inventory snapshot.
    const speaker = source.actor ? source : { characterId: id(source), name: source.name, persona: Voice.profile(source) };
    const queue = queues.get(clanId) || { pending: [], nextAt: 0 };
    if (queue.pending.some(entry => entry.key === key) || queue.pending.length >= MAX_PENDING) return false;
    if (extra.goal) queue.pending = queue.pending.filter(entry => !(entry.goal && id(entry.source) === id(source)));
    queue.pending.push({ source: speaker, topic, values, key, at: now, ...extra });
    boundedSet(queues, clanId, queue, MAX_CLANS);
    boundedSet(history, key, now);
    flush(now, true);
    return true;
}

function flush(now = Date.now(), immediate = false) {
    if (!immediate && now < nextFlushAt) return;
    nextFlushAt = now + 1000;
    if (Config.clanChatEnabled === false) { queues.clear(); return; }
    for (const [clanId, queue] of queues) {
        if (now < queue.nextAt) continue;
        let entry;
        while ((entry = queue.pending.shift())) {
            if (now - entry.at >= QUEUE_TTL_MS) continue;
            if (entry.join) {
                // A greeting and all its replies occupy one queue slot. Recheck
                // membership before every line, including that of the newcomer.
                const clan = ClanService.findById(clanId);
                if (!clan?.members?.some(member => Number(member.id) === entry.join.newcomerId)) continue;
                if (entry.topic === 'welcome') {
                    let responder;
                    while (entry.join.replies.length && !responder) {
                        const characterId = entry.join.replies.shift();
                        if (!clan.members.some(member => Number(member.id) === characterId)) continue;
                        const candidate = memberBot(characterId);
                        if (candidate && audience(candidate, clanId).length) responder = candidate;
                    }
                    if (!responder) continue;
                    entry.source = responder;
                } else {
                    const newcomer = memberBot(entry.join.newcomerId);
                    if (!newcomer) continue;
                    entry.source = newcomer;
                }
            }
            if (entry.goal && goalKey(invoke('GameServer/Bot/Goals/GoalState').snapshot(id(entry.source))?.current) !== entry.goal) continue;
            const players = audience(entry.source, clanId);
            if (!players.length) continue;
            const text = Voice.line(`clan.${entry.topic}`, entry.source, entry.values, entry.join?.texts || []);
            if (!text) continue;
            const actor = entry.source.actor || { fetchId: () => id(entry.source), fetchName: () => entry.source.name };
            const packet = invoke('GameServer/Network/Response').speak(actor, { kind: 4, text });
            let delivered = 0;
            for (const player of players) {
                try { player.dataSendToMe(packet); delivered += 1; }
                catch (error) { utils.infoWarn('BotClanChat', 'delivery failed: %s', error.message); }
            }
            if (delivered) {
                queue.nextAt = now + Number(Config.clanChatMinIntervalMs || 15000);
                console.info('BotClanChat :: %s clan=%s topic=%s recipients=%s text=%s',
                    actor.fetchName(), clanId, entry.topic, delivered, JSON.stringify(text));
                if (entry.join?.replies.length) {
                    if (entry.topic === 'joined') entry.at = now;
                    entry.join.texts.push(text);
                    entry.topic = 'welcome';
                    entry.values = { name: entry.join.name };
                    queue.pending.unshift(entry);
                    queue.nextAt = now + 4000 + Math.floor(Math.random() * 4001);
                }
            }
            break;
        }
        if (!queue.pending.length && now >= queue.nextAt) queues.delete(clanId);
    }
}

function onGoal(source, goal, previous, now = Date.now()) {
    const key = goalKey(goal);
    if (!key || key === goalKey(previous)) return false;
    const values = {};
    let topic = 'goal_level';
    if (['upgrade_gear', 'buy_craft_material'].includes(goal.type)) {
        values.item = itemName(goal.target?.itemId, goal.target?.itemName);
        if (!values.item) return false;
        topic = goal.type === 'upgrade_gear' ? 'goal_gear' : 'goal_material';
    } else if (goal.type === 'earn_adena') topic = 'goal_adena';
    else {
        values.level = Number(goal.target?.level);
        if (!Number.isInteger(values.level) || values.level <= Number(source.level || 0)) return false;
    }
    return enqueue(source, topic, values, `goal:${key}`, now, { goal: key });
}

function onDeath(source, token, now = Date.now()) {
    if (Config.clanChatEnabled === false || !id(source) || !token || !audience(source).length) return false;
    const key = id(source);
    const previous = (deaths.get(key) || []).filter(event => now - event.at < DEATH_WINDOW_MS);
    if (previous.some(event => event.token === token)) return false;
    previous.push({ token, at: now });
    boundedSet(deaths, key, previous.slice(-12));
    if (previous.length < 3) return false;
    const grouped = source.partyCompanion || source.party?.partyId || source.activity === 'grouped';
    return enqueue(source, grouped ? 'struggling_group' : 'struggling_solo', {}, 'struggling', now);
}

function onResolved(source, events = [], now = Date.now()) {
    flush(now);
    for (const event of events) {
        if (event.type !== 'death') continue;
        const characterId = Number(event.characterId || id(source));
        const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState(characterId) ||
            (characterId === id(source) ? source : null);
        if (!current || current.phase !== 'cold') continue;
        if (Number(current.stats?.deaths || 0) > 0) onDeath(current, `cold:${current.stats.deaths}`, now);
    }
}

function onWarehouse(source, result, clanId, now = Date.now()) {
    if (!result?.ok || !result.received) return false;
    const received = result.received;
    const name = itemName(received.selfId, received.name);
    if (!name) return false;
    const item = `${Number(received.enchant) > 0 ? `+${Number(received.enchant)} ` : ''}${name}`;
    return enqueue(source, 'warehouse', { item }, `warehouse:${received.id}:${source.stats?.clanGearExchangeRevision || 0}`, now, { clanId: Number(clanId) });
}

function onWithdrawal(source, result, now = Date.now()) {
    if (!result?.ok || result.code !== 'warehouse_withdraw_applied' || !result.ledgerId || Number(result.amount) <= 0) return false;
    const name = itemName(result.selfId);
    if (!name) return false;
    const item = Number(result.amount) > 1 ? `${Number(result.amount)} ${name}` : name;
    return enqueue(source, 'warehouse', { item }, `withdrawal:${result.ledgerId}`, now, { clanId: Number(result.clanId) });
}

function safe(callback) {
    return (...args) => {
        try { return callback(...args); }
        catch (error) { utils.infoWarn('BotClanChat', 'chatter skipped: %s', error.message); return false; }
    };
}

module.exports = {
    onGoal: safe(onGoal), onDeath: safe(onDeath), onResolved: safe(onResolved), onWarehouse: safe(onWarehouse),
    onWithdrawal: safe(onWithdrawal), onJoined: safe(onJoined), flush: safe(flush), goalKey,
    DEATH_WINDOW_MS, EVENT_COOLDOWN_MS, QUEUE_TTL_MS, MAX_PENDING, MAX_CLANS,
    snapshot() { return { clans: queues.size, pending: [...queues.values()].reduce((sum, queue) => sum + queue.pending.length, 0), history: history.size, deaths: deaths.size }; },
    reset() { queues.clear(); history.clear(); deaths.clear(); nextFlushAt = 0; }
};
