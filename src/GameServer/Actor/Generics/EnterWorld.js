const DataCache   = invoke('GameServer/DataCache');
const ConsoleText = invoke('GameServer/ConsoleText');
const CharacterStatus = invoke('GameServer/Actor/CharacterStatus');
const ServerResponse = invoke('GameServer/Network/Response');

function refreshLoadedSkillState(session, actor, Generics, response = ServerResponse) {
    Generics.calculateStats(session, actor);
    session.dataSendToMe?.(response.skillsList(actor.skillset.fetchSkills()));
    session.dataSendToMe?.(response.userInfo(actor));
    session.dataSendToMe?.(response.abnormalStatusUpdate.fromActor(actor));
    session.dataSendToMe?.(response.shortBuffStatusUpdate.fromActor(actor));

    // The first calculation runs before Expertise is loaded and can apply a
    // temporary grade penalty. Remote clients may already have received that
    // provisional CharInfo through UpdateEnvironment, so publish the corrected
    // movement stats before a bot AI is allowed to start moving.
    session.dataSendToOthers?.(response.charInfo(actor), actor);
}

function enterWorld(session, actor) {
    const Generics = invoke(path.actor);

    // Set character as online
    actor.setIsOnline(true);

    // Effects must be available before the stat calculation; e.g. a max-HP
    // buff affects the cap used when the persisted HP is restored.
    const vitals = CharacterStatus.savedVitals(actor);
    CharacterStatus.restoreEffects(session, actor, actor.model.effects);

    // Calculate accumulated statistics
    Generics.calculateStats(session, actor);
    CharacterStatus.restoreVitals(actor, vitals);
    const skillReady = actor.skillset.populateForActor(actor, () => {
        // Skill loading is asynchronous.  The first calculation above runs
        // before Expertise is available and can temporarily apply the C4
        // grade penalty to correctly equipped characters.  Recalculate and
        // refresh the client once the real skillset is present.
        refreshLoadedSkillState(session, actor, Generics);
    });

    // Start vitals replenish
    actor.automation.setRevHp(DataCache.revitalize.hp[actor.fetchLevel()]);
    actor.automation.setRevMp(DataCache.revitalize.mp[actor.fetchLevel()]);
    actor.automation.replenishVitals(actor);

    // Show NPCs based on radius
    Generics.updatePosition(session, actor, {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ(),
        head: actor.fetchHead(),
    });

    // Default welcome
    ConsoleText.transmit(session, ConsoleText.caption.welcome);

    return Promise.resolve(skillReady);
}

module.exports = enterWorld;
module.exports.refreshLoadedSkillState = refreshLoadedSkillState;
