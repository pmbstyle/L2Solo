'use strict';
// A bot buys shots when they add exp and the best hunt with them still earns
// its shots at the bot's buy price (x1, the built spot table): a B-grade bot
// with Adena and no shots puts them in its kit and its restock buys them,
// though the shots cost a larger share of the hunt's money than the share of
// exp they add (the faster kills' extra Adena pays for them).
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Shots = invoke('GameServer/Inventory/ShotStock');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');

const level = 52;
const weapon = Data.items.find(row => row.etc?.rank === 'b' && row.etc?.slot === 7
    && String(row.template?.kind).startsWith('Weapon.') && row.etc.soulshot > 0);
assert(weapon, 'a one-handed B-grade weapon that fires soulshots');
const role = Table.roleFor({ level, stats: { classId: 2 } });
const best = Table.best(role, level, true);
assert(best?.spotId, 'the gladiator role has a charged row at L52');
const state = { characterId: 77, name: 'B shots', phase: 'cold', activity: 'hunting', level, spotId: best.spotId,
    adena: 100000, inventory: { [weapon.selfId]: { selfId: weapon.selfId, amount: 1, equipped: true, slot: 7 },
        736: { selfId: 736, amount: 1 } }, stats: { classId: 2, role }, loc: { locX: 0, locY: 0, locZ: 0 }, timing: {} };
const deps = { board: { first: () => null }, spots: [], workshops: null, knownRecipes: [],
    npcOffersFor: () => [], timestamp: 1800000000000, persona: { traits: {}, understanding: 1 } };

const context = Economy.basics(state, deps);
const stock = context.stock('shots');
assert.equal(stock.itemId, 1465, 'the kit holds B-grade soulshots');
assert.ok(stock.target > 0, `an empty kit asks for B shots (target ${stock.target})`);
const restock = Shots.restockPlan(state, { context });
assert.ok(restock.amount > 0, `the restock buys B shots (amount ${restock.amount})`);

// Every table role at L52 with its B-grade shots, holding none: most buy them.
let roles = 0, buy = 0;
for (const tableRole of Table.roles()) {
    const classId = Table.roleClass(tableRole, level);
    const probe = { classId, level, inventory: {}, stats: {} };
    const base = Shots.planFor({ classId, rank: 'b' });
    const plan = { ...base, perAction: Math.max(1, base.perAction || 0) };
    const row = Table.best(Table.roleFor(probe), level, Shots.shotRows(plan));
    if (!row) continue;
    roles++;
    if (Shots.usePolicy(probe, { plan, bestTable: row }).purchaseUsePerHour > 0) buy++;
}
assert.ok(roles >= 30, `table roles read (${roles})`);
assert.ok(buy >= 25, `B L52 roles that buy shots with an empty bag: ${buy} of ${roles}`);
console.log(`PASS x1 B L52: an empty kit buys B shots; ${buy} of ${roles} table roles buy`);
