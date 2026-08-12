const ServerResponse = invoke('GameServer/Network/Response');

// C4 keeps force/sonic charges for ten minutes from the first charge in the
// current stack. Adding more charges does not refresh that deadline.
const EXPIRY_MS = 600000;

function current(actor) {
    return Math.max(0, Number(actor?.fetchCharges?.() ?? actor?.charges ?? 0) || 0);
}

function set(actor, value) {
    const next = Math.max(0, Number(value) || 0);
    if (typeof actor?.setCharges === 'function') actor.setCharges(next);
    else if (actor) actor.charges = next;
    return next;
}

function notify(session, actor) {
    if (!actor) return;
    const packet = ServerResponse.etcStatusUpdate(actor);
    if (actor.session?.dataSendToMe) actor.session.dataSendToMe(packet);
    else session?.dataSendToMe?.(packet);
}

function cancelExpiry(actor) {
    if (!actor) return;
    if (actor.chargeExpiryTimer) clearTimeout(actor.chargeExpiryTimer);
    delete actor.chargeExpiryTimer;
    delete actor.chargeExpiresAt;
}

function startExpiry(session, actor) {
    cancelExpiry(actor);
    actor.chargeExpiresAt = Date.now() + EXPIRY_MS;
    actor.chargeExpiryTimer = setTimeout(() => {
        delete actor.chargeExpiryTimer;
        delete actor.chargeExpiresAt;
        if (current(actor) <= 0) return;
        set(actor, 0);
        notify(session, actor);
    }, EXPIRY_MS);
    actor.chargeExpiryTimer.unref?.();
}

function increase(session, actor, amount, maxCharges) {
    const previous = current(actor);
    const increment = Math.max(0, Number(amount) || 0);
    const maximum = Math.max(0, Number(maxCharges) || 0);
    const next = maximum > 0
        ? Math.min(maximum, previous + increment)
        : previous + increment;
    if (next === previous) return next;
    set(actor, next);
    if (previous === 0 && next > 0) startExpiry(session, actor);
    notify(session, actor);
    return next;
}

function consume(session, actor, amount) {
    const previous = current(actor);
    const required = Math.max(0, Number(amount) || 0);
    if (previous < required) return { ok: false, previous, next: previous };
    const next = set(actor, previous - required);
    if (next === 0) cancelExpiry(actor);
    if (required > 0) notify(session, actor);
    return { ok: true, previous, next };
}

function clear(session, actor) {
    const previous = current(actor);
    cancelExpiry(actor);
    set(actor, 0);
    if (previous > 0) notify(session, actor);
    return previous;
}

function dispose(actor) {
    cancelExpiry(actor);
}

module.exports = {
    EXPIRY_MS,
    current,
    increase,
    consume,
    clear,
    dispose
};
