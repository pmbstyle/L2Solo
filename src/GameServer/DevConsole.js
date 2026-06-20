const readline = require('readline');
const ServerResponse = invoke('GameServer/Network/Response');

const ALICE_ACTOR = {
    fetchId: () => 900000001,
    fetchName: () => 'Alice'
};

function isRealPlayer(session) {
    return session?.actor && session?.socket && !String(session.accountId || '').startsWith('bot_');
}

function playerName(session) {
    return session?.actor?.fetchName ? session.actor.fetchName() : '';
}

function realPlayers() {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).filter(isRealPlayer);
}

function sendTell(session, text) {
    const clean = String(text || '').trim().slice(0, 180);
    if (!session || !clean) return false;
    session.dataSendToMe(ServerResponse.speak(ALICE_ACTOR, { kind: 2, text: clean }));
    return true;
}

function sendMessage(target, text) {
    const clean = String(text || '').trim();
    if (!clean) return { sent: 0, reason: 'empty_message' };

    const players = realPlayers();
    if (target === '*') {
        players.forEach((session) => sendTell(session, clean));
        return { sent: players.length, reason: 'broadcast' };
    }

    const lookup = String(target || '').trim().toLowerCase();
    const session = players.find((candidate) => playerName(candidate).toLowerCase() === lookup)
        || players.find((candidate) => playerName(candidate).toLowerCase().startsWith(lookup));

    if (!session) return { sent: 0, reason: 'player_not_found' };
    sendTell(session, clean);
    return { sent: 1, reason: playerName(session) };
}

function handleLine(line) {
    const input = String(line || '').trim();
    if (!input) return;

    if (input === 'players') {
        const names = realPlayers().map(playerName);
        console.info('DevConsole :: players=%s', names.length ? names.join(', ') : 'none');
        return;
    }

    if (input === 'help') {
        console.info('DevConsole :: commands: msg <player|*> <text>, players, help');
        return;
    }

    const match = input.match(/^msg\s+(\S+)\s+(.+)$/i);
    if (match) {
        const result = sendMessage(match[1], match[2]);
        console.info('DevConsole :: msg target=%s sent=%d reason=%s', match[1], result.sent, result.reason);
        return;
    }

    console.info('DevConsole :: unknown command. Try: msg * Hello, players, help');
}

const DevConsole = {
    started: false,

    init() {
        if (this.started || process.env.NODEL2_DEV_CONSOLE === '0' || !process.stdin.isTTY) return;
        this.started = true;

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        });

        rl.on('line', handleLine);
        utils.infoSuccess('DevConsole', 'ready: msg <player|*> <text>, players');
    },

    sendMessage
};

module.exports = DevConsole;
