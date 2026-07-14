const assert = require('assert');

require('../src/Global');

const Observer = invoke('WorldObserver/WorldObserverServer');

function actor(karma = 0) {
    return {
        fetchId: () => 42,
        fetchName: () => 'Kharz',
        fetchLevel: () => 46,
        fetchLocX: () => 76576,
        fetchLocY: () => 50151,
        fetchLocZ: () => -3200,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 50,
        fetchMaxMp: () => 50,
        fetchIsOnline: () => true,
        fetchKarma: () => karma
    };
}

const player = Observer.compactPlayer({ actor: actor(720) });
assert.strictEqual(player.isPk, true, 'red-name players must be marked for the observer map');

const hotBot = Observer.compactHotBot({
    id: 42,
    name: 'Kharz',
    level: 46,
    classId: 44,
    mode: 'pk_hunting',
    intent: 'hunting',
    role: 'dps',
    home: null,
    loc: { locX: 76576, locY: 50151, locZ: -3200 },
    vitals: {},
    available: true
}, new Set([42]));
assert.strictEqual(hotBot.isPk, true, 'hot PK bots must be marked for red rendering');

const coldPk = Observer.compactStateBot({
    characterId: 43,
    name: 'Cold PK',
    level: 20,
    phase: 'cold',
    activity: 'pk_hunting',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {}
}, new Set());
assert.strictEqual(coldPk.isPk, true, 'stored PK encounters must remain marked between activations');

console.log('World Observer PK marker checks passed');
