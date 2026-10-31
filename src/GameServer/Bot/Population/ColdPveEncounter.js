// One bounded record per solo actor / party. No live actor, timer or world scan.
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SLICES = 20;
// The fight's own: the step's target may move, the engaged mob does not.
function key(members, spot, partyId = '') {
    return JSON.stringify([partyId, spot?.id,
        members.map(s => [s.characterId, s.loc?.locX, s.loc?.locY, s.loc?.locZ, s.timing?.lastHotAt])
            .sort((a, b) => a[0] - b[0])]);
}
function read(record, encounterKey, timestamp, options = {}) {
    const maxSlices = Math.max(1, Number(options.maxSlices || MAX_SLICES));
    return record?.version === 1 && record.key === encounterKey && record.hp > 0
        && timestamp >= record.at && timestamp - record.at <= MAX_AGE_MS
        && record.slices < maxSlices ? record : null;
}
// The bot's own fight still goes on: a round for it comes before any other act.
function pending(state, timestamp) {
    const record = state?.stats?.pveEncounter;
    return !!record && !!read(record, record.key, timestamp);
}
// A wanted trip waits for the engaged fight and for no other: the round then
// starts no new one (lastFight), so the next step is clean. A flight from ground
// the bot may not hunt does not wait: a hot bot leaves it under a mob (HuntingState).
function holdsTrip(subject, route, timestamp) {
    return !!route?.needed && route.reason !== 'unsafe_ground_evacuation' && pending(subject, timestamp);
}
// timestamp: the round that saved it, never a fight's clock inside the round
// (ahead of the next round's start, read would drop the fight).
function save(previous, encounterKey, mob, hp, timestamp, timers) {
    return { version: 1, key: encounterKey, mob, hp: Math.max(0, hp), at: timestamp,
        slices: Number(previous?.slices || 0) + 1, ...timers };
}
module.exports = { key, read, pending, holdsTrip, save, MAX_SLICES };
