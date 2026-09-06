const assert = require('assert');
require('../src/Global');
const Location = invoke('GameServer/Bot/AI/BotChatLocation');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Recruitment = invoke('GameServer/Bot/Population/ColdPartyRecruitmentChat');
const RemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const originalSpots = SpotService.spots;
try {
    SpotService.spots = [{ id: '24_14', name: 'Keltir fields', area: { name: 'Cruma Tower' } }];
    assert.strictEqual(Location.describe({ spotId: '24_14' }), 'Cruma Tower', 'known area names take precedence over generic mob fields');
    assert.strictEqual(Location.describe({ spot: { name: 'Execution Grounds', density: 100, minLevel: 20, maxLevel: 30 } }),
        'Execution Grounds', 'public labels must not include simulation metrics');
    assert.strictEqual(Location.describe({ spotId: '2_19:cruma_tower' }), 'Cruma Tower', 'partitioned dungeon ids have a named fallback');
    assert.strictEqual(Location.describe({ region: 'giran_town' }), 'Giran');

    const dion = TownRespawn.towns.dion_town;
    assert.strictEqual(Location.describe({ loc: dion }), 'Dion');
    const north = { ...dion, locY: dion.locY - 12000 };
    assert.strictEqual(Location.describe({ loc: north }), 'the area north of Dion', 'world Y decreases towards north');
    const travelling = { characterId: 7001, name: 'Traveller', activity: 'hunting',
        homeRegion: 'Talking Island', currentRegion: 'Giran', spotId: '24_14', loc: dion,
        vitals: { hp: 100, maxHp: 100 } };
    assert.strictEqual(Location.forState(travelling), 'Dion', 'actual position wins over home and a future hunting destination');
    const reply = RemoteChat.fallbackReply(travelling, { available: true }, 'where are you?');
    assert(reply.includes('Dion') && !reply.includes('Talking Island') && !reply.includes('24_14'));

    SpotService.spots = [];
    const coarse = Location.describe({ spotId: '24_14' });
    assert.strictEqual(coarse, "the Hunter's Village area", 'simulation grid ids must not be interpreted as client map tiles');
    const party = { leaderId: 1, spotId: '24_14' };
    const members = [{ characterId: 1, name: 'Tank', level: 20, party: { role: 'tank' } }];
    const ad = Recruitment.recruitmentText(party, members, null, 5);
    assert(ad.includes(coarse) && !ad.includes('24_14'), 'missing spot data must not leak raw ids into recruitment');
    assert.strictEqual(Location.describe({ spot: { name: '24_14' }, region: 'Giran' }), 'Giran');
    assert.strictEqual(Location.describe({ spot: { name: '123,456,-700' } }), 'my hunting spot');
    assert.strictEqual(Location.describe({ loc: { locX: null, locY: null }, region: '24_14' }), 'my hunting spot',
        'missing coordinates must not turn into a made-up location at zero');
    process.stdout.write(`Location examples: Cruma Tower; ${Location.describe({ loc: north })}; ${coarse}.\n`);
} finally {
    SpotService.spots = originalSpots;
}
console.log('Bot chat location checks passed');
