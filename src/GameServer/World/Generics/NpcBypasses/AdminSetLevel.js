const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Database       = invoke('Database');
const BotManager     = invoke('GameServer/Bot/BotManager');

function maxLevel() {
    return Number(options.default.General.maxLevel) || 75;
}

function normalizeLevel(value) {
    const level = Number(value);
    if (!Number.isFinite(level)) return null;
    return Math.max(1, Math.min(maxLevel(), Math.floor(level)));
}

function expForLevel(level) {
    return DataCache.experience[Math.max(0, level - 1)] ?? 0;
}

function updateAutomation(actor, level) {
    if (!actor.automation) return;
    actor.automation.stopReplenish?.();
    actor.automation.setRevHp?.(DataCache.revitalize.hp[level]);
    actor.automation.setRevMp?.(DataCache.revitalize.mp[level]);
    actor.automation.replenishVitals?.(actor);
}

function levelStatusParams(actor) {
    const d = (value) => Math.round(Number(value) || 0);
    return [
        { id: 0x01, value: d(actor.fetchLevel()) },
        { id: 0x02, value: d(actor.fetchExp()) },
        { id: 0x09, value: d(actor.fetchHp()) },
        { id: 0x0a, value: d(actor.fetchMaxHp()) },
        { id: 0x0b, value: d(actor.fetchMp()) },
        { id: 0x0c, value: d(actor.fetchMaxMp()) },
        { id: 0x0d, value: d(actor.fetchSp()) },
        { id: 0x0e, value: d(actor.backpack?.fetchTotalLoad?.() || 0) },
        { id: 0x0f, value: d(actor.fetchMaxLoad?.() || 0) },
        { id: 0x11, value: d(actor.fetchCollectivePAtk?.() || 0) },
        { id: 0x12, value: d(actor.fetchCollectiveAtkSpd?.() || 0) },
        { id: 0x13, value: d(actor.fetchCollectivePDef?.() || 0) },
        { id: 0x14, value: d(actor.fetchCollectiveEvasion?.() || 0) },
        { id: 0x15, value: d(actor.fetchCollectiveAccur?.() || 0) },
        { id: 0x16, value: d(actor.fetchCollectiveCritical?.() || 0) },
        { id: 0x17, value: d(actor.fetchCollectiveMAtk?.() || 0) },
        { id: 0x18, value: d(actor.fetchCollectiveCastSpd?.() || 0) },
        { id: 0x19, value: d(actor.fetchCollectiveMDef?.() || 0) },
        { id: 0x1a, value: d(actor.fetchPvpFlag?.() || 0) },
        { id: 0x1b, value: d(actor.fetchKarma?.() || 0) },
        { id: 0x21, value: d(actor.fetchCp?.() || 0) },
        { id: 0x22, value: d(actor.fetchMaxCp?.() || 0) }
    ];
}

function sendLevelRefresh(targetSession, actor) {
    targetSession?.dataSendToMe?.(ServerResponse.userInfo(actor));
    targetSession?.dataSendToMe?.(ServerResponse.statusUpdate(actor.fetchId(), levelStatusParams(actor)));
    targetSession?.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
}

async function awardLevelSkills(targetSession, actor) {
    if (!actor.skillset) return;
    await actor.skillset.awardSkills(actor.fetchId(), actor.fetchClassId(), actor.fetchLevel());
    targetSession?.dataSendToMe?.(ServerResponse.skillsList(actor.skillset.fetchSkills()));
    try {
        await invoke('GameServer/Shortcuts').refreshSkills(targetSession, actor);
    } catch (err) {}
}

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

async function applyLevelToActor(gmSession, targetActor, targetSession, level) {
    const exp = expForLevel(level);
    const sp = targetActor.fetchSp() || 0;
    const previousLevel = targetActor.fetchLevel();

    targetActor.setExpSp(exp, sp);
    targetActor.setLevel(level);
    invoke(path.actor).calculateStats(targetSession, targetActor);
    targetActor.fillupVitals();
    updateAutomation(targetActor, level);

    await Database.updateCharacterExperience(targetActor.fetchId(), level, exp, sp);
    await Database.updateCharacterVitals(
        targetActor.fetchId(),
        targetActor.fetchHp(),
        targetActor.fetchMaxHp(),
        targetActor.fetchMp(),
        targetActor.fetchMaxMp()
    );
    await awardLevelSkills(targetSession, targetActor);

    if (level > previousLevel) {
        targetSession?.dataSendToMeAndOthers?.(ServerResponse.socialAction(targetActor.fetchId(), 15), targetActor);
    }
    sendLevelRefresh(targetSession, targetActor);
}

module.exports = function(session, parts) {
    const level = normalizeLevel(parts[1]);
    if (!level) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: 'Invalid level.' }));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const targetSession = resolveTargetSession(session);
    if (!targetSession || !targetSession.actor) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: 'Please select a valid target first.' }));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const targetActor = targetSession.actor;

    applyLevelToActor(session, targetActor, targetSession, level)
        .then(() => {
            if (session !== targetSession) {
                session.dataSendToMe(ServerResponse.speak(session.actor, {
                    kind: 0,
                    text: `Level of ${targetActor.fetchName()} set to ${level}.`
                }));
                targetSession.dataSendToMe?.(ServerResponse.speak(targetActor, {
                    kind: 0,
                    text: `Admin set your level to ${level}.`
                }));
            } else {
                session.dataSendToMe(ServerResponse.speak(session.actor, {
                    kind: 0,
                    text: `Level set to ${level}. HP ${Math.round(targetActor.fetchHp())}/${Math.round(targetActor.fetchMaxHp())}, MP ${Math.round(targetActor.fetchMp())}/${Math.round(targetActor.fetchMaxMp())}.`
                }));
            }
        })
        .catch((err) => {
            utils.infoWarn('GameServer', 'admin set level failed: %s', err.message || err);
            session.dataSendToMe(ServerResponse.actionFailed());
        });
};
