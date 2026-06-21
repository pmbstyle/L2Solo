const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');

function enterWorld(session, buffer) {
    const continueEnter = () => {
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        Database.fetchShortcuts(session.actor.fetchId()).then((shortcuts) => {
            session.dataSendToMe(
                ServerResponse.shortcutInit(shortcuts)
            );
        });

        session.actor.enterWorld();
        session.dataSendToMe(ServerResponse.sunrise()); // TODO: Server timer
        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(session.actor));
        session.dataSendToOthers(ServerResponse.charInfo(session.actor), session.actor);
        session.dataSendToOthers(ServerResponse.relationChanged(session.actor), session.actor);
    };

    ShotStock.ensureActorStock(session.actor, { targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT })
        .then(continueEnter)
        .catch((err) => {
            utils.infoWarn('Character', 'starter shot stock failed for %s: %s', session.actor.fetchName(), err.message);
            continueEnter();
        });
}

module.exports = enterWorld;
