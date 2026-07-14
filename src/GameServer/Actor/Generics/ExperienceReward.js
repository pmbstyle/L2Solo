const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const ConsoleText    = invoke('GameServer/ConsoleText');
const Database       = invoke('Database');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const Karma = invoke('GameServer/Karma');

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
    const karmaLost = Karma.karmaLostForExperience(actor, exp);
    if (karmaLost > 0) {
        actor.setKarma(actor.fetchKarma() - karmaLost);
        session.dataSendToOthers(ServerResponse.charInfo(actor), actor);
        session.dataSendToOthers(ServerResponse.relationChanged(actor), actor);
    }
    ConsoleText.transmit(session, ConsoleText.caption.earnedExpAndSp, [{ kind: ConsoleText.kind.number, value: exp }, { kind: ConsoleText.kind.number, value: sp }]);

    const resolvedLevel = resolveLevel(totalExp, optn.maxLevel, DataCache.experience);
    if (resolvedLevel && resolvedLevel > actor.fetchLevel()) {
        invoke(path.actor).levelUp(session, actor, resolvedLevel);
    }

    // Update stats
    session.dataSendToMe(ServerResponse.userInfo(actor));

    // Update database with new exp, sp
    Database.updateCharacterExperience(actor.fetchId(), actor.fetchLevel(), totalExp, totalSp);
    if (karmaLost > 0) {
        Database.updateCharacterPvpPkKarma(actor.fetchId(), actor.fetchPvp(), actor.fetchPk(), actor.fetchKarma());
    }
}

module.exports = experienceReward;
module.exports.resolveLevel = resolveLevel;
