const assert = require('assert');

const Filters = require('../src/WorldObserver/public/actorFilters');

const actors = [
    { id: 1, name: 'Starter', level: 1, classId: 0, className: 'Human Fighter' },
    { id: 2, name: 'Cleric', level: 24, classId: 15, className: 'Cleric' },
    { id: 3, name: 'Bishop', level: 45, classId: 16, className: 'Bishop' },
    { id: 4, name: 'Legacy', level: 52, build: { classId: 16, className: 'Bishop' } },
    { id: 5, name: 'Singer', level: 40, classId: 21 },
    { id: 6, name: 'Dancer', level: 45, classId: 34 }
];

const classCatalog = [
    { classId: 21, className: 'Swordsinger' },
    { classId: 34, className: 'Bladedancer' }
];

assert.strictEqual(Filters.isEligible({ kind: 'player', role: 'crafter', staticService: true }), true, 'real players must never be hidden by bot-service filters');
assert.strictEqual(Filters.isEligible({ kind: 'bot', role: 'dps', staticService: true }), false, 'static bot services must stay out of the map and roster');
assert.strictEqual(Filters.isEligible({ kind: 'bot', role: 'crafter', staticService: false }), false, 'adventuring crafters must stay out of the map and roster too');
assert.strictEqual(Filters.isEligible({ kind: 'bot', role: 'tank', staticService: false }), true);
assert.strictEqual(Filters.isSurfaceActor({ area: { mapLayer: 'dungeon' } }), false,
    'a dungeon without a known entrance must not use its interior coordinates on the surface atlas');
const projectedDungeon = {
    loc: { locX: 45596, locY: 247589, locZ: -6518 },
    area: { mapLayer: 'dungeon', mapAnchor: { locX: -113329, locY: 235327, locZ: -3653 } }
};
assert.strictEqual(Filters.isSurfaceActor(projectedDungeon), true,
    'a dungeon with a known entrance must be represented on the surface atlas');
assert.deepStrictEqual(Filters.mapLocation(projectedDungeon), projectedDungeon.area.mapAnchor,
    'dungeon actors must project to the authoritative entrance instead of their virtual interior coordinates');
assert.deepStrictEqual(Filters.mapLocation({ loc: { locX: 1, locY: 2, locZ: 3 } }), { locX: 1, locY: 2, locZ: 3 });
assert.strictEqual(Filters.isSurfaceActor({ area: { mapLayer: 'surface' } }), true);
assert.strictEqual(Filters.isSurfaceActor({}), true, 'legacy actors without area metadata remain on the surface atlas');
assert.strictEqual(Filters.actorKind(2, null, { players: [{ id: 2 }] }), 'player', 'party links must resolve real-player leaders from the snapshot');
assert.strictEqual(Filters.actorKind(2, 'bot', { players: [{ id: 2 }] }), 'bot', 'an explicit leader kind must remain authoritative');
assert.strictEqual(Filters.actorKind(3, null, { players: [{ id: 2 }] }), 'bot', 'unknown party leaders default to bots');
assert.strictEqual(Filters.matchesSelection({ id: 2, kind: 'player' }, { id: 2, kind: 'player' }), true,
    'a selected player must remain selectable in the shared actor UI');
assert.strictEqual(Filters.matchesSelection({ id: 2, kind: 'bot' }, { id: 2, kind: 'player' }), false,
    'a bot with the same numeric id must not steal the selected-player highlight');

assert.strictEqual(Filters.classKey(actors[0]), 'id:0', 'base profession id zero must remain filterable');
assert.strictEqual(Filters.className(actors[4], classCatalog), 'Swordsinger',
    'class metadata must resolve a Swordsinger when an actor only carries its class id');
assert.strictEqual(Filters.className(actors[5], classCatalog), 'Bladedancer',
    'class metadata must resolve a Bladedancer when an actor only carries its class id');
assert.deepStrictEqual(Filters.classOptions(actors.slice(4), classCatalog), [
    { key: 'id:34', label: 'Bladedancer' },
    { key: 'id:21', label: 'Swordsinger' }
], 'the class filter must retain both music classes when names come from the observer catalog');
assert.deepStrictEqual(Filters.classOptions([], classCatalog), [
    { key: 'id:34', label: 'Bladedancer' },
    { key: 'id:21', label: 'Swordsinger' }
], 'the class filter must expose catalog classes even when no actor currently has that profession');
assert.deepStrictEqual(Filters.classOptions(actors), [
    { key: 'id:16', label: 'Bishop' },
    { key: 'id:15', label: 'Cleric' },
    { key: 'id:0', label: 'Human Fighter' }
], 'class choices must be unique, named, and sorted for the filter menu');

assert.strictEqual(Filters.matches(actors[1], { minLevel: 20, maxLevel: 30, classKey: 'id:15' }), true);
assert.strictEqual(Filters.matches(actors[2], { minLevel: 20, maxLevel: 30, classKey: 'id:15' }), false, 'level bounds must apply together with class');
assert.strictEqual(Filters.matches(actors[3], { minLevel: 50, classKey: 'id:16' }), true, 'build metadata must support cold bot class filtering');
assert.strictEqual(Filters.matches({ name: 'Unknown' }, { minLevel: 1 }), false, 'unknown levels must not leak into a bounded view');
assert.strictEqual(Filters.normalizeLevel(0), 1);
assert.strictEqual(Filters.normalizeLevel(99), 80);
assert.strictEqual(Filters.normalizeLevel(''), null);

console.log('World Observer actor filter checks passed');
