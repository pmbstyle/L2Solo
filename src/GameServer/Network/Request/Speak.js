const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');
const PopulationConfig = invoke('GameServer/Bot/Population/PopulationConfig');

function logPlayerChat(session, data) {
    if (PopulationConfig.devLogPlayerChat === false) return;
    if (!session?.actor || String(session.accountId || '').startsWith('bot_')) return;

    const name = session.actor.fetchName ? session.actor.fetchName() : session.accountId || 'unknown';
    const text = String(data.text || '').replace(/\s+/g, ' ').slice(0, 180);
    const target = data.target ? ` target="${String(data.target).slice(0, 40)}"` : '';
    console.info('PlayerChat :: %s kind=%s%s text="%s"', name, data.kind, target, text);
}

function speak(session, buffer) {
    let packet = new ReceivePacket(buffer);

    packet
        .readS()  // Text
        .readD(); // Kind

    if (packet.data[1] === 2) {
        packet.readS(); // Target name for private tell
    }

    consume(session, {
        text: packet.data[0],
        kind: packet.data[1],
        target: packet.data[2],
    });
}

function findOnlineUserByName(name) {
    const lookup = String(name || '').trim().toLowerCase();
    if (!lookup) return null;

    const World = invoke('GameServer/World/World');
    return World.user.sessions.find((user) => (
        user?.actor &&
        user.actor.fetchIsOnline?.() === true &&
        !String(user.accountId || '').startsWith('bot_') &&
        user.actor.fetchName().toLowerCase() === lookup
    )) || null;
}

function handlePrivateTell(session, data) {
    const World = invoke('GameServer/World/World');
    const target = String(data.target || '').trim();
    const text = String(data.text || '').trim();

    if (!target || !text) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const BotManager = invoke('GameServer/Bot/BotManager');
    const botSession = BotManager.findSessionByName(target);
    if (botSession) {
        session.dataSendToMe(ServerResponse.speak(session.actor, data));
        World.messageBotByName(session, session.actor, target, text, 'client_tell');
        return;
    }

    const targetSession = findOnlineUserByName(target);
    if (!targetSession) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const packet = ServerResponse.speak(session.actor, data);
    targetSession.dataSendToMe(packet);
    session.dataSendToMe(packet);
}

function consume(session, data) {
    logPlayerChat(session, data);

    if (data.kind === 2) {
        handlePrivateTell(session, data);
        return;
    }

    if (data.kind === 0) { // TODO: Remove, temp solution
        if (data.text === '.admin') {
            invoke(path.actor).adminPanel(session, session.actor);
            return;
        }
        if (data.text === '.sell') {
            invoke(path.world + 'NpcTalkResponse')(session, { link: 'sell-junk' });
            return;
        }
        if (data.text === '.leave') {
            const World = invoke('GameServer/World/World');
            World.dismissParty(session, session.actor);
            return;
        }
        if (data.text.startsWith('.kick ')) {
            const name = data.text.substring(6).trim();
            const World = invoke('GameServer/World/World');
            World.oustPartyMember(session, session.actor, { name: name });
            return;
        }
        if (data.text === '.bot' || data.text === '.companion') {
            const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
            CompanionControl.render(session);
            return;
        }
        if (data.text === '.botparty') {
            const BotParty = invoke('GameServer/World/Generics/NpcBypasses/BotParty');
            BotParty.render(session);
            return;
        }
        if (data.text.startsWith('/invite ') || data.text.startsWith('.invite ')) {
            const name = data.text.replace(/^\/invite\s+|^\.invite\s+/, '').trim();
            const World = invoke('GameServer/World/World');
            World.inviteBotByName(session, session.actor, name, undefined, 'chat_invite');
            return;
        }
        if (/^(\/tell|\.tell|\/w|\.w)\s+/i.test(data.text)) {
            const body = data.text.replace(/^(\/tell|\.tell|\/w|\.w)\s+/i, '').trim();
            const match = body.match(/^(\S+)\s+(.+)$/);
            const World = invoke('GameServer/World/World');
            World.messageBotByName(
                session,
                session.actor,
                match ? match[1] : '',
                match ? match[2] : '',
                'chat_tell'
            );
            return;
        }
        if (data.text === '.uitest') {
            const UiTest = invoke('GameServer/World/Generics/NpcBypasses/UiTest');
            UiTest.render(session);
            return;
        }
        if (data.text === '.botstatus' || data.text.startsWith('.botstatus ')) {
            const BotStatus = invoke('GameServer/World/Generics/NpcBypasses/BotStatus');
            const parts = data.text.split(/\s+/);
            BotStatus(session, ['bot-status', parts[1]]);
            return;
        }
        if (data.text === '.botpath' || data.text.startsWith('.botpath ')) {
            const BotPath = invoke('GameServer/World/Generics/NpcBypasses/BotPath');
            const parts = data.text.split(/\s+/);
            BotPath(session, ['bot-path', parts[1]]);
            return;
        }
        if (data.text === '/trade' || data.text === '.trade') {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const BotTradeService = invoke('GameServer/Bot/BotTradeService');
            const targetSession = BotManager.findSessionById(session.actor.fetchDestId());
            const result = BotTradeService.startPlayerTrade(session, targetSession);

            if (!result.ok) {
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }

            session.dataSendToMe(ServerResponse.tradeStart(
                targetSession.actor,
                session.actor.backpack.fetchItems()
            ));
            return;
        }
    }

    if (data.kind === 1 || data.kind === 8) { // Shout / Trade
        const packet = ServerResponse.speak(session.actor, data);
        const World = invoke('GameServer/World/World');
        World.user.sessions.forEach((user) => {
            if (user.socket && typeof user.socket.write === 'function' && user.accountId.indexOf('bot_') !== 0) {
                user.dataSendToMe(packet);
            }
        });
    } else {
        session.dataSendToMeAndOthers(ServerResponse.speak(session.actor, data), session.actor);
    }

    try {
        const BotManager = invoke('GameServer/Bot/BotManager');
        if (BotManager && typeof BotManager.handlePlayerSpeak === 'function') {
            BotManager.handlePlayerSpeak(session, data);
        }
    } catch (err) {
        console.error("BotManager speak hook error:", err);
    }
}

module.exports = speak;
