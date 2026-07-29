const ServerResponse = invoke('GameServer/Network/Response');

function stopAutomation(session, creature) {
    // This generic emits the canonical StopMove packet below, so suppress the
    // automatic notification from Automation.abortAll to avoid a duplicate.
    creature.automation.abortAll(creature, { notifyClient: false });

    session.dataSendToMeAndOthers(
        ServerResponse.stopMove(creature.fetchId(), {
            locX: creature.fetchLocX(),
            locY: creature.fetchLocY(),
            locZ: creature.fetchLocZ(),
            head: creature.fetchHead(),
        }), creature
    );
}

module.exports = stopAutomation;
