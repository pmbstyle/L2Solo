const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');
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
    const continueEnter = async () => {
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        invoke('GameServer/Henna/HennaService').restore(session)
            .catch((error) => utils.infoWarn('Henna', 'henna login restore failed: %s', error.message));
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
            session.dataSendToMe(ServerResponse.skillCoolTime(session.actor));
        }).catch(error => utils.infoWarn('Character', 'shortcut login initialization failed: %s', error.message));
        await skillsReady;
        session.dataSendToMe(GameTime.isNight() ? ServerResponse.sunset() : ServerResponse.sunrise());
        sendClanWindow(session);
        const questActor = session.actor;
        const quests = invoke('GameServer/Quest/QuestService');
        quests.ensureLoaded(session).then(() => {
            if (session.actor === questActor)
                session.dataSendToMe(ServerResponse.questList(quests.active(session)));
        }).catch(error => utils.infoWarn('Quest', 'login load failed: %s', error.message));
        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.exStorageMaxCount(session.actor));
        session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(session.actor));
        session.dataSendToMe(ServerResponse.shortBuffStatusUpdate.fromActor(session.actor));
        session.dataSendToOthers(ServerResponse.charInfo(session.actor), session.actor);
        session.dataSendToOthers(ServerResponse.relationChanged(session.actor), session.actor);
        // The bots around a player who logs in are shown now, not at the next activation scan.
        invoke('GameServer/Bot/Population/PopulationService').requestPhaseScan();
        invoke('GameServer/AfkTrade/AfkTradeService').deliverNotifications(session)
            .catch((error) => utils.infoWarn('AfkTrade', 'notification delivery failed: %s', error.message));
    };

    // A player's shots are the starter stock of a new character (CreateNewChar.awardBaseShots); a
    // login does not top them up.
    const ready = Promise.resolve().then(continueEnter);
    const tracked = ready.finally(() => {
        if (session.enterWorldReady === tracked) session.enterWorldReady = null;
    });
    session.enterWorldReady = tracked;
    // Logged here and the player stays connected: the returned chain must not reach the drop boundary.
    return tracked.catch(error => utils.infoWarn('Character', 'world entry failed: %s', error.message));
}

module.exports = enterWorld;
