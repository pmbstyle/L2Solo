const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const Karma = invoke('GameServer/Karma');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const ProgressionCap = invoke('GameServer/Progression/ProgressionCap');

function resolveLevel(totalExp, maxLevel, experience) {
    const contentCap = Math.min(Number(maxLevel) || 1, ProgressionCap.contentCap());
    return ProgressionCap.levelForExperience(totalExp, 1, {
        General: { maxLevel },
        Progression: { contentCap }
    }, experience);
}

function experienceReward(session, actor, exp, sp) {
    const rates = ProgressionRates.profile();

    exp = Math.max(0, Math.round(exp * rates.exp * EffectStats.multiplier(actor, 'expMul')));
    sp = Math.max(0, Math.round(sp * rates.sp));

    const award = ProgressionCap.applyAward(actor.fetchExp(), exp);
    const totalExp = award.totalExp;
    const totalSp = actor.fetchSp() + sp;

    actor.setExpSp(totalExp, totalSp);
    const karmaLost = Karma.karmaLostForExperience(actor, award.accepted);
    if (karmaLost > 0) {
        actor.setKarma(actor.fetchKarma() - karmaLost);
        session.dataSendToOthers(ServerResponse.charInfo(actor), actor);
        session.dataSendToOthers(ServerResponse.relationChanged(actor), actor);
    }
    ConsoleText.transmit(session, ConsoleText.caption.earnedExpAndSp, [{ kind: ConsoleText.kind.number, value: award.accepted }, { kind: ConsoleText.kind.number, value: sp }]);

    const resolvedLevel = ProgressionCap.levelForExperience(totalExp, actor.fetchLevel());
    if (resolvedLevel && resolvedLevel > actor.fetchLevel()) {
        invoke(path.actor).levelUp(session, actor, resolvedLevel);
    } else if (resolvedLevel && resolvedLevel < actor.fetchLevel()
        && actor.fetchLevel() > ProgressionCap.effectiveLevelCap()) {
        actor.setLevel(resolvedLevel);
        invoke(path.actor).calculateStats(session, actor);
        actor.refreshVitalsRegeneration?.();
        session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
    }

    // Update stats
    session.dataSendToMe(ServerResponse.userInfo(actor));

    // Update database with new exp, sp
    CharacterWriteQueue.experience(actor.fetchId(), actor.fetchLevel(), totalExp, totalSp);
    if (karmaLost > 0) {
        CharacterWriteQueue.karma(actor.fetchId(), actor.fetchPvp(), actor.fetchPk(), actor.fetchKarma());
    }
    if (session.accountId?.startsWith('bot_')) {
        invoke('GameServer/Bot/BotSkillTraining').review(session, { onSpAward: true }).catch((error) => {
            utils.infoWarn('BotSkills', 'training after SP award failed for %d: %s', actor.fetchId(), error.message);
        });
    }
    return {
        requestedExp: award.requested,
        grantedExp: award.accepted,
        discardedExp: award.discarded,
        totalExp,
        grantedSp: sp,
        totalSp
    };
}

module.exports = experienceReward;
module.exports.resolveLevel = resolveLevel;
