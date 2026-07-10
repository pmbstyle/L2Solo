const ServerResponse = invoke('GameServer/Network/Response');

function cubicsFor(actor) {
    if (!(actor.cubics instanceof Map)) actor.cubics = new Map();
    return actor.cubics;
}

function idsFor(actor) {
    return [...(actor?.cubics?.keys?.() || [])];
}

function slotCount(actor) {
    const mastery = actor?.skillset?.fetchSkill?.(143);
    return Math.max(1, (Number(mastery?.fetchLevel?.()) || 0) + 1);
}

function notify(session, actor) {
    if (typeof actor?.fetchRace !== 'function') return;
    session?.dataSendToMeAndOthers?.(ServerResponse.userInfo(actor), actor);
}

function remove(session, actor, cubicId) {
    const cubic = actor?.cubics?.get?.(Number(cubicId));
    if (!cubic) return false;
    clearTimeout(cubic.expireTimer);
    actor.cubics.delete(Number(cubicId));
    notify(session, actor);
    return true;
}

function summon(session, actor, skill) {
    const cubicId = Number(skill.fetchSummonNpcId?.()) || 0;
    const lifetime = Number(skill.fetchSummonTotalLifeTime?.()) || 0;
    if (!cubicId || lifetime <= 0) return null;

    const cubics = cubicsFor(actor);
    remove(session, actor, cubicId);

    while (cubics.size >= slotCount(actor)) {
        remove(session, actor, cubics.keys().next().value);
    }

    const cubic = {
        id: cubicId,
        skillId: Number(skill.fetchSelfId?.()) || 0,
        level: Number(skill.fetchLevel?.()) || 1,
        power: Number(skill.fetchPower?.()) || 0,
        activationChance: Number(skill.fetchSummonActivationChance?.()) || 0,
        activationTime: Number(skill.fetchSummonActivationTime?.()) || 0,
        expiresAt: Date.now() + lifetime
    };
    cubic.expireTimer = setTimeout(() => remove(session, actor, cubicId), lifetime);
    cubic.expireTimer.unref?.();
    cubics.set(cubicId, cubic);
    notify(session, actor);
    return cubic;
}

module.exports = {
    idsFor,
    remove,
    summon
};
