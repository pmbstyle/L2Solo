const Database = invoke('Database');
const CalculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const ServerResponse = invoke('GameServer/Network/Response');
const ClassProgression = invoke('GameServer/ClassProgression');

function statusParams(actor) {
    const d = (value) => Math.round(Number(value) || 0);

    return [
        { id: 0x01, value: d(actor.fetchLevel()) },
        { id: 0x09, value: d(actor.fetchHp()) },
        { id: 0x0a, value: d(actor.fetchMaxHp()) },
        { id: 0x0b, value: d(actor.fetchMp()) },
        { id: 0x0c, value: d(actor.fetchMaxMp()) },
        { id: 0x11, value: d(actor.fetchCollectivePAtk()) },
        { id: 0x12, value: d(actor.fetchCollectiveAtkSpd()) },
        { id: 0x13, value: d(actor.fetchCollectivePDef()) },
        { id: 0x14, value: d(actor.fetchCollectiveEvasion()) },
        { id: 0x15, value: d(actor.fetchCollectiveAccur()) },
        { id: 0x16, value: d(actor.fetchCollectiveCritical()) },
        { id: 0x17, value: d(actor.fetchCollectiveMAtk()) },
        { id: 0x18, value: d(actor.fetchCollectiveCastSpd()) },
        { id: 0x19, value: d(actor.fetchCollectiveMDef()) }
    ];
}

function eligibility(actor, targetClassId, { firstProfessionOnly = false } = {}) {
    if (!actor || actor.isDead?.()) return { ok: false, reason: 'unavailable' };
    const currentClassId = Number(actor.fetchClassId());
    const target = Number(targetClassId);
    const { firstProfMap, secondProfMap } = ClassProgression;

    if (firstProfMap[currentClassId]?.includes(target)) {
        return { ok: true, requiredLevel: 20, currentClassId, targetClassId: target };
    }
    if (firstProfessionOnly) return { ok: false, reason: 'wrong_profession' };
    if (secondProfMap[currentClassId]?.includes(target)) {
        return { ok: true, requiredLevel: 40, currentClassId, targetClassId: target };
    }
    if (ClassProgression.getThirdClass(target)?.parentClassId === currentClassId) {
        return { ok: true, requiredLevel: 76, currentClassId, targetClassId: target };
    }
    return { ok: false, reason: 'wrong_profession' };
}

// The transferable unit is shared by the legacy Sylvain bypass and quest
// endings. It persists first, then refreshes skills, stats and every client
// view; callers therefore never leave a completed quest with a stale class.
async function transfer(session, targetClassId, options = {}) {
    const actor = session?.actor;
    const check = eligibility(actor, targetClassId, options);
    if (!check.ok) return check;
    const currentLevel = Number(actor.fetchLevel());
    if (currentLevel < check.requiredLevel) {
        return { ok: false, reason: 'level', requiredLevel: check.requiredLevel };
    }

    actor.setClassId(check.targetClassId);
    try {
        await Database.updateCharacterClassId(actor.fetchId(), check.targetClassId);
        await actor.skillset.awardSkills(actor.fetchId(), check.targetClassId, currentLevel);
        CalculateStats(session, actor);
        actor.fillupVitals();

        session.dataSendToMeAndOthers?.(ServerResponse.socialAction(actor.fetchId(), 15), actor);
        session.dataSendToMe?.(ServerResponse.skillsList(actor.skillset.fetchSkills()));
        session.dataSendToMe?.(ServerResponse.userInfo(actor));
        session.dataSendToMe?.(ServerResponse.statusUpdate(actor.fetchId(), statusParams(actor)));
        session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
        return { ok: true, targetClassId: check.targetClassId, requiredLevel: check.requiredLevel };
    } catch (error) {
        actor.setClassId(check.currentClassId);
        await Database.updateCharacterClassId(actor.fetchId(), check.currentClassId).catch(() => {});
        utils.infoWarn('Character', 'class change failed for %s: %s', actor.fetchName(), error.message);
        return { ok: false, reason: 'persistence', error };
    }
}

module.exports = { eligibility, transfer, statusParams };
