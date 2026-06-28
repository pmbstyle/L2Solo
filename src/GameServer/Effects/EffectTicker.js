function ensureTimers(actor) {
    if (!actor.effectTimers) actor.effectTimers = {};
    return actor.effectTimers;
}

function clear(actor, key) {
    if (!actor?.effectTimers?.[key]) return false;
    clearInterval(actor.effectTimers[key]);
    delete actor.effectTimers[key];
    return true;
}

function applyDot(session, source, target, effect) {
    const dot = effect?.dot;
    if (!target || !effect?.key || !dot) return false;

    const damage = Math.max(0, Number(dot.damage) || 0);
    const intervalMs = Math.max(1, Number(dot.intervalMs) || 3000);
    let remaining = Math.max(0, Number(dot.count) || 0);
    if (!damage || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clear(target, effect.key);
            return;
        }

        applyDamage(session, source, target, damage);
        remaining -= 1;
        if (remaining <= 0) {
            clear(target, effect.key);
        }
    }, intervalMs);
    return true;
}

function applyHot(session, source, target, effect) {
    const hot = effect?.hot;
    if (!target || !effect?.key || !hot) return false;

    const heal = Math.max(0, Number(hot.heal) || 0);
    const intervalMs = Math.max(1, Number(hot.intervalMs) || 1000);
    let remaining = Math.max(0, Number(hot.count) || 0);
    if (!heal || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clear(target, effect.key);
            return;
        }

        applyHeal(target, heal);
        remaining -= 1;
        if (remaining <= 0) {
            clear(target, effect.key);
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
    if (!damage || !remaining) return false;

    const timers = ensureTimers(target);
    clear(target, effect.key);
    timers[effect.key] = setInterval(() => {
        if (target.state?.fetchDead?.()) {
            clear(target, effect.key);
            return;
        }

        applyManaDamage(target, damage);
        remaining -= 1;
        if (remaining <= 0) {
            clear(target, effect.key);
        }
    }, intervalMs);
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
            clear(target, effect.key);
            return;
        }

        applyManaHeal(target, heal);
        remaining -= 1;
        if (remaining <= 0) {
            clear(target, effect.key);
        }
    }, intervalMs);
    return true;
}

function applyDamage(session, source, target, damage) {
    if (session && source && target?.fetchId && source !== target) {
        if (target.fetchId() >= 2000000) {
            invoke(path.actor).receivedHit(session, target, damage);
        } else {
            invoke(path.npc).receivedHit(session, source, target, damage);
        }
        return;
    }

    target.setHp(Math.max(0, target.fetchHp() - damage));
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
}

function applyManaDamage(target, damage) {
    const currentMp = Number(target.fetchMp?.()) || 0;
    target.setMp(Math.max(0, currentMp - damage));
    if (target.statusUpdateVitals) target.statusUpdateVitals(target);
    else if (target.broadcastVitals) target.broadcastVitals();
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
    applyManaDot,
    applyManaHot,
    applyHot,
    clear
};
