// Conflict warnings have their own bounded budget; ambient conversation
// cannot silently cancel a combat decision.
const recent = [];
const SPEAKER_MS = 30000, AREA_MS = 5000, MAX_RECENT = 256;
function canSend(session, _key, now = Date.now()) {
    while (recent.length && now - recent[0].at >= SPEAKER_MS) recent.shift();
    if (recent.filter(entry => now - entry.at < AREA_MS).length >= 6) return false;
    return !recent.some(entry => entry.id === session.actor.fetchId() ||
        (now - entry.at < AREA_MS && Math.hypot(entry.x - session.actor.fetchLocX(), entry.y - session.actor.fetchLocY()) < 2000));
}
function record(session, _key, now = Date.now()) {
    recent.push({ id: session.actor.fetchId(), x: session.actor.fetchLocX(), y: session.actor.fetchLocY(), at: now });
    if (recent.length > MAX_RECENT) recent.shift();
}
module.exports = { canSend, record, reset() { recent.length = 0; }, SPEAKER_MS, AREA_MS };
