const NpcObjectIndex = require('../../World/NpcObjectIndex');

// Death notifications enqueue work; issuing a skill is not proof of collection.
// Keep the live corpse identity across route completion and combat interruptions.
function enqueue(session, npc) {
    const id = Number(npc.fetchId());
    const pending = session.pendingSweeps || (session.pendingSweeps = new Map());
    if (!pending.has(id)) pending.set(id, {
        npc, deadlineAt: Number(npc.corpseDecayAt) || Date.now() + 30000,
        retryAt: 0
    });
}

function prune(session, bot, now = Date.now()) {
    const pending = session.pendingSweeps;
    if (!pending) return;
    const world = invoke('GameServer/World/World');
    for (const [id, entry] of pending) {
        const npc = entry.npc;
        const spoil = npc.model?.spoil;
        if (now >= entry.deadlineAt || npc.corpseDecayState === 'removed'
            || NpcObjectIndex.find(world, id) !== npc || !npc.isDead?.()
            || !npc.fetchAttackable?.() || !spoil?.spoiled || spoil.swept
            || Number(spoil.spoilerId) !== Number(bot.fetchId())
            || !bot.skillset?.fetchSkill?.(42)) {
            pending.delete(id);
        }
    }
    if (!pending.size) delete session.pendingSweeps;
}

function canStart(session, bot) {
    if (bot.isDead?.() || bot.state?.fetchDead?.() || bot.state?.fetchSeated?.()
        || bot.state?.fetchHits?.() || bot.state?.fetchCasts?.() || bot.state?.fetchTowards?.()
        || session.pendingPathRequest || session.pvpDefense || session.pvpEncounter
        || session.pvpAggressors?.size || session.spotRelocation || session.pendingTownTrip
        || (session.plan && !['hunting', 'following'].includes(session.plan))) return false;
    if (!invoke('GameServer/Effects/EffectRestrictions').canCast(bot)) return false;
    if (bot.fetchMaxHp && bot.fetchHp() / Math.max(1, bot.fetchMaxHp()) < 0.35) return false;
    const awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    if (bot.fetchLocX && bot.fetchLocY && awareness.npcThreateningActor(session)) return false;
    const leader = session.followPlayerSession || (session.hotBackgroundPartyId
        && invoke('GameServer/Bot/AI/HotBackgroundParty').leader(session));
    return !leader || !awareness.findThreatTargetingPartyProjected(leader);
}

function yieldToDefense(session, bot) {
    const destination = Number(session.activeMoveGoal?.targetId || bot.automation?.fetchDestId?.() || 0);
    if (session.pendingSweeps?.has(destination) && (bot.state?.fetchTowards?.() || session.pendingPathRequest)
        && !bot.state?.fetchCasts?.()) bot.automation.abortAll(bot);
}

function tick(session, bot, Generics, AI, now = Date.now()) {
    prune(session, bot, now);
    if (!session.pendingSweeps) return false;
    // Called after emergency actions. Reserve an existing sweep approach/cast
    // until it finishes; never restart its timer on every ordinary AI tick.
    if (bot.state?.fetchCasts?.() || bot.state?.fetchTowards?.() || session.pendingPathRequest) return true;
    if (!canStart(session, bot)) return false;
    for (const [id, entry] of session.pendingSweeps) {
        const skill = bot.skillset.fetchSkill(42);
        if (bot.fetchMp() < skill.fetchConsumedMp() || bot.canUseSkill?.(skill) === false) return false;
        if (now < entry.retryAt) return true;
        entry.retryAt = now + 750;
        // Deduplication applies to a dispatched attempt, not the corpse lifetime.
        if (session.sweepAttemptedTargetId === id) session.sweepAttemptedTargetId = undefined;
        return AI.trySweep(session, bot, entry.npc, Generics);
    }
    return false;
}

module.exports = { enqueue, prune, canStart, yieldToDefense, tick };
