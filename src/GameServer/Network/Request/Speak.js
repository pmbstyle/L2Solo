const ServerResponse = invoke('GameServer/Network/Response');
const ReceivePacket  = invoke('Packet/Receive');

function speak(session, buffer) {
    let packet = new ReceivePacket(buffer);

    packet
        .readS()  // Text
        .readD(); // Kind

    consume(session, {
        text: packet.data[0],
        kind: packet.data[1],
    });
}

function consume(session, data) {
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
            World.inviteBotByName(session, session.actor, name, 1, 'chat_invite');
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
