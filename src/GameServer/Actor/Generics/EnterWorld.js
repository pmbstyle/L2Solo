const DataCache   = invoke('GameServer/DataCache');
const ConsoleText = invoke('GameServer/ConsoleText');
const CharacterStatus = invoke('GameServer/Actor/CharacterStatus');
const ServerResponse = invoke('GameServer/Network/Response');

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
    actor.skillset.populate(actor.fetchId(), () => {
        // Skill loading is asynchronous.  The first calculation above runs
        // before Expertise is available and can temporarily apply the C4
        // grade penalty to correctly equipped characters.  Recalculate and
        // refresh the client once the real skillset is present.
        Generics.calculateStats(session, actor);
        session.dataSendToMe?.(ServerResponse.userInfo(actor));
        session.dataSendToMe?.(ServerResponse.abnormalStatusUpdate.fromActor(actor));
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
}

module.exports = enterWorld;
