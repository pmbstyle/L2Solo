const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const ClanService    = invoke('GameServer/Clan/ClanService');

function sendClanWindow(session) {
    const clan = ClanService.clanForActor(session.actor);
    if (!clan) return;

    const refreshed = ClanService.refreshOnlineMembers(clan);
    session.dataSendToMe(ServerResponse.pledgeShowInfoUpdate(refreshed));
    session.dataSendToMe(ServerResponse.pledgeShowMemberListAll(refreshed, session.actor));
}

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
        sendClanWindow(session);
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
