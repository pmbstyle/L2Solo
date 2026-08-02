const BotConversation = invoke('GameServer/Bot/AI/BotConversation');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');

const DEFAULT_SCENE_COOLDOWN_MS = 3 * 60 * 1000;
const DEFAULT_PAIR_COOLDOWN_MS = 90 * 1000;
const DEFAULT_SCENE_TTL_MS = 8 * 1000;
const MAX_REASON_CHARS = 120;

const MOODS = Object.freeze(['calm', 'focused', 'sociable', 'restless', 'tired', 'guarded']);
const activeScenes = new Map();

function bool(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function config() {
    return options.default?.BotPopulation || {};
}

function enabled() {
    return bool(config().ambientScenesEnabled, true);
}

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function actorId(session) {
    return number(session?.actor?.fetchId?.(), 0);
}

function actorName(session) {
    return session?.actor?.fetchName?.() || session?.name || `bot-${actorId(session) || 'unknown'}`;
}

function clean(value, max = MAX_REASON_CHARS) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isOnline(session) {
    if (!session?.actor) return false;
    return typeof session.actor.fetchIsOnline !== 'function' || session.actor.fetchIsOnline() !== false;
}

function isBotSession(session) {
    if (!session?.actor) return false;
    if (session.accountId) return String(session.accountId).startsWith('bot_');
    return session.constructor?.name === 'BotSession' || session.botSession === true;
}

function trait(session, name, fallback = 0.5) {
    const value = Number(session?.persona?.traits?.[name]);
    return Number.isFinite(value) ? value : fallback;
}

function personaFor(session) {
    if (session?.persona?.primaryDrive) return session.persona;
    const id = actorId(session);
    if (!id) return null;
    try { return BotPersona.generate({ characterId: id }); } catch (_) { return null; }
}

function ratio(actor, current, maximum) {
    const max = number(actor?.[maximum]?.(), 0);
    if (max <= 0) return 1;
    return Math.max(0, Math.min(1, number(actor?.[current]?.(), max) / max));
}

function deriveMood(session) {
    const actor = session?.actor;
    if (!actor) return { mood: 'calm', intent: 'keep_ready', reason: 'missing_actor' };
    if (actor.state?.fetchDead?.() || session.plan === 'dead') {
        return { mood: 'tired', intent: 'recover', reason: 'dead_or_recovering' };
    }

    const hp = ratio(actor, 'fetchHp', 'fetchMaxHp');
    const mp = ratio(actor, 'fetchMp', 'fetchMaxMp');
    if (hp < 0.35 || mp < 0.20 || session.plan === 'resting' && (hp < 0.65 || mp < 0.45)) {
        return { mood: 'tired', intent: 'recover', reason: 'low_vitals' };
    }
    if (session.activeTrade || session.activeNegotiation || session.plan === 'shopping' || session.plan === 'merchant') {
        return { mood: 'focused', intent: 'complete_errand', reason: 'commerce_or_errand' };
    }
    if (session.partyCompanion === true || session.plan === 'following') {
        return { mood: 'focused', intent: 'support_party', reason: 'party_duty' };
    }

    const socialEvent = session.lastSocialEvent;
    if (socialEvent?.event === 'insulted' || socialEvent?.event === 'party_kicked' || socialEvent?.event === 'party_dismissed') {
        return { mood: 'guarded', intent: 'keep_distance', reason: 'recent_social_harm' };
    }

    const persona = personaFor(session);
    if (persona?.primaryDrive === 'social' || trait(session, 'sociability') >= 0.76) {
        return { mood: 'sociable', intent: 'seek_company', reason: 'social_persona' };
    }
    if (Number(session.noTargetTicks || 0) >= 3 || session.plan === 'resting' && trait(session, 'restlessness') >= 0.68) {
        return { mood: 'restless', intent: 'look_for_activity', reason: 'idle_or_restless' };
    }
    if (persona?.primaryDrive === 'progression' || persona?.primaryDrive === 'wealth') {
        return { mood: 'focused', intent: 'complete_run', reason: 'goal_persona' };
    }
    return { mood: 'calm', intent: 'keep_ready', reason: 'stable_state' };
}

function snapshot(session, now = Date.now()) {
    const current = session?.ambientState || refresh(session, now);
    const scene = session?.ambientScene;
    return {
        mood: MOODS.includes(current.mood) ? current.mood : 'calm',
        intent: current.intent || 'keep_ready',
        reason: current.reason || 'stable_state',
        updatedAt: Number(current.updatedAt || now),
        scene: scene ? {
            id: scene.id,
            topic: scene.topic,
            participants: [...scene.participants],
            startedAt: scene.startedAt,
            expiresAt: scene.expiresAt
        } : null,
        cooldownRemainingMs: Math.max(0, Number(session?.ambientLastSceneAt || 0) + sceneCooldownMs() - now)
    };
}

function refresh(session, now = Date.now()) {
    if (!session) return null;
    const mood = deriveMood(session);
    const previous = session.ambientState;
    session.ambientState = {
        ...mood,
        updatedAt: now
    };
    if (previous?.mood && previous.mood !== mood.mood && actorId(session)) {
        BotEventJournal.record({
            botId: actorId(session),
            eventType: 'ambient_mood',
            summary: `${actorName(session)} mood=${mood.mood} intent=${mood.intent}`,
            dedupeKey: `mood:${mood.mood}`,
            meta: { mood: mood.mood, intent: mood.intent, reason: mood.reason }
        }).catch(() => {});
    }
    return session.ambientState;
}

function sceneCooldownMs() {
    return Math.max(30 * 1000, number(config().ambientSceneCooldownMs, DEFAULT_SCENE_COOLDOWN_MS));
}

function pairCooldownMs() {
    return Math.max(30 * 1000, number(config().ambientPairCooldownMs, DEFAULT_PAIR_COOLDOWN_MS));
}

function sceneTtlMs() {
    return Math.max(2500, number(config().ambientSceneTtlMs, DEFAULT_SCENE_TTL_MS));
}

function pairKey(first, second) {
    return [actorId(first), actorId(second)].sort((a, b) => a - b).join(':');
}

function distance2d(first, second) {
    const a = first?.actor;
    const b = second?.actor;
    if (!a || !b || typeof a.fetchLocX !== 'function' || typeof b.fetchLocX !== 'function') return null;
    const dx = number(a.fetchLocX()) - number(b.fetchLocX());
    const dy = number(a.fetchLocY()) - number(b.fetchLocY());
    return Math.sqrt(dx * dx + dy * dy);
}

function expireSceneIfNeeded(session, now) {
    const scene = session?.ambientScene;
    if (scene && Number(scene.expiresAt || 0) <= now) finish(scene, 'ttl_expired', now);
}

function eligible(initiator, responder, now = Date.now()) {
    if (!enabled()) return { ok: false, reason: 'ambient_disabled' };
    expireSceneIfNeeded(initiator, now);
    expireSceneIfNeeded(responder, now);
    if (!isBotSession(initiator) || !isBotSession(responder)) return { ok: false, reason: 'bot_only_scene' };
    if (!isOnline(initiator) || !isOnline(responder)) return { ok: false, reason: 'offline' };
    if (initiator === responder) return { ok: false, reason: 'same_session' };
    if (initiator.partyCompanion || responder.partyCompanion) return { ok: false, reason: 'player_companion' };
    if (initiator.plan !== 'resting' || responder.plan !== 'resting') return { ok: false, reason: 'not_resting' };
    if (initiator.inConversation || responder.inConversation || initiator.ambientScene || responder.ambientScene) {
        return { ok: false, reason: 'scene_active' };
    }
    if (initiator.activeTrade || responder.activeTrade || initiator.activeNegotiation || responder.activeNegotiation) {
        return { ok: false, reason: 'commerce_active' };
    }

    const distance = distance2d(initiator, responder);
    if (distance !== null && distance > BotConversation.CONVERSATION_RANGE) {
        return { ok: false, reason: 'too_far', distance };
    }

    const lastScene = Math.max(Number(initiator.ambientLastSceneAt || 0), Number(responder.ambientLastSceneAt || 0));
    if (lastScene && now - lastScene < pairCooldownMs()) {
        return { ok: false, reason: 'pair_cooldown', retryAfterMs: pairCooldownMs() - (now - lastScene) };
    }
    if ([initiator, responder].some((session) => session.lastAmbientSceneAt && now - session.lastAmbientSceneAt < sceneCooldownMs())) {
        return { ok: false, reason: 'bot_cooldown' };
    }
    return { ok: true, distance };
}

function recordSceneEvent(session, scene, eventType, reason = '') {
    const id = actorId(session);
    if (!id) return;
    BotEventJournal.record({
        botId: id,
        eventType,
        summary: `${actorName(session)} ambient ${scene.topic}${reason ? ` (${reason})` : ''}`,
        dedupeKey: `${eventType}:${scene.id}`,
        meta: {
            sceneId: scene.id,
            topic: scene.topic,
            participants: scene.participants,
            reason: clean(reason, 80)
        }
    }).catch(() => {});
}

function start(initiator, responder, now = Date.now()) {
    const check = eligible(initiator, responder, now);
    if (!check.ok) return check;

    const conversation = BotConversation.start(initiator, responder, now);
    if (!conversation) return { ok: false, reason: 'conversation_unavailable' };

    const scene = {
        id: `ambient-${actorId(initiator)}-${actorId(responder)}-${now}`,
        topic: conversation.topic,
        participants: [actorName(initiator), actorName(responder)],
        startedAt: now,
        expiresAt: now + sceneTtlMs(),
        conversation,
        finished: false
    };
    initiator.ambientScene = scene;
    responder.ambientScene = scene;
    initiator.ambientLastSceneAt = now;
    responder.ambientLastSceneAt = now;
    activeScenes.set(scene.id, scene);
    refresh(initiator, now);
    refresh(responder, now);
    recordSceneEvent(initiator, scene, 'ambient_scene_started');
    recordSceneEvent(responder, scene, 'ambient_scene_started');
    return { ok: true, scene, conversation };
}

function finish(sceneOrSession, reason = 'completed', now = Date.now()) {
    const scene = sceneOrSession?.conversation ? sceneOrSession : sceneOrSession?.ambientScene;
    if (!scene || scene.finished) return false;
    scene.finished = true;
    BotConversation.finish(scene.conversation || scene);
    activeScenes.delete(scene.id);
    const participants = [scene.conversation?.lines?.[0]?.speaker, scene.conversation?.lines?.[1]?.speaker]
        .filter(Boolean);
    participants.forEach((session) => {
        if (session.ambientScene === scene) session.ambientScene = null;
        session.ambientLastSceneAt = Number(session.ambientLastSceneAt || scene.startedAt || now);
        session.lastAmbientScene = {
            id: scene.id,
            topic: scene.topic,
            at: now,
            reason: clean(reason, 80)
        };
        recordSceneEvent(session, scene, 'ambient_scene_finished', reason);
        refresh(session, now);
    });
    return true;
}

function cleanup(session, reason = 'lifecycle') {
    if (!session) return false;
    const scene = session.ambientScene;
    if (!scene) return false;
    scene.cancelled = true;
    return finish(scene, reason);
}

function sceneFor(session) {
    return session?.ambientScene || null;
}

const BotAmbientDirector = {
    MOODS,
    DEFAULT_SCENE_COOLDOWN_MS,
    DEFAULT_PAIR_COOLDOWN_MS,
    DEFAULT_SCENE_TTL_MS,
    enabled,
    deriveMood,
    refresh,
    snapshot,
    eligible,
    start,
    finish,
    cleanup,
    sceneFor,
    activeScenes() { return [...activeScenes.values()].map((scene) => ({ ...scene, conversation: undefined })); },
    reset() {
        activeScenes.clear();
    }
};

module.exports = BotAmbientDirector;
