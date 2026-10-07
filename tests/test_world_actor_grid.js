'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(root, 'src/Global'));
const World = invoke('GameServer/World/World');
const Runtime = invoke('GameServer/World/CharacterLocationRuntime');
const { ColdTableChannel } = invoke('GameServer/Bot/Population/ColdTableChannel');
const Source = invoke('GameServer/World/MainActorPublicationSource').native();
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').ColdSimulationCoordinator;
const oldUser = World.user, update = Runtime.index.updateSource;
let updates = 0, publications = 0, messages = 0;
const pause = () => new Promise(resolve => setImmediate(resolve));
const member = (id, x, y, bot = true) => {
    const actor = { x, y, online: true, fetchId: () => id, fetchLocX() { return this.x; }, fetchLocY() { return this.y; },
        fetchLocZ: () => 0, fetchIsOnline() { return this.online; } };
    const session = { actor, accountId: `${bot ? 'bot' : 'player'}_grid_${id}`, fetchAccountId() { return this.accountId; } };
    actor.session = session; World.insertUser(session); return session;
};
(async () => {
    World.user = { sessions: [], revision: 0 };
    const moving = member(7000001, 100, 100, false);
    const channel = new ColdTableChannel();
    channel.register('actors', { key: ref => ref.id, eventDriven: true, streamed: { source: Source, recipient: 'cold' } });
    channel.attach({}, 'grid-fixture', () => { messages++; return true; }, { streamedTables: ['actors'] });
    for (let i = 0; i < 20; i++) await pause();
    const stop = World.subscribeActorPublications(event => { if (event.cause === 'location') publications++; });
    Runtime.index.updateSource = function(...args) { updates++; return update.apply(this, args); };
    messages = 0;
    for (let i = 0; i < 1000; i++) { moving.actor.x = 100 + i % 500; World.updateUserLocation(moving); }
    for (let i = 0; i < 20; i++) await pause();
    assert.equal(updates, 0, '1000 steps inside one cell do not update the index');
    assert.equal(publications, 0); assert.equal(messages, 0);
    moving.actor.x = 6001; World.updateUserLocation(moving);
    assert.equal(updates, 1, 'one cell crossing files the live actor once');
    assert.deepEqual(World.actorSessionsNear({ locX: 6001, locY: 100 }, 0), [moving]);
    moving.currentSpot = { id: 'new-spot' }; World.updateUserLocation(moving);
    assert.equal(updates, 2, 'spot changes remain indexed');
    assert.equal(Runtime.index.inSpot('new-spot')[0].session, moving);
    let seed = 713;
    const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
    const sessions = [moving];
    for (let i = 0; i < 199; i++) sessions.push(member(7000002 + i, random() * 24000 - 12000, random() * 24000 - 12000, i > 1));
    const point = { locX: moving.actor.x, locY: moving.actor.y };
    const distance = session => (session.actor.x - point.locX) ** 2 + (session.actor.y - point.locY) ** 2;
    assert.deepEqual(new Set(World.fetchVisibleUsers(moving, moving.actor)),
        new Set(sessions.filter(session => session !== moving && distance(session) < 6000 ** 2)));
    assert.deepEqual(World.actorSessionsNear(point, 9000), sessions.filter(session => distance(session) <= 9000 ** 2));
    const humans = sessions.filter(session => session.accountId.startsWith('player_')).sort((a,b) => distance(a)-distance(b));
    assert.equal(World.nearestRealPlayer(point).session, humans[0]);
    const fixtureChannel = new ColdTableChannel();
    const coordinator = new Coordinator({ tableChannel: fixtureChannel });
    coordinator.workerEpoch = 'no-actor-reader'; coordinator.worker = { postMessage() {} };
    coordinator.attachTableChannel();
    assert.equal(fixtureChannel.tables.has('actors'), false, 'production coordinator has no actor recipient');
    coordinator.tableChannel.detach(coordinator);
    stop(); Runtime.index.updateSource = update;
    console.log('Actor grid: 1000 moves0updates/publications/messages, crossing1, 200actor exact sets/order and detached worker PASS');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Runtime.index.updateSource = update; World.user = oldUser;
});
