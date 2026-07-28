const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');

function pickupExec(session, actor, data, onComplete) {
    World.fetchItem(data.id).then((item) => {
        actor.automation.schedulePickup(session, actor, item, () => {
            actor.state.setPickinUp(true);
            session.dataSendToMeAndOthers(ServerResponse.pickupItem(actor.fetchId(), item), actor);

            setTimeout(() => {
                World.pickupItem(session, actor, item);
            }, 250);

            setTimeout(() => {
                actor.state.setPickinUp(false);
                onComplete?.();
            }, 500);
        });
    }).catch((err) => {
        utils.infoWarn('GameServer', 'Pickup -> ' + err);
        onComplete?.();
    });
}

module.exports = pickupExec;
