const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Database       = invoke('Database');

function maxLevel() {
    return Number(options.default.General.maxLevel) || 75;
}

function normalizeLevel(value) {
    const level = Number(value);
    if (!Number.isFinite(level)) {
        return null;
    }

    return Math.max(1, Math.min(maxLevel(), Math.floor(level)));
}

function expForLevel(level) {
    return DataCache.experience[Math.max(0, level - 1)] ?? 0;
}

function updateAutomation(actor, level) {
    if (!actor.automation) {
        return;
    }

    actor.automation.stopReplenish?.();
    actor.automation.setRevHp?.(DataCache.revitalize.hp[level]);
    actor.automation.setRevMp?.(DataCache.revitalize.mp[level]);
    actor.automation.replenishVitals?.(actor);
}

function sendLevelRefresh(session, actor) {
    session.dataSendToMe(ServerResponse.userInfo(actor));
    session.dataSendToMe(ServerResponse.statusUpdate(actor.fetchId(), levelStatusParams(actor)));
    session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
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
        { id: 0x0e, value: d(actor.backpack.fetchTotalLoad()) },
        { id: 0x0f, value: d(actor.fetchMaxLoad()) },
        { id: 0x11, value: d(actor.fetchCollectivePAtk()) },
        { id: 0x12, value: d(actor.fetchCollectiveAtkSpd()) },
        { id: 0x13, value: d(actor.fetchCollectivePDef()) },
        { id: 0x14, value: d(actor.fetchCollectiveEvasion()) },
        { id: 0x15, value: d(actor.fetchCollectiveAccur()) },
        { id: 0x16, value: d(actor.fetchCollectiveCritical()) },
        { id: 0x17, value: d(actor.fetchCollectiveMAtk()) },
        { id: 0x18, value: d(actor.fetchCollectiveCastSpd()) },
        { id: 0x19, value: d(actor.fetchCollectiveMDef()) },
        { id: 0x1a, value: d(actor.fetchPvpFlag()) },
        { id: 0x1b, value: d(actor.fetchKarma()) },
        { id: 0x21, value: d(actor.fetchCp()) },
        { id: 0x22, value: d(actor.fetchMaxCp()) }
    ];
}

async function awardLevelSkills(session, actor) {
    await actor.skillset.awardSkills(actor.fetchId(), actor.fetchClassId(), actor.fetchLevel());
    session.dataSendToMe(ServerResponse.skillsList(actor.skillset.fetchSkills()));
}

async function setOwnLevel(session, level) {
    const actor = session.actor;
    const exp = expForLevel(level);
    const sp = actor.fetchSp() || 0;
    const previousLevel = actor.fetchLevel();

    actor.setExpSp(exp, sp);
    actor.setLevel(level);
    invoke(path.actor).calculateStats(session, actor);
    actor.fillupVitals();
    updateAutomation(actor, level);

    await Database.updateCharacterExperience(actor.fetchId(), level, exp, sp);
    await Database.updateCharacterVitals(
        actor.fetchId(),
        actor.fetchHp(),
        actor.fetchMaxHp(),
        actor.fetchMp(),
        actor.fetchMaxMp()
    );
    await awardLevelSkills(session, actor);

    if (level > previousLevel) {
        session.dataSendToMeAndOthers?.(ServerResponse.socialAction(actor.fetchId(), 15), actor);
    }
    sendLevelRefresh(session, actor);
}

module.exports = function(session, parts) {
    const level = normalizeLevel(parts[1]);
    if (!level) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: 'Invalid level.' }));
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    setOwnLevel(session, level)
        .then(() => {
            const actor = session.actor;
            session.dataSendToMe(ServerResponse.speak(actor, {
                kind: 0,
                text: `Level set to ${level}. HP ${Math.round(actor.fetchHp())}/${Math.round(actor.fetchMaxHp())}, MP ${Math.round(actor.fetchMp())}/${Math.round(actor.fetchMaxMp())}, skills ${actor.skillset.fetchSkills().length}.`
            }));
        })
        .catch((err) => {
            utils.infoWarn('GameServer', 'admin set level failed: %s', err.message || err);
            session.dataSendToMe(ServerResponse.actionFailed());
        });
};

module.exports.normalizeLevel = normalizeLevel;
module.exports.expForLevel = expForLevel;
module.exports.levelStatusParams = levelStatusParams;
module.exports.awardLevelSkills = awardLevelSkills;
module.exports.setOwnLevel = setOwnLevel;
