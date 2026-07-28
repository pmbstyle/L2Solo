const SendPacket = invoke('Packet/Send');

// C4 NpcHtmlMessage is limited to 8192 characters.  The original server
// explicitly rejects a longer body because the client can crash while parsing
// it; UI callers should paginate before they reach this guard.
const MAX_NPC_HTML_LENGTH = 8192;

function npcHtml(id, html) {
    const packet = new SendPacket(0x0f);
    const source = String(html || '');
    const safeHtml = source.length > MAX_NPC_HTML_LENGTH
        ? '<html><body>Page is too large. Please reopen this window.</body></html>'
        : source;

    if (source.length > MAX_NPC_HTML_LENGTH) {
        utils.infoWarn('NpcHtml', 'blocked oversized C4 HTML id=%d chars=%d limit=%d', id, source.length, MAX_NPC_HTML_LENGTH);
    }

    packet
        .writeD(id)
        .writeS(safeHtml)
        .writeD(0);

    const buffer = packet.fetchBuffer();
    buffer.__packetTrace = `id=${id}:chars=${safeHtml.length}${safeHtml === source ? '' : ':truncated'}`;
    return buffer;
}

module.exports = npcHtml;
module.exports.MAX_NPC_HTML_LENGTH = MAX_NPC_HTML_LENGTH;
