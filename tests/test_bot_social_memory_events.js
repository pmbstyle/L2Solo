const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const BotStatus = invoke('GameServer/Bot/AI/BotStatus');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const World = invoke('GameServer/World/World');

const originalGetStatus = BotStatus.getStatus;
const originalRecordEvent = BotSocialMemory.recordEvent;
const originalRecordHotTick = PopulationService.recordHotTick;
const originalUpdateMember = PartyCompanionService.updateMember;
const originalUser = World.user;
const originalFetchVisibleUsers = World.fetchVisibleUsers;

function deadActor(id, name) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchIsOnline: () => true,
        isDead: () => true,
        state: {
            fetchDead: () => true
        }
    };
}

try {
    const events = [];
    BotStatus.getStatus = () => ({ available: true });
    PopulationService.recordHotTick = () => {};
    PartyCompanionService.updateMember = () => {};
    BotSocialMemory.recordEvent = (playerSession, botSession, eventName, detail) => {
        events.push({
            player: playerSession.actor.fetchName(),
            bot: botSession.actor.fetchName(),
            eventName,
            detail
        });
        return Promise.resolve(null);
    };

    const leaderSession = {
        accountId: 'player_leader',
        actor: deadActor(2000100, 'Leader')
    };
    const botSession = {
        accountId: 'bot_wipe',
        aiActive: true,
        partyCompanion: true,
        followPlayerSession: leaderSession,
        actor: deadActor(2000101, 'Companion'),
        dataSendToOthers() {}
    };
    World.user = { sessions: [leaderSession, botSession] };
    World.fetchVisibleUsers = () => [];

    BotAI.tick(botSession);
    BotAI.tick(botSession);

    assert.deepStrictEqual(events, [{
        player: 'Leader',
        bot: 'Companion',
        eventName: 'party_wiped',
        detail: 'bot_and_leader_dead'
    }], 'party wipe should be recorded once when a companion dies with a dead leader');

    console.log('Bot social memory event checks passed');
} finally {
    BotStatus.getStatus = originalGetStatus;
    BotSocialMemory.recordEvent = originalRecordEvent;
    PopulationService.recordHotTick = originalRecordHotTick;
    PartyCompanionService.updateMember = originalUpdateMember;
    World.user = originalUser;
    World.fetchVisibleUsers = originalFetchVisibleUsers;
}
