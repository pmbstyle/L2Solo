// UTF-16 text carried by C4 NpcHtml (0x0f), only after explicit UI negotiation.
// Tabs/newlines delimit records; display strings cannot introduce records.
const PREFIX = 'L2SOLO_PARTY_V1\n';
const PREFIX_V2 = 'L2SOLO_PARTY_V2\n';
const PREFIX_V3 = 'L2SOLO_PARTY_V3\n';
const MAX_MEMBERS = 8;
function text(value, limit = 64) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
}
function encode(settings, members, options = {}) {
    const version = [2, 3].includes(options.version) ? options.version : 1;
    const rows = members.slice(0, MAX_MEMBERS);
    const combat = ['assist', 'protect', 'passive'].includes(settings.combatMode) ? settings.combatMode : 'assist';
    const movement = settings.movementMode === 'hold' ? 'hold' : 'follow';
    const pull = ['auto', 'leader', 'off', 'bot'].includes(settings.pullMode) ? settings.pullMode : 'auto';
    const lines = [`state\t${combat}\t${movement}\t${pull}\t${rows.length}\t${options.open === true ? 1 : 0}`];
    if (version >= 2) lines[0] += `\t${settings.lootPickupEnabled === false ? 0 : 1}`;
    for (const member of rows) {
        const fields = [
            'member', member.id, text(member.name, 32), member.level,
            text(member.className, 40), text(member.role, 16), member.stance,
            text(member.order, 64), text(member.note, 64), member.canPull ? 1 : 0
        ];
        if (version === 3) fields.push(Number.isInteger(member.classId) && member.classId >= 0 && member.classId <= 136 ? member.classId : -1);
        lines.push(fields.join('\t'));
    }
    const payload = ({ 1: PREFIX, 2: PREFIX_V2, 3: PREFIX_V3 })[version] + lines.join('\n');
    if (payload.length > 8192) throw new Error('Native party snapshot exceeds C4 HTML capacity');
    return payload;
}
module.exports = { PREFIX, PREFIX_V2, PREFIX_V3, MAX_MEMBERS, encode };
