const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const ClanService    = invoke('GameServer/Clan/ClanService');
const GameTime       = invoke('GameServer/World/GameTime');

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
        const shortcutsReady = Database.fetchMacros(session.actor.fetchId()).then((macros) => {
            const revision = (session.macroRevision || 0) + 1;
            session.macroRevision = revision;
            ServerResponse.macroList(macros, revision).forEach((packet) => session.dataSendToMe(packet));
            return Database.fetchShortcuts(session.actor.fetchId());
        });

        const skillsReady = session.actor.enterWorld();
        // Slot rows can arrive before the asynchronous skillbook load finishes.
        // Wait for both, otherwise every unresolved skill is sent as level one.
        Promise.all([shortcutsReady, skillsReady]).then(([shortcuts]) => {
            session.dataSendToMe(ServerResponse.shortcutInit(shortcuts, session.actor.skillset));
        }).catch(error => utils.infoWarn('Character', 'shortcut login initialization failed: %s', error.message));
        session.dataSendToMe(GameTime.isNight() ? ServerResponse.sunset() : ServerResponse.sunrise());
        sendClanWindow(session);
        if (session.actor.fetchClanId?.()) invoke('GameServer/Quest/QuestService').ensureLoaded(session)
            .catch(error => utils.infoWarn('ClanQuest', 'login resume failed: %s', error.message));
        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.exStorageMaxCount(session.actor));
        session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(session.actor));
        session.dataSendToMe(ServerResponse.shortBuffStatusUpdate.fromActor(session.actor));
        session.dataSendToOthers(ServerResponse.charInfo(session.actor), session.actor);
        session.dataSendToOthers(ServerResponse.relationChanged(session.actor), session.actor);
        invoke('GameServer/AfkTrade/AfkTradeService').deliverNotifications(session)
            .catch((error) => utils.infoWarn('AfkTrade', 'notification delivery failed: %s', error.message));
    };

    ShotStock.ensureActorStock(session.actor, { targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT })
        .then(continueEnter)
        .catch((err) => {
            utils.infoWarn('Character', 'starter shot stock failed for %s: %s', session.actor.fetchName(), err.message);
            continueEnter();
        });
}

module.exports = enterWorld;
