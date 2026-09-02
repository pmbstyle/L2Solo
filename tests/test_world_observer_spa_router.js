const assert = require('assert');

const Router = require('../src/WorldObserver/public/spaRouter');

assert.deepStrictEqual(Router.parse('/observer/'), { name: 'world' });
assert.deepStrictEqual(Router.parse('/observer/world'), { name: 'world' });
assert.deepStrictEqual(Router.parse('/observer/?npc=135'), { name: 'world', npcId: 135 });
assert.deepStrictEqual(Router.parse('/observer/clans'), { name: 'clans', id: null });
assert.deepStrictEqual(Router.parse('/observer/clans/6000032'), { name: 'clans', id: 6000032 });
assert.deepStrictEqual(Router.parse('/observer/clans/6000032/map'), { name: 'world', clanId: 6000032 });
assert.deepStrictEqual(Router.parse('/observer/actors/bot/42'), { name: 'actor', kind: 'bot', id: 42 });
assert.deepStrictEqual(Router.parse('/observer/actors/player/7'), { name: 'actor', kind: 'player', id: 7 });
assert.deepStrictEqual(Router.parse('/observer/raid-bosses/29001'), { name: 'raid-bosses', id: 29001 });
assert.deepStrictEqual(Router.parse('/observer/database'), { name: 'knowledge-items', id: null });
assert.deepStrictEqual(Router.parse('/observer/database/items/1'), { name: 'knowledge-items', id: 1 });
assert.deepStrictEqual(Router.parse('/observer/database/npcs'), { name: 'knowledge-npcs', id: null });
assert.deepStrictEqual(Router.parse('/observer/database/npcs/135'), { name: 'knowledge-npcs', id: 135 });
assert.deepStrictEqual(Router.parse('/observer/not-a-route'), { name: 'not-found' });

assert.strictEqual(Router.href({ name: 'world' }), '/observer/');
assert.strictEqual(Router.href({ name: 'clans', id: 6000032 }), '/observer/clans/6000032');
assert.strictEqual(Router.href({ name: 'world', clanId: 6000032 }), '/observer/clans/6000032/map');
assert.strictEqual(Router.href({ name: 'world', npcId: 135 }), '/observer/?npc=135');
assert.strictEqual(Router.href({ name: 'knowledge-items', id: 1 }), '/observer/database/items/1');
assert.strictEqual(Router.href({ name: 'knowledge-npcs' }), '/observer/database/npcs');
assert.strictEqual(Router.href({ name: 'actor', kind: 'player', id: 7 }), '/observer/actors/player/7');
assert.strictEqual(Router.isAppPath('/observer/styles.css'), false);

console.log('World observer SPA router checks passed');
