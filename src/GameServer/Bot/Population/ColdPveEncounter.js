// One bounded record per solo actor / party. No live actor, timer or world scan.
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SLICES = 20;
function key(members, spot, targetNpcId, partyId = '') {
    return JSON.stringify([partyId, spot?.id, Number(targetNpcId || 0),
        members.map(s => [s.characterId, s.loc?.locX, s.loc?.locY, s.loc?.locZ, s.timing?.lastHotAt])
            .sort((a, b) => a[0] - b[0])]);
}
function read(record, encounterKey, timestamp, options = {}) {
    const maxSlices = Math.max(1, Number(options.maxSlices || MAX_SLICES));
    return record?.version === 1 && record.key === encounterKey && record.hp > 0
        && timestamp >= record.at && timestamp - record.at <= MAX_AGE_MS
        && record.slices < maxSlices ? record : null;
}
function save(previous, encounterKey, mob, hp, timestamp, timers) {
    return { version: 1, key: encounterKey, mob, hp: Math.max(0, hp), at: timestamp,
        slices: Number(previous?.slices || 0) + 1, ...timers };
}
module.exports = { key, read, save, MAX_SLICES };
