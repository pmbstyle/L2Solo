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
    const actor = session.actor;
    if (!actor || session.characterLeaving || session.worldEntryActor === actor) return;
    session.worldEntryActor = actor;
    let failed = false;
    const current = () => !failed && session.actor === actor && !session.characterLeaving && !session.socket?.destroyed;
    const continueEnter = async () => {
        if (!current()) return;
        // C4 establishes the local player before inventory, skills or nearby
        // objects. This is especially important after the client clears a scene.
        session.dataSendToMe(ServerResponse.userInfo(actor));
        session.dataSendToMe(ServerResponse.itemsList(actor.backpack.fetchItems()));
        await invoke('GameServer/Henna/HennaService').restore(session, { recalculateStats: false })
            .catch((error) => utils.infoWarn('Henna', 'henna login restore failed: %s', error.message));
        if (!current()) return;
        const shortcutsReady = Database.fetchMacros(actor.fetchId()).then((macros) => {
            if (!current()) return [];
            const revision = (session.macroRevision || 0) + 1;
            session.macroRevision = revision;
            ServerResponse.macroList(macros, revision).forEach((packet) => session.dataSendToMe(packet));
            return Database.fetchShortcuts(actor.fetchId());
        });

        const skillsReady = actor.enterWorld();
        // Slot rows can arrive before the asynchronous skillbook load finishes.
        // Wait for both, otherwise every unresolved skill is sent as level one.
        Promise.all([shortcutsReady, skillsReady]).then(([shortcuts]) => {
            if (!current()) return;
            session.dataSendToMe(ServerResponse.shortcutInit(shortcuts, actor.skillset));
            session.dataSendToMe(ServerResponse.skillCoolTime(actor));
        }).catch(error => utils.infoWarn('Character', 'shortcut login initialization failed: %s', error.message));
        await skillsReady;
        if (!current()) return;
        // The C4 client can retain its old party window across a restart.
        session.dataSendToMe(ServerResponse.partySmallWindowDeleteAll());
        session.dataSendToMe(GameTime.isNight() ? ServerResponse.sunset() : ServerResponse.sunrise());
        sendClanWindow(session);
        const quests = invoke('GameServer/Quest/QuestService');
        quests.ensureLoaded(session).then(() => {
            if (current())
                session.dataSendToMe(ServerResponse.questList(quests.active(session)));
        }).catch(error => utils.infoWarn('Quest', 'login load failed: %s', error.message));
        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.exStorageMaxCount(session.actor));
        session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(session.actor));
        session.dataSendToMe(ServerResponse.shortBuffStatusUpdate.fromActor(session.actor));
        session.dataSendToOthers(ServerResponse.charInfo(session.actor), session.actor);
        session.dataSendToOthers(ServerResponse.relationChanged(session.actor), session.actor);
        // The bots around a player who logs in are shown now, not at the next activation scan.
        invoke('GameServer/Bot/Population/PopulationService').requestPhaseScan(session.actor.fetchId());
        invoke('GameServer/AfkTrade/AfkTradeService').deliverNotifications(session)
            .catch((error) => utils.infoWarn('AfkTrade', 'notification delivery failed: %s', error.message));
    };

    // A player's shots are the starter stock of a new character (CreateNewChar.awardBaseShots); a
    // login does not top them up.
    const ready = Promise.resolve().then(continueEnter);
    const tracked = ready.catch(error => {
        // Late reads belong to this failed attempt, even if the same actor
        // retries. Only its own pending entry may release the actor gate.
        failed = true;
        if (session.enterWorldReady === tracked && session.worldEntryActor === actor) session.worldEntryActor = null;
        throw error;
    }).finally(() => {
        if (session.enterWorldReady === tracked) session.enterWorldReady = null;
    });
    session.enterWorldReady = tracked;
    // Logged here and the player stays connected: the returned chain must not reach the drop boundary.
    return tracked.catch(error => utils.infoWarn('Character', 'world entry failed: %s', error.message));
}

module.exports = enterWorld;
