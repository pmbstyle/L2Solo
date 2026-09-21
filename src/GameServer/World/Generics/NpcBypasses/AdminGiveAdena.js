const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');
const BotManager     = invoke('GameServer/Bot/BotManager');

function resolveTargetSession(session) {
    const actor = session?.actor;
    if (!actor) return null;

    const destId = Number(actor.fetchDestId?.() ?? actor.destId ?? 0);
    if (!destId) return null;

    if (destId === Number(actor.fetchId?.() ?? actor.id)) {
        return session;
    }

    try {
        const botSession = BotManager.findSessionById(destId);
        if (botSession?.actor) return botSession;
    } catch (err) {}

    try {
        const World = invoke('GameServer/World/World');
        const playerSession = World?.user?.sessions?.find((s) => s.actor && Number(s.actor.fetchId()) === destId);
        if (playerSession?.actor) return playerSession;
    } catch (err) {}

    return null;
}

function giveAdenaToSession(gmSession, targetSession, amount) {
    const backpack = targetSession.actor.backpack;
    backpack.stackableExists(57).then((item) => {
        const total = item.fetchAmount() + amount;
        Database.updateItemAmount(targetSession.actor.fetchId(), item.fetchId(), total).then(() => {
            backpack.updateAmount(item.fetchId(), total);
            targetSession.dataSendToMe?.(ServerResponse.userInfo(targetSession.actor));
            targetSession.dataSendToMe?.(ServerResponse.itemsList(backpack.fetchItems()));
            targetSession.dataSendToMe?.(ServerResponse.speak(targetSession.actor, { kind: 0, text: `Received ${amount.toLocaleString()} Adena from Admin.` }));
            if (gmSession !== targetSession) {
                gmSession.dataSendToMe(ServerResponse.speak(gmSession.actor, { kind: 0, text: `Successfully gave ${amount.toLocaleString()} Adena to ${targetSession.actor.fetchName()}.` }));
            }
        });
    }).catch(() => {
        Database.setItem(targetSession.actor.fetchId(), {
            selfId: 57,
            name: "Adena",
            amount: amount,
            equipped: false,
            slot: 0
        }).then((packet) => {
            backpack.insertItem(Number(packet.insertId), 57, { amount: amount });
            targetSession.dataSendToMe?.(ServerResponse.userInfo(targetSession.actor));
            targetSession.dataSendToMe?.(ServerResponse.itemsList(backpack.fetchItems()));
            targetSession.dataSendToMe?.(ServerResponse.speak(targetSession.actor, { kind: 0, text: `Received ${amount.toLocaleString()} Adena from Admin.` }));
            if (gmSession !== targetSession) {
                gmSession.dataSendToMe(ServerResponse.speak(gmSession.actor, { kind: 0, text: `Successfully gave ${amount.toLocaleString()} Adena to ${targetSession.actor.fetchName()}.` }));
            }
        });
    });
}

module.exports = function(session, parts) {
    let targetSession = null;
    let amount = 0;

    if (parts.length >= 3) {
        const targetName = parts[1];
        amount = Number(parts[2]);
        try {
            targetSession = BotManager.findSessionByName(targetName);
        } catch (err) {}
        if (!targetSession) {
            const World = invoke('GameServer/World/World');
            targetSession = World.user.sessions.find(ob => ob.actor && ob.actor.fetchName().toLowerCase() === targetName.toLowerCase());
        }
    } else {
        amount = Number(parts[1]);
        targetSession = resolveTargetSession(session);
    }

    if (isNaN(amount) || amount <= 0) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: 'Please enter a valid Adena amount.' }));
        return;
    }

    if (!targetSession || !targetSession.actor) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: 'Please select a valid target character first.' }));
        return;
    }

    giveAdenaToSession(session, targetSession, amount);
};
