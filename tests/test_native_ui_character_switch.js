const assert = require('node:assert/strict');
require('../src/Global');
const Session = invoke('GameServer/Session');
const Items = invoke('GameServer/World/Generics/NpcBypasses/NativeItems');
const Locations = invoke('GameServer/World/Generics/NativeItemLocations');
const Reset = invoke('GameServer/World/Generics/NativeUiSession');
const Requests = invoke('GameServer/World/Generics/NativeItemRequests');
const Friends = invoke('GameServer/Bot/AI/BotFriendship');
const NativeFriends = invoke('GameServer/World/Generics/NpcBypasses/NativeFriends');
const FriendsMenu = invoke('GameServer/World/Generics/NpcBypasses/BotFriends');
const Menu = invoke('GameServer/World/Generics/NpcBypasses/NativeMenu');
const Speak = invoke('GameServer/Network/Request/Speak');
const World = invoke('GameServer/World/World');

async function main() {
    const packets = [], session = Object.create(Session.prototype);
    session.dataSendToMe = (p) => packets.push(p);
    const select = (id) => session.setActor({ id, name: `Player${id}`, items: [], paperdoll: {}, locX: 82698, locY: 148638, locZ: 0 });
    select(1);
    Object.assign(session, { nativeItemsVersion: 1, nativeItemsEpoch: 4, nativeItemsRevision: 8,
        nativeItemsView: { tab: 'map', places: [{ id: 1 }] }, nativeItemsOpen: true,
        nativeFinderVisible: ['OldBot'], nativeFriendsVisible: [{ id: 9 }], nativeStatusView: { name: 'OldBot' },
        nativeMenuVersion: 1, nativeArenaOpen: true, nativePartyUiOpen: true,
        botFriendsView: { mode: 'add' }, botStatusName: 'OldBot', botPartyCatalogState: { page: 9 },
        playerBoardView: { town: 'Giran', selfId: 57 }, playerBoardNavigation: { cursors: [{ selfId: 57, n: 1 }] },
        playerBoardSearch: 'Shield', playerBoardWaypoint: { x: 7, y: 8, z: 9 },
        playerBoardPreparation: { preparationId: 'stale-board-consent' } });
    session.questWaypoints.set('old', [1, 2, 3]);
    Locations.track(session, { x: 4, y: 5, z: 6 }); Menu.open(session);
    const epoch = session.nativeMenuEpoch;
    for (let i = 0; i < 5; i++) Requests.run(session, () => {});
    select(2);
    assert.equal(session.nativeItemsVersion, 1); assert.equal(session.nativeMenuVersion, 1);
    assert.equal(session.nativeItemsEpoch, 4); assert.equal(session.nativeItemsRevision, 8);
    for (const field of ['nativeItemsWaypoint', 'nativeItemsView', 'nativeItemsOpen', 'nativeFinderVisible',
        'nativeFriendsVisible', 'nativeStatusView', 'nativeMenuOpen', 'nativeArenaOpen', 'nativePartyUiOpen',
        'botFriendsView', 'botStatusName', 'botPartyCatalogState', 'playerBoardView', 'playerBoardNavigation',
        'playerBoardSearch', 'playerBoardWaypoint', 'playerBoardPreparation']) assert.equal(session[field], undefined, field);
    assert.equal(session.questWaypoints.size, 0);
    const consume = Speak.consume;
    let executed = 0;
    try {
        Speak.consume = () => executed++;
        Menu(session, ['native-menu', 'run', String(epoch), '9']);
        Menu.open(session); Menu(session, ['native-menu', 'run', String(epoch), '9']);
        assert.equal(executed, 0, 'old menu epoch cannot sell new character inventory');
    } finally { Speak.consume = consume; }
    Items.open(session);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(session.nativeItemsView.tab, 'list');
    assert.equal(session.nativeItemsWaypoint, undefined, 'new character does not inherit Stop tracking');

    // A finishes after B starts: A neither invites bots nor releases B's busy guard.
    const selected = Friends.selected, invite = World.inviteFriendByName, render = FriendsMenu.renderNative;
    const finishes = [], invited = []; let renders = 0;
    try {
        Friends.selected = () => new Promise((resolve) => finishes.push(resolve));
        World.inviteFriendByName = async (_s, actor) => { invited.push(actor.fetchId()); return true; };
        FriendsMenu.renderNative = async () => { renders++; };
        const prepare = () => Object.assign(session, { nativeFriendsVersion: 1, nativeFriendsOpen: true, botFriendsView: { mode: 'friends', page: 0 } });
        prepare(); const a = NativeFriends(session, ['native-friends', 'form']);
        select(3); prepare(); const b = NativeFriends(session, ['native-friends', 'form']);
        const busy = session.nativeFriendsBusy;
        finishes[0]([{ name: 'CompanionA' }]); await a;
        assert.equal(session.nativeFriendsBusy, busy); assert.deepEqual(invited, []);
        finishes[1]([{ name: 'CompanionB' }]); await b;
        assert.deepEqual(invited, [3]); assert.equal(renders, 1); assert.equal(session.nativeFriendsBusy, false);
        prepare(); const leaving = NativeFriends(session, ['native-friends', 'form']);
        Locations.track(session, { x: 4, y: 5, z: 6 });
        Reset.reset(session, { clearDirection: true }); finishes[2]([{ name: 'TooLate' }]); await leaving;
        assert.deepEqual(invited, [3], 'returning to selection cancels continuation even before actor replacement');
        assert.equal(packets.at(-1)[0], 0xeb);
        assert.equal(packets.at(-1).readInt32LE(1), 2, 'leaving world clears the actual client arrow too');
    } finally { Friends.selected = selected; World.inviteFriendByName = invite; FriendsMenu.renderNative = render; Requests.cancel(session); }
    console.log('Native UI character switch: real Session/Actor, Track reset, capability retention, stale menu/queued work and async party isolation passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
