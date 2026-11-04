'use strict';

// One original identity for a concrete optional native step. The DB owns the
// protected receipt (the stats leaf) and the pending intent (its own table,
// never in a state); this module keeps no per-owner result cache or history.
const { randomUUID } = require('node:crypto');
const KINDS = Object.freeze({ craft: 1, learn: 2, npcBuy: 3, afkBuy: 4, afkSell: 5 });
const MAX_BYTES = 384;
const MAX_ACTIVE = 64;
// Original in-flight identities only, released on native return/refusal. No
// results or forecast graph; restart recovers through the one durable tuple.
const active = new Map();
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
function header(id, kind, sequence, authority) {
    if (!validId(id) || !Object.values(KINDS).includes(kind)
        || !Number.isSafeInteger(sequence) || sequence < 0) throw Error('invalid_economy_command');
    const result = [id, kind, sequence];
    Object.defineProperty(result, 'authority', { value: Object.freeze({ ...authority }) });
    return Object.freeze(result);
}
function create(kind, sequence, authority) { return header(randomUUID(), kind, sequence, authority); }
function valid(tuple) {
    return Array.isArray(tuple) && tuple.length === 10 && Number.isSafeInteger(tuple[0]) && tuple[0] >= 0
        && (tuple[1] === 0 || tuple[1] === 1) && validId(tuple[2]) && Object.values(KINDS).includes(tuple[3])
        && (tuple[4] === 0 || tuple[4] === 1) && tuple.slice(5, 9).every(value => Number.isSafeInteger(value) && value >= 0)
        && (tuple[9] === null || Number.isFinite(tuple[9]) && tuple[9] >= 0)
        && Buffer.byteLength(JSON.stringify(tuple)) <= MAX_BYTES;
}
function pending(command) { return [command[2], 0, command[0], command[1], 0, 0, 0, 0, 0, null]; }
function completed(command, result = {}) {
    const tuple = [command[2] + 1, 1, command[0], command[1], result.success === false ? 0 : 1,
        Number(result.units ?? result.amount ?? 0), Number(result.spent || 0), Number(result.received || 0),
        Number(result.nativeId || 0), result.mp == null ? null : Number(result.mp)];
    if (!valid(tuple)) throw Error('invalid_economy_completion');
    return tuple;
}
function result(tuple) {
    if (!valid(tuple) || tuple[1] !== 1) throw Error('economy_completion_missing');
    return { committed: true, replayed: true, success: tuple[4] === 1, units: tuple[5], amount: tuple[5],
        spent: tuple[6], received: tuple[7], nativeId: tuple[8], mp: tuple[9], economyCommit: tuple };
}
// A bot's authority: its phase, simulation revision and hot time. Any main
// or worker write moves the revision, so no owner or loan is compared.
function authority(state) {
    return { phase: state?.phase, revision: Number(state?.simulation?.revision || 0),
        hotAt: Number(state?.timing?.lastHotAt || 0) };
}
function sameAuthority(left, right) {
    return !!left && !!right && left.phase === right.phase && left.revision === right.revision && left.hotAt === right.hotAt;
}
function acceptRow(row) {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const current = LifeState.cachedState(Number(row.characterId));
    const stats = typeof row.statsJson === 'string' ? JSON.parse(row.statsJson || '{}') : row.statsJson || {};
    const saved = stats.economyCommit;
    if (current && (Number(current.simulation?.revision || 0) > Number(row.simulationRevision || 0)
        || Number(current.timing?.lastHotAt || 0) > Number(row.lastHotAt || 0)
        || Number(current.updatedAt || 0) > Number(row.updatedAt || 0)
        || valid(current.stats?.economyCommit) && valid(saved) && current.stats.economyCommit[0] > saved[0])) return current;
    return LifeState.acceptLifecycleRow(row);
}
async function admit(state, kind, original = null) {
    const Database = invoke('Database');
    const id = Number(state.characterId);
    if (active.has(id)) throw Error('economy_operation_in_flight');
    if (!active.has(id) && active.size >= MAX_ACTIVE) throw Error('economy_admission_pressure');
    const reservation = {};
    active.set(id, reservation);
    let admitted;
    try {
        admitted = await Database.admitEconomyCommand(id, kind, {
            authority: authority(state), original,
            // Replacing a completed receipt requires the native result already
            // reconciled into the accepted current holdings, not a guessed success.
            acknowledged: state.stats?.economyCommit
        });
        active.set(id, admitted.command);
    } catch (error) {
        if (active.get(id) === reservation) active.delete(id);
        throw error;
    }
    let current;
    try { current = admitted.row ? acceptRow(admitted.row) : state; }
    catch (error) { finish(id, admitted.command); throw error; }
    return { command: admitted.command, state: current, recovered: admitted.recovered || null };
}
// The one SQL rule for the leaf on a bot_life_state write of a whole stats
// JSON (`incoming`, an SQL expression): the row's leaf stays, a leaf the row
// does not hold is dropped. json_patch with a NULL member removes the key.
function preserveLeafSql(incoming) {
    return `json_patch(${incoming}, json_object('economyCommit', json_extract(bot_life_state.statsJson, '$.economyCommit')))`;
}
function finish(characterId, command) {
    const value = active.get(Number(characterId));
    // A retry may rebind the same UUID to a newer native owner. Its older
    // caller returning must not release that newer in-flight reservation.
    if (value === command) active.delete(Number(characterId));
}
function forget(characterId) { active.delete(Number(characterId)); }

module.exports = { KINDS, MAX_BYTES, MAX_ACTIVE, create, header, valid, pending, completed, result, authority, sameAuthority, admit,
    acceptRow, preserveLeafSql, finish, forget, clear: () => active.clear(), size: () => active.size };
