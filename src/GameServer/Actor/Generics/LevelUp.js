const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const ConsoleText    = invoke('GameServer/ConsoleText');
const Database       = invoke('Database');

function levelUp(session, actor, nextLevel) {
    // Update stats
    actor.setLevel(nextLevel);
    invoke(path.actor).calculateStats(session, actor);
    actor.fillupVitals();

    const id      = actor.fetchId();
    const classId = actor.fetchClassId();
    const level   = actor.fetchLevel();
    const hp      = actor.fetchHp();
    const maxHp   = actor.fetchMaxHp();
    const mp      = actor.fetchMp();
    const maxMp   = actor.fetchMaxMp();

    // Stop automation to prevent false data
    actor.automation.stopReplenish();
    actor.automation.setRevHp(DataCache.revitalize.hp[level]);
    actor.automation.setRevMp(DataCache.revitalize.mp[level]);

    // Bots must advance through professions instead of continuing to receive
    // starter-class skills after their level has crossed a transfer threshold.
    const isBot = session.accountId?.startsWith('bot_') === true;
    const awardSkills = isBot
        ? invoke('GameServer/Bot/BotClassProgression').reconcile({
            characterId: id,
            classId,
            level,
            seed: actor.fetchName()
        }).then((progression) => {
            if (Number(progression.classId) !== Number(classId)) actor.setClassId(progression.classId);
            return new Promise((resolve) => actor.skillset.populate(id, resolve));
        })
        : actor.skillset.awardSkills(id, classId, level);

    // Check for new skills
    awardSkills.then(() => {
        invoke(path.actor).calculateStats(session, actor);
        actor.fillupVitals();
        session.dataSendToMe(ServerResponse.skillsList(actor.skillset.fetchSkills()));
        if (isBot) {
            // A bot has no client of its own, so nearby players and party
            // members need the normal character refresh after a profession.
            session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
            Database.updateCharacterVitals(id, actor.fetchHp(), actor.fetchMaxHp(), actor.fetchMp(), actor.fetchMaxMp());
        }
    })

    // Level up effect
    session.dataSendToMeAndOthers(ServerResponse.socialAction(id, 15), actor);
    ConsoleText.transmit(session, ConsoleText.caption.levelUp);

    // Update database with new hp, mp
    Database.updateCharacterVitals(id, hp, maxHp, mp, maxMp);

    const ClanService = invoke('GameServer/Clan/ClanService');
    const clanUpdate = ClanService.updateActorMember(actor);
    if (clanUpdate?.clan) {
        ClanService.onlineSessions(clanUpdate.clan).forEach((memberSession) => {
            memberSession.dataSendToMe(ServerResponse.pledgeShowMemberListUpdate(clanUpdate.member));
            memberSession.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(clanUpdate.clan));
        });
    }

    // Bot celebration reaction
    if (session.accountId && session.accountId.startsWith('bot_')) {
        try {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const levelUpPhrases = [
                `Awesome! I just leveled up to level ${nextLevel}!`,
                `Lvl ${nextLevel}! I'm getting so strong!`,
                `Yes! Level ${nextLevel}! Kelters stand no chance!`,
                `Level up! ${nextLevel}! Time to farm harder!`
            ];
            const phrase = levelUpPhrases[Math.floor(Math.random() * levelUpPhrases.length)];
            setTimeout(() => {
                BotManager.botSay(session, phrase);
            }, 1000);
        } catch (err) {
            console.error("Bot level-up shout error:", err);
        }
    }
}

module.exports = levelUp;
