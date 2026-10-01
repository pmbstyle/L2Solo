const assert = require('assert');
const { groupParties, filterCharacters, paginate } = require('../src/WorldObserver/public/playerPages');
const Router = require('../src/WorldObserver/public/spaRouter');
const Atlas = require('../src/WorldObserver/public/mapAtlas');

const actors = [
    { id: 11, kind: 'bot', name: 'Leader', level: 40, classId: 0, area: { id: 'cruma', name: 'Cruma Tower' }, party: { id: 'p1', leaderId: 11 } },
    { id: 12, kind: 'bot', name: 'Healer', level: 30, classId: 49, party: { id: 'p1', leaderId: 11, role: 'healer' } },
    { id: 13, kind: 'bot', name: 'Merchant', level: 20, staticService: true },
    { id: 14, kind: 'bot', name: 'Crafter', level: 20, role: 'crafter' },
    { id: 15, kind: 'player', name: 'Player', level: 50 }
];
const parties = groupParties([...actors, actors[0]]);
assert.strictEqual(parties.length, 1);
assert.strictEqual(parties[0].members.length, 2, 'duplicate updates must not add another member');
assert.strictEqual(parties[0].name, 'Leader');
assert.strictEqual(parties[0].averageLevel, 35);
assert.strictEqual(parties[0].location, 'Cruma Tower');
assert.deepStrictEqual(filterCharacters(actors, { kind: 'adventurers' }).map(a => a.id), [11, 12]);
assert.deepStrictEqual(filterCharacters(actors, { kind: 'services' }).map(a => a.id), [14, 13]);
assert.deepStrictEqual(filterCharacters(actors, { kind: 'players' }).map(a => a.id), [15]);
assert.deepStrictEqual(filterCharacters(actors, { query: 'CRUMA', classId: '0', areaId: 'cruma' }).map(a => a.id), [11]);
assert.deepStrictEqual(filterCharacters(actors, { minLevel: 31, maxLevel: 45 }).map(a => a.id), [11]);
const last = paginate(Array.from({ length: 1779 }, (_, i) => i), 99);
assert.strictEqual(last.page, 36);
assert.strictEqual(last.from, 1751);
assert.strictEqual(last.to, 1779);
assert.strictEqual(last.items.at(-1), 1778, 'all characters, including the last entry, must be reachable');
assert.strictEqual(paginate([], 2).from, 0);
assert.strictEqual(paginate([], 2).pages, 1);

const route = { name: 'characters', query: "Antharas' Lair", kind: 'adventurers', areaId: 'antharas_lair', classId: '0', sort: 'name', page: 3 };
assert.deepStrictEqual(Router.parse(Router.href(route)), route, 'directory filters must survive reload and sharing');
for (const route of [{ name: 'overview' }, { name: 'parties', query: 'Leader' }, { name: 'dungeon', id: 'cruma_tower' }, { name: 'world', areaId: 'cruma_tower' }, { name: 'market' }]) {
    assert.deepStrictEqual(Router.parse(Router.href(route)), route);
}
assert.strictEqual(Router.parse('/observer/dungeons/../secret').name, 'not-found');
assert.strictEqual(Atlas.hidden(20, 11), true, 'detached dungeon panels should be excluded');
assert.strictEqual(Atlas.hidden(25, 21), true, 'detached Antharas nest should be excluded');
for (const loc of [{ locX: -80826, locY: 149775 }, { locX: 83400, locY: 147943 }, { locX: -84318, locY: 244579 }, { locX: 147725, locY: -56517 }]) {
    const x = Math.floor(loc.locX / Atlas.metadata.blockSize) + Atlas.metadata.x.mid;
    const y = Math.floor(loc.locY / Atlas.metadata.blockSize) + Atlas.metadata.y.mid;
    assert.strictEqual(Atlas.hidden(x, y), false, 'towns must keep their surface map tiles');
    const point = Atlas.project(loc);
    assert(Math.abs(point.x / 900 - (loc.locX / 32768 + 4)) < 1e-9);
    assert(Math.abs(point.y / 900 - (loc.locY / 32768 + 7)) < 1e-9);
}
console.log('Observer player pages: directory filters, complete pagination, party grouping, shareable routes and atlas coordinates passed');
