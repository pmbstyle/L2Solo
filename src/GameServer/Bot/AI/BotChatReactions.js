const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const Budget = invoke('GameServer/Bot/AI/BotChatterBudget');

const RESPONSE_WINDOW_MS = 20000;
const MAX_LOCAL_SCENES = 16;
const LOCAL_RANGE = 800;
const LOCAL_TOPICS = {
    'npc-gear-purchased': 'gear', 'market-gear-purchased': 'gear',
    'shots-too-expensive': 'price', rest: 'rest', rested: 'rested',
    victory: 'victory', revived: 'revived'
};
const TOPICS = {
    global: new Set(['death', 'break', 'roads', 'patience', 'company']),
    local: new Set(Object.values(LOCAL_TOPICS))
};
let globalScene = null;
const localScenes = [];
const lastExchange = new Map();

function id(source) { return Number(source?.actor?.fetchId?.() || source?.characterId || 0); }
function name(source) { return source?.actor?.fetchName?.() || source?.name || ''; }
function delay() { return 2500 + Math.floor(Math.random() * 3500); }

function eligible(source) {
    if (!id(source) || !name(source)) return false;
    if (!source.actor) {
        return source.phase === 'cold' && ['hunting', 'resting', 'grouped'].includes(source.activity) &&
            Number(source.vitals?.hp || 0) > 0 && !source.stats?.travel;
    }
    const actor = source.actor;
    return (source.botSession === true || String(source.accountId || '').startsWith('bot_')) &&
        source.aiActive !== false && actor.fetchIsOnline?.() !== false &&
        !source.partyCompanion && !source.followPlayerSession && !source.inConversation &&
        !source.chatArrivalActive && !source.activeTrade && !source.activeNegotiation &&
        !actor.isDead?.() && !actor.state?.fetchDead?.() &&
        !actor.state?.fetchHits?.() && !actor.state?.fetchCasts?.() &&
        ['resting', 'hunting', 'shopping'].includes(source.plan);
}

function prune(now) {
    if (globalScene && (globalScene.expiresAt <= now || Config.chatReactionsEnabled === false)) globalScene = null;
    for (let index = localScenes.length - 1; index >= 0; index--) {
        if (localScenes[index].expiresAt <= now || Config.chatReactionsEnabled === false) localScenes.splice(index, 1);
    }
}

function isBusy(source, now = Date.now(), except = null) {
    prune(now);
    const sourceId = id(source);
    return [globalScene, ...localScenes].some(scene => scene && scene !== except &&
        (scene.openerId === sourceId || scene.responderId === sourceId));
}

function create(channel, source, topic, now) {
    if (Config.chatReactionsEnabled === false || !TOPICS[channel].has(topic) ||
        !id(source) || isBusy(source, now) || Math.random() >= Config.chatReactionChance) return null;
    return { channel, topic, openerId: id(source), openerName: name(source),
        source: source.actor ? source : null, dueAt: now + delay(),
        expiresAt: now + RESPONSE_WINDOW_MS, responderId: null, close: null };
}

function openGlobal(source, topic, now = Date.now()) {
    prune(now);
    if (globalScene) return false;
    globalScene = create('global', source, topic, now);
    return !!globalScene;
}

function exchange(scene, candidate) {
    const traits = candidate.persona?.traits || {};
    const base = `reaction.${scene.channel}.${scene.topic}`;
    const keys = [base, `${base}.2`, `${base}.3`].filter(key => Speech.catalog[key]);
    const fresh = keys.filter(key => key !== lastExchange.get(base));
    const pool = fresh.length ? fresh : keys;
    const key = pool[Math.floor(Math.random() * pool.length)];
    const lines = Speech.lines(key, { name: scene.openerName, responder: name(candidate) }, {
        social: Number(traits.sociability || 0) >= 0.7,
        cautious: Number(traits.caution || 0) >= 0.7
    });
    return { base, key, lines };
}

// Reply turns enter here only through ordinary simulation work. No timers,
// population scans or reads of cold bot records are needed to find a speaker.
function offerGlobal(candidate, deliver, speakerAvailable, now = Date.now()) {
    prune(now);
    const scene = globalScene;
    if (!scene) return false;
    if (scene.source && !eligible(scene.source) || scene.responder && !eligible(scene.responder)) {
        globalScene = null; return false;
    }
    if (scene.responderId === id(candidate) && !eligible(candidate)) { globalScene = null; return false; }
    if (now < scene.dueAt || !eligible(candidate) || isBusy(candidate, now, scene)) return false;
    if (scene.responderId) {
        if (id(candidate) !== scene.openerId) return false;
        globalScene = null;
        return deliver(candidate, scene.close, scene.topic, now) !== false;
    }
    if (id(candidate) === scene.openerId || !speakerAvailable(id(candidate), now)) return false;
    const chosen = exchange(scene, candidate);
    const [reply, close] = chosen.lines;
    if (!reply || !close || deliver(candidate, reply, scene.topic, now) === false) return false;
    lastExchange.set(chosen.base, chosen.key);
    if (Math.random() < 0.5) {
        scene.responderId = id(candidate);
        scene.responder = candidate.actor ? candidate : null;
        scene.close = close;
        scene.dueAt = now + delay();
        scene.expiresAt = now + RESPONSE_WINDOW_MS;
    } else globalScene = null;
    return true;
}

function audience(session) {
    const World = invoke('GameServer/World/World');
    if (!World.user?.sessions) return [];
    return World.fetchVisibleRealPlayers(session, session.actor);
}

function nearby(a, b) {
    const coords = actor => [actor?.fetchLocX?.(), actor?.fetchLocY?.(), actor?.fetchLocZ?.()];
    const first = coords(a?.actor), second = coords(b?.actor);
    if (![...first, ...second].every(Number.isFinite)) return false;
    return Math.abs(first[2] - second[2]) <= 256 &&
        Math.hypot(first[0] - second[0], first[1] - second[1]) <= LOCAL_RANGE;
}

function openLocal(source, key, now = Date.now()) {
    prune(now);
    if (localScenes.length >= MAX_LOCAL_SCENES || !eligible(source) || !LOCAL_TOPICS[key]) return false;
    const scene = create('local', source, LOCAL_TOPICS[key], now);
    if (!scene) return false;
    const witnesses = audience(source);
    if (!witnesses.length) return false;
    // Snapshot only hot neighbours once, when the opener is spoken. A bot
    // arriving later cannot answer a line it never heard. No cold scan.
    scene.listeners = new Set();
    for (const candidate of invoke('GameServer/Bot/BotManager').sessions || []) {
        if (candidate !== source && eligible(candidate) && nearby(source, candidate)) scene.listeners.add(candidate);
        if (scene.listeners.size >= 32) break;
    }
    if (!scene.listeners.size) return false;
    scene.witnesses = new Set(witnesses);
    localScenes.push(scene);
    return true;
}

function heardTogether(scene, candidate) {
    if (!nearby(scene.source, candidate)) return false;
    const listeners = new Set(audience(scene.source).filter(player => scene.witnesses.has(player)));
    return audience(candidate).some(player => listeners.has(player));
}

function offerLocal(candidate, now = Date.now()) {
    prune(now);
    if (!localScenes.length || !eligible(candidate)) return false;
    for (let index = localScenes.length - 1; index >= 0; index--) {
        const scene = localScenes[index];
        if (!eligible(scene.source) || scene.responder && !eligible(scene.responder)) {
            localScenes.splice(index, 1);
            continue;
        }
        if (now < scene.dueAt || isBusy(candidate, now, scene)) continue;
        if (scene.responderId) {
            if (id(candidate) !== scene.openerId) continue;
            localScenes.splice(index, 1);
            if (!heardTogether(scene, scene.responder)) return false;
            invoke('GameServer/Bot/BotManager').botSay(candidate, scene.close);
            Budget.record(candidate, 'conversation', now, true);
            return true;
        }
        if (id(candidate) === scene.openerId || !scene.listeners.has(candidate) ||
            !Budget.canReply(candidate, now) || !heardTogether(scene, candidate)) continue;
        const chosen = exchange(scene, candidate);
        const [reply, close] = chosen.lines;
        if (!reply || !close) continue;
        invoke('GameServer/Bot/BotManager').botSay(candidate, reply);
        lastExchange.set(chosen.base, chosen.key);
        Budget.record(candidate, 'conversation', now, true);
        if (Math.random() < 0.5) {
            scene.responderId = id(candidate);
            scene.responder = candidate;
            scene.close = close;
            scene.dueAt = now + delay();
            scene.expiresAt = now + RESPONSE_WINDOW_MS;
        } else localScenes.splice(index, 1);
        return true;
    }
    return false;
}

function cancel(source) {
    const matches = scene => scene && [scene.openerId, scene.responderId].includes(id(source));
    if (matches(globalScene)) globalScene = null;
    for (let index = localScenes.length - 1; index >= 0; index--) {
        if (matches(localScenes[index])) localScenes.splice(index, 1);
    }
}

module.exports = {
    canParticipate: eligible,
    openGlobal, offerGlobal, openLocal, offerLocal, isBusy, cancel,
    RESPONSE_WINDOW_MS, MAX_LOCAL_SCENES, LOCAL_RANGE,
    snapshot(now = Date.now()) { prune(now); return { global: !!globalScene, local: localScenes.length }; },
    reset() { globalScene = null; localScenes.length = 0; lastExchange.clear(); }
};
