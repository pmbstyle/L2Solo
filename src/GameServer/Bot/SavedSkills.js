'use strict';

// The saved form of a cold kit's skill records (stats.coldCombat.skills in
// bot_life_state.statsJson). Each record is the learned rank's data
// (ColdCombatProfile.skillSnapshotsFromRecords), ~280 B of JSON; a kit whose
// every record is exactly its rank's record is saved as its ranks,
// [[selfId, level], ...] (7.3 KB -> 0.2 KB of a ~20 KB row: the whole row is
// rewritten on every save), any other kit stays whole. pack/packKit/packStats
// are the writers' (SavedStats.compact, Database's kit rebuild); unpack/
// unpackKit the readers' (SavedStats.merge and body, the clan candidate
// trigger, raw kit reads). The positional pair lives only here.
// An unpacked record is the current data's record of that rank, frozen and
// shared (as the worker's SkillDtoInterner shares them), so a kit read back
// equals the kit written while the skill data is the same, and packing it
// again is an identity test per record; after a data change it is the rebuilt
// kit (a rank the data no longer has is dropped, as the rebuild from the
// learned rows drops it).

// The records by rank (selfId * 4096 + level), for one skill data array; the
// key is all a record reads. Bounded by the ranks in the data.
let records = new Map(), recordsData = null, dataCache = null, Profile = null;
const LEVELS = 4096;
// The record fields in their order (ColdCombatProfile skillSnapshot).
const { FIELDS } = require('./Population/SkillDtoInterner');

// Called once per pack/unpack: a data reload starts a new map.
function currentRecords() {
    dataCache ||= invoke('GameServer/DataCache');
    if (recordsData !== dataCache.skills) { records = new Map(); recordsData = dataCache.skills; }
    return records;
}

function record(byRank, selfId, level) {
    const key = selfId * LEVELS + level;
    let found = byRank.get(key);
    if (found === undefined) {
        Profile ||= require('./Population/ColdCombatProfile');
        found = Profile.skillSnapshotsFromRecords([{ selfId, level }])[0] || null;
        if (found) Object.freeze(found);
        byRank.set(key, found);
    }
    return found;
}

// Field for field and in the same key order, as the kit rebuild compares
// (Database heldSkillCurrent): only then does the rank stand for the record.
function same(held, fresh) {
    if (!held || typeof held !== 'object' || Array.isArray(held)) return false;
    let index = 0;
    for (const key in held) {
        if (key !== FIELDS[index++] || held[key] !== fresh[key]) return false;
    }
    return index === FIELDS.length;
}

function packed(skills) {
    return Array.isArray(skills) && skills.length > 0 && Array.isArray(skills[0]);
}

function pack(skills) {
    if (!Array.isArray(skills) || !skills.length || packed(skills)) return skills;
    const byRank = currentRecords(), ranks = new Array(skills.length);
    for (let i = 0; i < skills.length; i++) {
        const selfId = skills[i]?.selfId, level = skills[i]?.level;
        if (!Number.isSafeInteger(selfId) || selfId <= 0 || !Number.isInteger(level) || level < 0 || level >= LEVELS) return skills;
        const found = record(byRank, selfId, level);
        // A rank the data has no record of (a skill gone from the data) keeps the kit whole.
        if (!found || (skills[i] !== found && !same(skills[i], found))) return skills;
        ranks[i] = [selfId, level];
    }
    return ranks;
}

function unpack(skills) {
    if (!packed(skills)) return skills;
    const byRank = currentRecords(), out = [];
    for (const rank of skills) {
        const selfId = Number(rank?.[0]), level = Number(rank?.[1]);
        const found = Number.isSafeInteger(selfId) && Number.isInteger(level) && level >= 0 && level < LEVELS
            ? record(byRank, selfId, level) : null;
        if (found) out.push(found);
    }
    return out;
}

function kit(combat) {
    return combat && typeof combat === 'object' && !Array.isArray(combat) && Array.isArray(combat.skills);
}

// The kit itself when there is nothing to change; else a copy in the same key order.
function packKit(combat) {
    if (!kit(combat)) return combat;
    const skills = pack(combat.skills);
    return skills === combat.skills ? combat : { ...combat, skills };
}

function unpackKit(combat) {
    if (!kit(combat) || !packed(combat.skills)) return combat;
    return { ...combat, skills: unpack(combat.skills) };
}

function packStats(stats) {
    const combat = stats?.coldCombat, saved = packKit(combat);
    return saved === combat ? stats : { ...stats, coldCombat: saved };
}

module.exports = { pack, unpack, packed, packKit, unpackKit, packStats };
