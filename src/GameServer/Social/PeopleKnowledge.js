const episodes = new WeakMap();
function statsAfter(stats = {}, episode) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    if (!Learning.knowledgeEnabled() || !episode || stats.peopleEpisode === episode) return stats;
    return { ...stats, peoplePoints: Math.max(0, Number(stats.peoplePoints) || 0) + 1, peopleEpisode: episode };
}
function uncertainty(source, persona = {}) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    if (!Learning.knowledgeEnabled()) return 0;
    const understanding = Math.max(0, Math.min(1, Number(persona?.understanding ?? persona?.traits?.understanding ?? 0.5)));
    return Learning.stageError(0.5 * (1 - understanding), 0.02, source?.peopleKnowledge?.peoplePoints ?? source?.stats?.peoplePoints ?? source?.coldLifeState?.stats?.peoplePoints ?? 0,
        Learning.gradeOfLevel(source?.level || source?.actor?.fetchLevel?.() || 1), 'people');
}
// Estimate only the visible signal, with one repeatable error for the decision.
// No opponent stats are read and the caller's existing RNG stream is untouched.
function estimate(value, source, persona, key) {
    const error = uncertainty(source, persona);
    if (!error) return value;
    const id = source?.characterId ?? source?.actor?.fetchId?.() ?? source?.id;
    const roll = require('../Bot/AI/TendencyRoll').roll('people_estimate', id, key);
    return value * (1 + (roll * 2 - 1) * error);
}
function recordActor(actor, other, at = Date.now()) {
    const session = actor?.session;
    if (!String(session?.accountId || '').startsWith('bot_') || session.arenaEphemeral || !other || other.fetchKind || actor === other) return false;
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    if (!Learning.knowledgeEnabled()) return false;
    const key = session.pvpEncounter?.key || `hot:${Math.min(actor.fetchId(), other.fetchId())}:${Math.max(actor.fetchId(), other.fetchId())}:${Math.floor(at / 60000)}`;
    let seen = episodes.get(session);
    if (!seen) { seen = new Set(); episodes.set(session, seen); }
    const life = invoke('GameServer/Bot/Population/BotLifeState');
    const prior = session.peopleKnowledge || life.cachedState(actor.fetchId())?.stats || {};
    if (seen.has(key) || prior.peopleEpisode === key) return false;
    seen.add(key); if (seen.size > 32) seen.delete(seen.values().next().value);
    const next = statsAfter(prior, key);
    session.peopleKnowledge = { peoplePoints: next.peoplePoints, peopleEpisode: key };
    void life.rememberEnemies(session);
    return true;
}
module.exports = { statsAfter, uncertainty, estimate, recordActor };
