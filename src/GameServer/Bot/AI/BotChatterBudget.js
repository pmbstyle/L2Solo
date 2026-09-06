// Only unsolicited local chatter uses this budget. Player replies and combat
// coordination have their own delivery rules and must never be dropped here.
const AREA_INTERVAL_MS = 45000;
const SPEAKER_INTERVAL_MS = 120000;
const TOPIC_INTERVAL_MS = 300000;
const AUDIBLE_DISTANCE = 2000;
const MAX_HISTORY = 256;
const recent = [];

function location(session) {
    const actor = session?.actor;
    const x = Number(actor?.fetchLocX?.());
    const y = Number(actor?.fetchLocY?.());
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function canSend(session, key, now = Date.now()) {
    if (!session?.actor) return false;
    while (recent.length && now - recent[0].at >= TOPIC_INTERVAL_MS) recent.shift();
    const point = location(session);
    return !recent.some((entry) => {
        const sameSpeaker = entry.id === (session.actor.fetchId?.() || session);
        const nearby = point && entry.point &&
            Math.hypot(point.x - entry.point.x, point.y - entry.point.y) < AUDIBLE_DISTANCE;
        const age = now - entry.at;
        return (sameSpeaker && age < SPEAKER_INTERVAL_MS) ||
            (nearby && now < entry.quietUntil) ||
            ((sameSpeaker || nearby) && key !== 'conversation' && entry.key === key && age < TOPIC_INTERVAL_MS);
    });
}

function record(session, key, now = Date.now(), reply = false) {
    const point = location(session);
    let quietUntil = now + AREA_INTERVAL_MS;
    if (reply && point) {
        for (const entry of recent) {
            if (entry.point && Math.hypot(point.x - entry.point.x, point.y - entry.point.y) < AUDIBLE_DISTANCE) {
                quietUntil = Math.max(quietUntil, entry.quietUntil + AREA_INTERVAL_MS);
            }
        }
    }
    recent.push({ id: session.actor.fetchId?.() || session, point, key, at: now, quietUntil });
    if (recent.length > MAX_HISTORY) recent.shift();
}

function canReply(session, now = Date.now()) {
    const id = typeof session === 'number' ? session : session?.actor?.fetchId?.() || session;
    return !recent.some(entry => entry.id === id && now - entry.at < SPEAKER_INTERVAL_MS);
}

function recordSpeaker(id, now = Date.now()) {
    // A global line occupies this speaker, but must not silence the town
    // where its hot actor happens to be standing.
    recent.push({ id, point: null, key: 'global', at: now, quietUntil: now });
    if (recent.length > MAX_HISTORY) recent.shift();
}

module.exports = { canSend, canReply, record, recordSpeaker, reset() { recent.length = 0; }, AREA_INTERVAL_MS, SPEAKER_INTERVAL_MS, TOPIC_INTERVAL_MS };
