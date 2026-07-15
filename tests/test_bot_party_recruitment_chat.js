const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PartyRecruitmentChat = invoke('GameServer/Bot/Population/ColdPartyRecruitmentChat');

const originalUser = World.user;
const originalConfig = {
    partyMaxSize: Config.partyMaxSize,
    partyRecruitmentChatEnabled: Config.partyRecruitmentChatEnabled,
    partyRecruitmentChatIntervalMs: Config.partyRecruitmentChatIntervalMs,
    partyRecruitmentChatGlobalMinIntervalMs: Config.partyRecruitmentChatGlobalMinIntervalMs
};
const packets = [];

try {
    Config.partyMaxSize = 5;
    Config.partyRecruitmentChatEnabled = true;
    Config.partyRecruitmentChatIntervalMs = 10000;
    Config.partyRecruitmentChatGlobalMinIntervalMs = 1000;
    World.user = { sessions: [{
        accountId: 'player_1',
        socket: { write: () => {} },
        dataSendToMe: (packet) => packets.push(packet)
    }] };
    PartyRecruitmentChat.reset();

    const party = { partyId: 'party_1', leaderId: 1, spotId: 'cruma', stats: {} };
    const members = [
        { characterId: 1, name: 'Shieldwall', level: 15, party: { role: 'tank' } },
        { characterId: 2, name: 'Lifebloom', level: 15, party: { role: 'healer' } }
    ];
    const announced = PartyRecruitmentChat.maybeAnnounce(party, members, { name: 'Cruma Tower' }, 1000);
    assert.strictEqual(announced.announced, true);
    assert.strictEqual(announced.text, 'Tank and Healer LFM DPS and Buffer — Lv. 15 party at Cruma Tower.');
    assert.strictEqual(packets.length, 1, 'a real player should receive the party shout');
    assert.strictEqual(announced.party.stats.lastRecruitmentAdAt, 1000);

    const throttled = PartyRecruitmentChat.maybeAnnounce(announced.party, members, { name: 'Cruma Tower' }, 1001);
    assert.strictEqual(throttled.announced, false);
    assert.strictEqual(throttled.reason, 'cooldown');

    const full = PartyRecruitmentChat.maybeAnnounce(party, [...members, { characterId: 3 }, { characterId: 4 }, { characterId: 5 }], { name: 'Cruma Tower' }, 20000);
    assert.strictEqual(full.announced, false);
    assert.strictEqual(full.reason, 'party_full');
    console.log('Bot party recruitment chat checks passed');
} finally {
    World.user = originalUser;
    Object.assign(Config, originalConfig);
    PartyRecruitmentChat.reset();
}
