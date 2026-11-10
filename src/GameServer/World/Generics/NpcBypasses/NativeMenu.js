const Response = invoke('GameServer/Network/Response');
const PREFIX = 'L2SOLO_MENU_V1\n';
// Curated no-target, no-argument player commands. Dispatch through chat's
// canonical handlers so their gameplay checks and messages stay identical.
const COMMANDS = Object.freeze([
    [1, 'windows', 'Party control', '.b', 'Orders for your companions.'],
    [2, 'windows', 'Find party', '.bp', 'Find and invite companions.'],
    [3, 'windows', 'Bot friends', '.bf', 'Friends and your constant party.'],
    [4, 'windows', 'Bot status', '.bs', 'Browse bots or inspect your selection.'],
    [5, 'windows', 'Item database', '.items', 'Items, drops, spoil and spawn maps.'],
    [6, 'trade', 'AFK sell shop', '.afksell', 'Configure a shop in a town.'],
    [7, 'trade', 'AFK buy shop', '.afkbuy', 'Configure buy orders in a town.'],
    [8, 'trade', 'Stop AFK shop', '.afkstop', 'Close your active AFK shop.'],
    [9, 'trade', 'Sell unused items', '.sell', 'Immediately sell eligible unequipped items.'],
    [10, 'actions', 'Dismiss companions', '.leave', 'Release bots from your party.'],
    [11, 'actions', 'Start arena duel', '.go', 'Prepared opponent; enter arena first.']
].map(([id, group, label, command, hint]) => Object.freeze({ id, group, label, command, hint })));
const GROUPS = { windows: 'Windows', trade: 'Trade', actions: 'Party / Arena' };
function render(session) {
    if (session.nativeMenuVersion === 1) {
        const lines = [['state', session.nativeMenuEpoch, ++session.nativeMenuRevision, COMMANDS.length].join('\t')];
        for (const r of COMMANDS) lines.push(['command', r.id, r.group, r.label, r.command, r.hint].join('\t'));
        session.dataSendToMe(Response.npcHtml(0, PREFIX + lines.join('\n')));
    } else {
        let html = '<html><title>Server Menu</title><body>';
        let group;
        for (const r of COMMANDS) {
            if (group !== r.group) { group = r.group; html += `<br><font color="LEVEL">${GROUPS[group]}</font><br>`; }
            html += `<button value="${r.label}" action="bypass -h native-menu run ${session.nativeMenuEpoch} ${r.id}" width=200 height=23 back="L2UI_ch3.Btn1_normalOn" fore="L2UI_ch3.Btn1_normal"><br1>${r.command} - ${r.hint}<br>`;
        }
        session.dataSendToMe(Response.npcHtml(0, html + '</body></html>'));
    }
}
function open(session) {
    if (!session?.actor) return;
    session.nativeMenuEpoch = (session.nativeMenuEpoch || 0) + 1;
    session.nativeMenuRevision = 0;
    session.nativeMenuOpen = true;
    render(session);
}
function handler(session, parts) {
    if (!session?.actor || !session.nativeMenuOpen) return;
    if (parts[1] === 'open' && parts.length === 3 && ['0', '1'].includes(parts[2])) {
        session.nativeMenuVersion = Number(parts[2]);
        return render(session);
    }
    if (parts[1] === 'close' && parts.length === 3 && String(session.nativeMenuEpoch) === parts[2]) {
        session.nativeMenuOpen = false;
        return;
    }
    if (parts[1] !== 'run' || parts.length !== 4 || String(session.nativeMenuEpoch) !== parts[2]) return;
    const entry = COMMANDS.find((r) => String(r.id) === parts[3]);
    if (!entry) return;
    // Consume this menu before executing: duplicated/late clicks cannot repeat
    // a sale or release companions again. A fresh .menu creates a new epoch.
    session.nativeMenuOpen = false;
    return invoke('GameServer/Network/Request/Speak').consume(session, { kind: 0, text: entry.command });
}
handler.open = open;
handler.COMMANDS = COMMANDS;
handler.PREFIX = PREFIX;
module.exports = handler;
