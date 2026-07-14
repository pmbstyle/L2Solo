const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const ConsoleText    = invoke('GameServer/ConsoleText');
const Database       = invoke('Database');
const ProgressionRates = invoke('GameServer/ProgressionRates');

function resolveLevel(totalExp, maxLevel, experience) {
    const availableLevels = Math.min(Math.max(1, Number(maxLevel) || 1), experience.length);

    for (let i = 0; i < availableLevels; i++) {
        const isFinalLevel = i === availableLevels - 1;
        if (totalExp >= experience[i] && (isFinalLevel || totalExp < experience[i + 1])) {
            return i + 1;
        }
    }

    return null;
}

function experienceReward(session, actor, exp, sp) {
    const optn = options.default.General;
    const rates = ProgressionRates.profile();

    exp = Math.max(0, Math.round(exp * rates.exp));
    sp = Math.max(0, Math.round(sp * rates.sp));

    let totalExp = actor.fetchExp() + exp;
    let totalSp  = actor.fetchSp () + sp;

    actor.setExpSp(totalExp, totalSp);
    ConsoleText.transmit(session, ConsoleText.caption.earnedExpAndSp, [{ kind: ConsoleText.kind.number, value: exp }, { kind: ConsoleText.kind.number, value: sp }]);

    const resolvedLevel = resolveLevel(totalExp, optn.maxLevel, DataCache.experience);
    if (resolvedLevel && resolvedLevel > actor.fetchLevel()) {
        invoke(path.actor).levelUp(session, actor, resolvedLevel);
    }

    // Update stats
    session.dataSendToMe(ServerResponse.userInfo(actor));

    // Update database with new exp, sp
    Database.updateCharacterExperience(actor.fetchId(), actor.fetchLevel(), totalExp, totalSp);
}

module.exports = experienceReward;
module.exports.resolveLevel = resolveLevel;
