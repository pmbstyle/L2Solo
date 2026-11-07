const assert = require('node:assert/strict');
require('../src/Global');
const Clan = invoke('GameServer/Clan/ClanService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const ClanMenu = invoke('GameServer/World/Generics/NpcBypasses/Clan');
const Social = invoke('GameServer/Clan/ClanSocialRuntime');
const saved = { user: World.user, clans: Database.fetchClans, members: Database.fetchClanCharacters, sync: Social.syncMemberships };
const packets = [];
function row(level, classId) {
    return { characterId: 101, characterName: 'HalenAsh', phase: 'cold', level,
        statsJson: JSON.stringify({ classId, clanId: 1 }) };
}
function values(packet) {
    assert.equal(packet[0], 0x54);
    let p = 1;
    while (packet.readUInt16LE(p)) p += 2;
    return [packet.readInt32LE(p + 2), packet.readInt32LE(p + 6), packet.readInt32LE(p + 18)];
}
(async () => {
    Database.fetchClans = async () => [{ id: 1, name: 'TestClan', leaderId: 100 }];
    Database.fetchClanCharacters = async () => [{ id: 101, name: 'HalenAsh', clanId: 1, level: 11, classId: 10 }];
    Social.syncMemberships = () => {};
    World.user = { sessions: [{ fetchAccountId: () => 'leader', actor: { isDead: () => false, fetchId: () => 100, fetchClanId: () => 1, fetchIsOnline: () => true },
        dataSendToMe: packet => packets.push(packet) }] };
    await Clan.reload();
    Life.acceptLifecycleRow(row(12, 10));
    assert.deepEqual(values(packets.at(-1)), [12, 10, 101]);
    Life.acceptLifecycleRow(row(12, 10));
    assert.equal(packets.length, 1, 'unchanged snapshots do not flood the client');
    const current = Life.cachedState(101);
    Life.acceptSimulationOwnership(101, {}, { ...current, level: 20, stats: { ...current.stats, classId: 39 } });
    assert.deepEqual(values(packets.at(-1)), [20, 39, 101], 'worker commits update level and class');
    await Clan.reload(); // Simulate an older clan-cache snapshot.
    const menuSession = { actor: World.user.sessions[0].actor,
        activeNpcTalk: { objectId: 1234 }, dataSendToMe: packet => packets.push(packet) };
    const memberHtml = () => packets.at(-1).subarray(5).toString('utf16le');
    ClanMenu(menuSession, ['clan', 'members']);
    assert.match(memberHtml(), /HalenAsh Lv.20/, 'NPC menu reads current cold level despite stale clan cache');
    const refreshed = Clan.refreshOnlineMembers(Clan.findById(1)).members[0];
    assert.equal(refreshed.level, 20);
    assert.equal(refreshed.classId, 39);
    assert.equal(refreshed.online, true);
    // The bot's actor enters the world (registered, as a login or a cold->hot activation does).
    World.insertUser({ fetchAccountId: () => 'bot_halen', dataSendToMe() {}, actor: { fetchId: () => 101, fetchClanId: () => 1,
        fetchIsOnline: () => true, fetchName: () => 'HalenAsh', fetchLevel: () => 21, fetchClassId: () => 39,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 } });
    assert.equal(Clan.liveMember(refreshed).level, 21, 'active actor takes precedence over cold snapshot');
    ClanMenu(menuSession, ['clan', 'members']);
    assert.match(memberHtml(), /HalenAsh Lv.21/, 'NPC menu prefers active actor level');
    const count = packets.length;
    Life.acceptLifecycleRow(row(19, 10));
    assert.equal(packets.length, count, 'stale cold updates cannot overwrite an active actor');
    console.log('Clan cold progress: level, class, worker updates, deduplication and hot precedence passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    World.user = saved.user;
    Database.fetchClans = saved.clans; Database.fetchClanCharacters = saved.members;
    Social.syncMemberships = saved.sync;
});
