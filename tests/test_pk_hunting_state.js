const assert = require('assert');

require('../src/Global');

const PkHunting = invoke('GameServer/Bot/AI/States/PkHuntingState');
const World = invoke('GameServer/World/World');

function actor(id, level, x, options = {}) {
    return {
        fetchId: () => id,
        fetchLevel: () => level,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchKarma: () => options.karma || 0,
        fetchIsOnline: () => options.online !== false,
        fetchDestId: () => options.destId,
        state: { fetchDead: () => !!options.dead }
    };
}

const profile = {
    anchor: { locX: 0, locY: 0, locZ: 0 },
    activationRadius: 7000,
    targetMinLevel: 30,
    targetMaxLevel: 42
};
const pk = actor(1, 38, 0);
const eligiblePlayer = { accountId: 'slava', actor: actor(2, 35, 500) };
const highPlayer = { accountId: 'high', actor: actor(3, 50, 500) };
const bot = { accountId: 'bot_other', actor: actor(4, 35, 500) };

assert.strictEqual(PkHunting.isEligibleTarget(eligiblePlayer, pk, profile), true);
assert.strictEqual(PkHunting.isEligibleTarget(highPlayer, pk, profile), false, 'PK must not target actors outside its level band');
assert.strictEqual(PkHunting.isEligibleTarget(bot, pk, profile), true, 'PKs should also hunt ordinary bots in an occupied zone');
assert.strictEqual(PkHunting.isEligibleAttacker(highPlayer, pk, profile), true, 'a stronger real player remains relevant once they attack the PK');

const originalUsers = World.user;
World.user = { sessions: [eligiblePlayer, highPlayer, bot] };
assert.strictEqual(PkHunting.activeThreats(pk, profile).length, 1, 'a nearby player far above the PK level is an immediate threat even before selecting the PK');
eligiblePlayer.actor = actor(2, 35, 500, { destId: 1 });
assert.strictEqual(PkHunting.activeThreats(pk, profile).length, 2, 'a player explicitly targeting the PK is also a threat');
World.user = originalUsers;

const ordinary = { plan: 'pk_hunting', currentTargetId: 2, currentSpot: { id: 'old' }, noTargetTicks: 10 };
PkHunting.tick(ordinary, actor(5, 27, 0, { karma: 190 }));
assert.strictEqual(ordinary.plan, 'hunting', 'a normal red bot must resume PvE instead of stalling without an encounter profile');
assert.strictEqual(ordinary.currentTargetId, undefined, 'recovery must release the old player target');
assert.strictEqual(ordinary.currentSpot, null, 'recovery must reselect a hunting spot after chaotic respawn');

console.log('PK hunting state checks passed');
