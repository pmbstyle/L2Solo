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

    // Check for new skills
    actor.skillset.awardSkills(id, classId, level).then(() => {
        session.dataSendToMe(ServerResponse.skillsList(actor.skillset.fetchSkills()));
    })

    // Level up effect
    session.dataSendToMeAndOthers(ServerResponse.socialAction(id, 15), actor);
    ConsoleText.transmit(session, ConsoleText.caption.levelUp);

    // Update database with new hp, mp
    Database.updateCharacterVitals(id, hp, maxHp, mp, maxMp);

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
