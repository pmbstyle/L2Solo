'use strict';

const PREFIX = 'L2SOLO_PARTY_HUB_V1\n';
const PREFIX_V2 = 'L2SOLO_PARTY_HUB_V2\n';
const NOTE_LIMIT = 64;
const SORTS = Object.freeze(['level_asc', 'level_desc', 'name_asc', 'name_desc']);
const ACTION = Object.freeze({ HOLD: 1, PULL: 2, CALL: 4, LEADER: 8, KICK: 16,
    INVITE: 32, CONST: 64, REMOVE: 128, ADD: 256 });
const text = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);

function encode(state, groups, rows) {
    if (groups.length > 8 || rows.length > 9) throw Error('Party hub record limit exceeded');
    const fields = ['state', state.epoch, state.revision, state.open ? 1 : 0, state.leader ? 1 : 0,
        state.tab, state.scope, state.source, state.page, state.pages, state.total,
        state.groupPage, state.groupPages, state.groupTotal, state.selectedCount,
        state.combat, state.movement, state.pull, state.loot ? 1 : 0,
        text(state.query, 16), state.level, state.role, text(state.message, 96), state.busy ? 1 : 0,
        state.canCreate ? 1 : 0, state.saved ? 1 : 0, groups.length, rows.length];
    if (state.version === 2) fields.push(SORTS.includes(state.sort) ? state.sort : 'level_asc');
    const lines = [fields.join('\t')];
    for (const group of groups) lines.push(['group', group.key, group.leaderId,
        text(group.name, 32), group.count, group.movement].join('\t'));
    for (const row of rows) lines.push(['row', row.id, text(row.name, 32), row.level || 0,
        row.classId ?? -1, text(row.detail, 40), text(row.note, NOTE_LIMIT), row.actions || 0,
        row.selected ? 1 : 0, row.leader ? 1 : 0, row.count || 0, row.expected || 0].join('\t'));
    const payload = (state.version === 2 ? PREFIX_V2 : PREFIX) + lines.join('\n');
    if (payload.length > 8192) throw Error('Party hub snapshot exceeds C4 HTML capacity');
    return payload;
}

module.exports = { PREFIX, PREFIX_V2, SORTS, ACTION, NOTE_LIMIT, encode };
