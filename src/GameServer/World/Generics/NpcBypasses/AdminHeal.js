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

module.exports = async function(session) {
    const actor = session?.actor;
    if (!actor) return;

    const targetSession = resolveTargetSession(session);
    if (!targetSession || !targetSession.actor) {
        session.dataSendToMe(ServerResponse.speak(actor, {
            kind: 0,
            text: 'Please select a valid target first.'
        }));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const targetActor = targetSession.actor;

    if (typeof targetActor.fillupVitals === 'function') {
        targetActor.fillupVitals();
    } else {
        targetActor.setHp?.(targetActor.fetchMaxHp());
        targetActor.setMp?.(targetActor.fetchMaxMp());
        targetActor.setCp?.(targetActor.fetchMaxCp());
    }

    targetActor.automation?.replenishVitals?.(targetActor);

    await Database.updateCharacterVitals(
        targetActor.fetchId(),
        targetActor.fetchHp(),
        targetActor.fetchMaxHp(),
        targetActor.fetchMp(),
        targetActor.fetchMaxMp()
    ).catch(() => {});

    targetActor.statusUpdateVitals?.(targetActor);
    targetSession.dataSendToMe?.(ServerResponse.userInfo(targetActor));
    targetSession.dataSendToMe?.(ServerResponse.statusUpdate(targetActor.fetchId(), [
        { id: 0x09, value: Math.round(targetActor.fetchHp()) },
        { id: 0x0a, value: Math.round(targetActor.fetchMaxHp()) },
        { id: 0x0b, value: Math.round(targetActor.fetchMp()) },
        { id: 0x0c, value: Math.round(targetActor.fetchMaxMp()) },
        { id: 0x21, value: Math.round(targetActor.fetchCp?.() || 0) },
        { id: 0x22, value: Math.round(targetActor.fetchMaxCp?.() || 0) }
    ]));

    if (session !== targetSession) {
        session.dataSendToMe(ServerResponse.speak(actor, {
            kind: 0,
            text: `Restored HP, MP and CP of ${targetActor.fetchName()}.`
        }));
        targetSession.dataSendToMe?.(ServerResponse.speak(targetActor, {
            kind: 0,
            text: 'Admin fully restored your HP, MP and CP.'
        }));
    } else {
        session.dataSendToMe(ServerResponse.speak(actor, {
            kind: 0,
            text: 'HP, MP and CP fully restored.'
        }));
    }
};
