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
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
PartyState.acceptRow({ partyId: 'row', leaderId: 12, memberIdsJson: '[11,12,13]', status: 'active', statsJson: '{}' });
const coldMember = { characterId: 11, name: 'Cold member', level: 20, party: { partyId: 'row', role: 'dps', leaderId: 9 }, stats: { leaderId: 9 } };
const cold = Observer.compactStateBot(coldMember, new Set(), { characterId: 12, name: 'New leader', stats: {} });
assert.strictEqual(cold.party.leaderId, 12, 'a cold bot shows the leader of the party row, not its own stale copy');
assert.strictEqual(cold.party.leader.id, 12);
const member = (id, name, leaderId, leaderName) => ({ id, name, kind: 'bot', level: 20,
    party: { id: 'stale', leaderId, leader: { id: leaderId, name: leaderName } } });
const [handed] = Pages.groupParties([member(1, 'Kept', 9, 'Departed'), member(2, 'Named', 2, 'Named')]);
assert.strictEqual(handed.leader.name, 'Named', 'the leader comes from a member of the group, whichever copy is read first');
assert.strictEqual(handed.name, 'Named');
const [leaderless] = Pages.groupParties([member(1, 'Kept', 9, 'Departed')]);
assert.strictEqual(leaderless.leader, undefined, 'a leader outside the group leads nothing here');
assert.strictEqual(leaderless.name, 'Adventuring party', 'no stale name of a departed leader');
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
