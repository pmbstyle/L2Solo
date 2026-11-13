const FailureLog = require('../../FailureLog');
const HitRules = invoke('GameServer/Combat/HitRules');
function ensureTimers(actor) {
    if (!actor.effectTimers) actor.effectTimers = {};
    return actor.effectTimers;
}

function ensureExpiryTimers(actor) {
    if (!actor.effectExpiryTimers) actor.effectExpiryTimers = {};
    return actor.effectExpiryTimers;
}

function clear(actor, key) {
    let removed = false;
    if (actor?.effectTimers?.[key]) {
        clearInterval(actor.effectTimers[key]);
        delete actor.effectTimers[key];
        removed = true;
    }
    if (actor?.effectExpiryTimers?.[key]) {
        clearTimeout(actor.effectExpiryTimers[key]);
        delete actor.effectExpiryTimers[key];
        removed = true;
    }
    return removed;
}

function clearAll(actor) {
    const keys = new Set([
        ...Object.keys(actor?.effectTimers || {}),
        ...Object.keys(actor?.effectExpiryTimers || {})
    ]);
    keys.forEach((key) => clear(actor, key));
}

function clearRuntime(actor, key) {
    if (!actor?.effectTimers?.[key]) return false;
    clearInterval(actor.effectTimers[key]);
    delete actor.effectTimers[key];
    return true;
}

function clearExpiry(actor, key) {
    if (!actor?.effectExpiryTimers?.[key]) return false;
    clearTimeout(actor.effectExpiryTimers[key]);
    delete actor.effectExpiryTimers[key];
    return true;
}

// The target's own client, the receiver of the packets that describe the
// receiver's own character (AbnormalStatusUpdate, UserInfo): its session, or
// the caster's when the caster is the target. An NPC cast session forwards to
// a nearby player, so its actor is not the receiver; an NPC (a summon among
// them) has no own client: the players who see it get its NpcInfo.
function ownClient(session, target) {
    if (!target || target.fetchKind) return null;
    if (target.session?.dataSendToMe) return target.session;
    return session?.actor === target && session.dataSendToMe ? session : null;
}

// C4 UserInfo (broadcastUserInfo's own half) after a character's effects,
// stats or SP changed: to its own client only, and only for a character (its
// paperdoll is the backpack's).
function sendUserInfo(session, target) {
    const owner = ownClient(session, target);
    if (owner && target.backpack?.fetchPaperdollSelfId) owner.dataSendToMe(invoke('GameServer/Network/Response').userInfo(target));
}

function refreshEffects(session, target) {
    const ServerResponse = invoke('GameServer/Network/Response');
    const owner = ownClient(session, target);
    if (owner) {
        owner.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(target));
        owner.dataSendToMe(ServerResponse.shortBuffStatusUpdate.fromActor(target));
    }
    sendUserInfo(session, target);

    const removedNpc = target?.fetchKind && (
        target.state?.fetchDead?.() === true ||
        target.corpseDecayState === 'removed'
    );
    if (target?.fetchKind) {
        if (!removedNpc && session?.dataSendToMeAndOthers) {
            session.dataSendToMeAndOthers(ServerResponse.npcInfo(target), target);
        }
    } else if (target?.session?.dataSendToOthers && target?.backpack?.fetchPaperdollSelfId) {
        target.session.dataSendToOthers(ServerResponse.charInfo(target), target);
    }

    try {
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        if (target?.session) PartyCompanionService.updateActorEffects(target.session);
    } catch (err) {
        utils.infoWarn('EffectTicker', 'party effect refresh failed: %s', err.message);
    }
}

function scheduleExpiry(session, target, effect) {
    if (!target || !effect?.key || !effect.expiresAt) return false;

    const delay = Number(effect.expiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return false;

    const timers = ensureExpiryTimers(target);
    clearExpiry(target, effect.key);
    timers[effect.key] = setTimeout(() => {
        if (target.effectExpiryTimers?.[effect.key]) {
            delete target.effectExpiryTimers[effect.key];
        }

        const EffectStore = invoke('GameServer/Effects/EffectStore');
        EffectStore.prune(target);
        clearRuntime(target, effect.key);
        if (target.activeBuffs?.[effect.key] && target.activeBuffs[effect.key] <= Date.now()) {
            delete target.activeBuffs[effect.key];
        }
        // Same order as the manual removals: remove, cleanupState, refresh. An
        // expired non-toggle effect (Dance of Shadow) may carry silentMoving
        // that a toggle turned off earlier left standing; it recomputes the flag
        // from the store and is a no-op for effects without such stats.
        invoke('GameServer/Skills/ToggleSkills').cleanupState(session, target, effect);
        if (Object.keys(effect.stats || {}).length > 0 || effect.conditionalStats?.length > 0) {
            refreshStats(target.session || session, target);
        }
        refreshEffects(session, target);
        // A bot's last hunting buff ended: its rebuff decision hears it (HotTownRebuff).
        try {
            if (invoke('GameServer/Bot/AI/BotBuffs').rebuffable(effect)) invoke('GameServer/Bot/AI/HotTownRebuff').buffEnded(target);
        } catch (error) { FailureLog.note('effect.buffs_expired', error); }
    }, Math.max(1, delay + 25));
    if (typeof timers[effect.key].unref === 'function') {
        timers[effect.key].unref();
    }
    return true;
}

function applyDot(session, source, target, effect) {
    const dot = effect?.dot;
    if (!target || !effect?.key || !dot) return false;

    const damage = Math.max(0, Number(dot.damage) || 0);
    const intervalMs = Math.max(1, Number(dot.intervalMs) || 3000);
    const kills = dot.kills === true;
    let remaining = Math.max(0, Number(dot.count) || 0);
    if (!damage || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clearRuntime(target, effect.key);
            return;
        }

        applyDamage(session, source, target, damage, kills);
        remaining -= 1;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    return true;
}

function applyHot(session, source, target, effect) {
    const hot = effect?.hot;
    if (!target || !effect?.key || !hot) return false;

    const heal = Math.max(0, Number(hot.heal) || 0);
    const intervalMs = Math.max(1, Number(hot.intervalMs) || 1000);
    let remaining = Math.max(0, Number(hot.remaining ?? hot.count) || 0);
    if (!heal || !remaining) return false;

    if (hot.sourceId === undefined) {
        hot.sourceId = source?.fetchKind ? 0 : Number(source?.fetchId?.() || 0);
        hot.sourceClanId = Number(source?.fetchClanId?.() || 0);
        hot.sourceArena = !!source && invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(source);
    }
    const helper = source && Number(source.fetchId?.()) === hot.sourceId ? source : hot.sourceId > 0
        ? { fetchId: () => hot.sourceId, fetchClanId: () => hot.sourceClanId || 0,
            session: { arenaEphemeral: hot.sourceArena === true } } : null;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        // The expiry timer owns the cutoff. The final periodic heal is due at
        // expiresAt itself, just like the final DoT/MP tick.
        if (target.state?.fetchDead?.()) {
            clearRuntime(target, effect.key);
            return;
        }

        const before = { hp: Number(target.fetchHp?.() || 0), maxHp: Number(target.fetchMaxHp?.() || 0),
            combat: target.state?.fetchCombats?.() === true };
        applyHeal(target, heal);
        if (helper) invoke('GameServer/Social/CombatHelpMemory').recordPeriodic(helper, target,
            target.fetchHp() - before.hp, before, hot);
        remaining -= 1;
        hot.remaining = remaining;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    return true;
}

function applyManaDot(session, source, target, effect) {
    const manaDot = effect?.manaDot;
    if (!target || !effect?.key || !manaDot) return false;

    const damage = Math.max(0, Number(manaDot.damage) || 0);
    const intervalMs = Math.max(1, Number(manaDot.intervalMs) || 1000);
    let remaining = Math.max(0, Number(manaDot.count) || 0);
    if (!damage || (!remaining && !manaDot.toggle)) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clearRuntime(target, effect.key);
            const EffectStore = invoke('GameServer/Effects/EffectStore');
            EffectStore.remove(target, effect.key);
            invoke('GameServer/Skills/ToggleSkills').cleanupState(session, target, effect);
            return;
        }

        if (manaDot.requiresSeated && !target.state?.fetchSeated?.()) {
            clearRuntime(target, effect.key);
            const EffectStore = invoke('GameServer/Effects/EffectStore');
            EffectStore.remove(target, effect.key);
            invoke('GameServer/Skills/ToggleSkills').cleanupState(session, target, effect);
            refreshStats(target.session || session, target);
            refreshEffects(session, target);
            return;
        }

        if (manaDot.stopAtFullHp && Number(target.fetchHp?.()) >= Number(target.fetchMaxHp?.())) {
            clearRuntime(target, effect.key);
            const EffectStore = invoke('GameServer/Effects/EffectStore');
            EffectStore.remove(target, effect.key);
            invoke('GameServer/Skills/ToggleSkills').cleanupState(session, target, effect);
            refreshStats(target.session || session, target);
            refreshEffects(session, target);
            return;
        }

        // Lisvus EffectMpConsumePerLevel: the XML value is a coefficient,
        // scaled by the character's current level and the period in seconds.
        const consume = manaDot.perLevel
            ? Math.max(0, (Number(target.fetchLevel?.()) || 1) - 1) / 7.5 * damage * (intervalMs / 1000)
            : damage;
        if (manaDot.toggle && consume > (Number(target.fetchMp?.()) || 0)) {
            clearRuntime(target, effect.key);
            const EffectStore = invoke('GameServer/Effects/EffectStore');
            EffectStore.remove(target, effect.key);
            invoke('GameServer/Skills/ToggleSkills').cleanupState(session, target, effect);
            refreshStats(target.session || session, target);
            refreshEffects(session, target);
            return;
        }

        applyManaDamage(target, consume);
        if (manaDot.toggle) return;

        remaining -= 1;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    if (typeof timers[effect.key].unref === 'function') {
        timers[effect.key].unref();
    }
    return true;
}

function applyHealthDot(session, source, target, effect) {
    const healthDot = effect?.healthDot;
    if (!target || !effect?.key || !healthDot) return false;

    const damage = Math.max(0, Number(healthDot.damage) || 0);
    const intervalMs = Math.max(1, Number(healthDot.intervalMs) || 1000);
    if (!damage) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        const currentHp = Math.max(0, Number(target.fetchHp?.()) || 0);
        const taken = HitRules.dotTickDamage(currentHp, damage);
        // Lisvus EffectDamOverTime: a toggle whose tick would reach the 1 HP floor ends.
        if (target.state?.fetchDead?.() || currentHp - taken <= 1) {
            clearRuntime(target, effect.key);
            const EffectStore = invoke('GameServer/Effects/EffectStore');
            EffectStore.remove(target, effect.key);
            invoke('GameServer/Skills/ToggleSkills').cleanupState(session, target, effect);
            refreshStats(target.session || session, target);
            refreshEffects(session, target);
            return;
        }

        target.setHp(currentHp - taken);
        if (target.statusUpdateVitals) target.statusUpdateVitals(target);
        else if (target.broadcastVitals) target.broadcastVitals();
    }, intervalMs);
    if (typeof timers[effect.key].unref === 'function') timers[effect.key].unref();
    return true;
}

function applyManaHot(session, source, target, effect) {
    const manaHot = effect?.manaHot;
    if (!target || !effect?.key || !manaHot) return false;

    const heal = Math.max(0, Number(manaHot.heal) || 0);
    const intervalMs = Math.max(1, Number(manaHot.intervalMs) || 1000);
    let remaining = Math.max(0, Number(manaHot.count) || 0);
    if (!heal || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clearRuntime(target, effect.key);
            return;
        }

        applyManaHeal(target, heal);
        remaining -= 1;
        if (remaining <= 0) {
            clearRuntime(target, effect.key);
        }
    }, intervalMs);
    return true;
}

// Is a tick's caster still a body in the world? A character or a monster while
// it is its session's body (a logout, a bot cooled or a new body on the session
// leaves it behind). A servitor or a pet casts through a relay session that
// keeps it as its body for good: it is there while its owner, a body in the
// world, still has it out (an unsummon or the owner's teardown ends that).
function casterPresent(session, source) {
    if (!session || !source || session.actor !== source) return false;
    if (source.fetchIsSummon?.() !== true && source.fetchIsPet?.() !== true) return true;
    const owner = invoke('GameServer/Bot/AI/BotPvpThreats').character(source);
    return !!owner && invoke('GameServer/Npc/SummonControl').activeSummon(owner) === source;
}

// One damage-over-time tick. It never takes the target's last HP point
// (HitRules.dotTickDamage, Lisvus EffectDamOverTime); only Poison of Death
// kills. It is its caster's hit while the caster is a body in the world. A
// tick of the target's own effect, or after its caster left (logout, a bot
// cooled, a new body on the session, a servitor unsummoned), is nobody's hit,
// as C4's effect ticks on after its effector left: a character keeps its own
// damage rules without an attacker (it wakes and stands up; no hate, kill or
// reward goes to anyone), an NPC loses HP and regenerates.
function applyDamage(session, source, target, damage, kills = false) {
    if (invoke('GameServer/Effects/EffectStore').hasDebuff(target, 'petrification')) return;
    const taken = HitRules.dotTickDamage(target.fetchHp(), damage, kills);
    if (!(taken > 0)) return;
    const character = Number(target.fetchId?.()) >= 2000000;
    if (source !== target && casterPresent(session, source)) {
        if (character) invoke(path.actor).receivedHit(session, target, taken, { wakeSleep: true, source });
        // Lisvus keeps an attackable NPC asleep when it takes DOT damage.
        else invoke(path.npc).receivedHit(session, source, target, taken, { wakeSleep: false });
        return;
    }
    if (character) {
        invoke(path.actor).receivedHit(target.session || (session?.actor === target ? session : null), target, taken,
            { wakeSleep: true, source: null });
        return;
    }
    target.setHp(target.fetchHp() - taken);
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
    target.automation?.replenishVitals?.(target);
}

function applyManaDamage(target, damage) {
    const currentMp = Number(target.fetchMp?.()) || 0;
    target.setMp(Math.max(0, currentMp - damage));
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

// A stat effect came or went: the character's stats are rebuilt and its
// vitals sent (StatusUpdate). Its UserInfo goes with the effect refresh that
// follows (refreshEffects, by the own-client rule). A toggle's MP tick sends
// only the StatusUpdate of its MP loss (applyManaDamage), as C4's
// EffectMpConsumePerLevel.
function refreshStats(session, target) {
    if (target?.session) {
        try {
            invoke(path.actor).calculateStats(target?.session || session, target);
        } catch (error) { FailureLog.note('combat.recalc_stats', error); }
    }
    target?.statusUpdateVitals?.(target);
}

function applyManaHeal(target, heal) {
    const currentMp = Number(target.fetchMp?.()) || 0;
    const maxMp = Number(target.fetchMaxMp?.()) || 0;
    const nextMp = maxMp > 0 ? Math.min(maxMp, currentMp + heal) : currentMp + heal;
    target.setMp(nextMp);
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

function applyHeal(target, heal) {
    const currentHp = Number(target.fetchHp?.()) || 0;
    const maxHp = Number(target.fetchMaxHp?.()) || 0;
    const nextHp = maxHp > 0 ? Math.min(maxHp, currentHp + heal) : currentHp + heal;
    target.setHp(nextHp);
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

module.exports = {
    applyDot,
    applyHealthDot,
    applyManaDot,
    applyManaHot,
    applyHot,
    scheduleExpiry,
    refreshEffects,
    refreshStats,
    sendUserInfo,
    clear,
    clearAll
};
