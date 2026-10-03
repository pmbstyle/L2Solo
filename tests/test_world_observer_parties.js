const assert = require('assert');
require('../src/Global');
const Observer = invoke('WorldObserver/WorldObserverServer');
const World = invoke('GameServer/World/World');
const Pages = require('../src/WorldObserver/public/playerPages');
const originalUser = World.user;
const actor = {
    fetchId: () => 7, fetchName: () => 'Player leader', fetchClassId: () => 0, fetchRace: () => 0,
    fetchLevel: () => 25, fetchLocX: () => 83400, fetchLocY: () => 147943, fetchLocZ: () => -3400,
    fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
    fetchIsOnline: () => true
};
const player = { actor };
const companion = { partyCompanion: true, followPlayerSession: player };
try {
    World.user = { sessions: [player, companion] };
    const leader = Observer.compactPlayer(player);
    const bot = Observer.compactHotBot({ id: 42, name: 'Companion', level: 20, classId: 0,
        party: { leader: { id: 7, name: 'Player leader' }, role: 'dps' }, loc: { locX: 83400, locY: 147943, locZ: -3400 } }, new Set(), companion);
    assert.strictEqual(leader.party.id, 'player_7');
    assert.strictEqual(bot.party.id, leader.party.id, 'player parties without a background id must still share an Observer identity');
    const groups = Pages.groupParties([{ ...leader, kind: 'player' }, { ...bot, kind: 'bot' }]);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].members.length, 2, 'the player leader must be included in the roster');
    assert.strictEqual(groups[0].leader.kind, 'player');
    World.user.sessions = [player];
    assert.strictEqual(Observer.compactPlayer(player).party, null, 'solo players must not appear in a fabricated party');
    const background = Observer.compactHotBot({ id: 43, level: 20, party: { id: 'autonomous', leader: { id: 44 }, role: 'healer' } });
    assert.strictEqual(background.party.id, 'autonomous');
} finally { World.user = originalUser; }
console.log('Observer party identities: player leaders, companions, autonomous parties and solo players passed');
const Atlas = require('../src/WorldObserver/public/mapAtlas');
const Areas = invoke('GameServer/World/WorldAreaCatalog');
for (const area of Areas.AREAS) {
    const anchor = area.mapAnchor;
    if (!anchor) continue;
    const tileX = Math.floor(anchor.locX / Atlas.metadata.blockSize) + Atlas.metadata.x.mid;
    const tileY = Math.floor(anchor.locY / Atlas.metadata.blockSize) + Atlas.metadata.y.mid;
    assert.strictEqual(Atlas.hidden(tileX, tileY), false, `${area.name} entrance must retain its surface tile`);
}
