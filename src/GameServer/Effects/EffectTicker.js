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

module.exports = {
    applyDot,
    clear
};
