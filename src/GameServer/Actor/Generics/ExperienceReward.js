const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const ConsoleText    = invoke('GameServer/ConsoleText');
const Database       = invoke('Database');
const ProgressionRates = invoke('GameServer/ProgressionRates');

function experienceReward(session, actor, exp, sp) {
    const optn = options.default.General;
    const rates = ProgressionRates.profile();

    exp = Math.max(0, Math.round(exp * rates.exp));
    sp = Math.max(0, Math.round(sp * rates.sp));

    let totalExp = actor.fetchExp() + exp;
    let totalSp  = actor.fetchSp () + sp;

    actor.setExpSp(totalExp, totalSp);
    ConsoleText.transmit(session, ConsoleText.caption.earnedExpAndSp, [{ kind: ConsoleText.kind.number, value: exp }, { kind: ConsoleText.kind.number, value: sp }]);

    for (let i = 0; i < optn.maxLevel; i++) {
        if (totalExp >= DataCache.experience[i] && totalExp < DataCache.experience[i + 1]) {
            if (i + 1 > actor.fetchLevel()) { // Leveled up
                invoke(path.actor).levelUp(session, actor, i + 1);
                break;
            }
        }
    }

    // Update stats
    session.dataSendToMe(ServerResponse.userInfo(actor));

    // Update database with new exp, sp
    Database.updateCharacterExperience(actor.fetchId(), actor.fetchLevel(), totalExp, totalSp);
}

module.exports = experienceReward;
