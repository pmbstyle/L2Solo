'use strict';
// Caches on the wish-review path (L22): invoke() reuse, power numbers by
// build, and the drop-source index kept across spot-less callers. Each must
// give exactly what the uncached code gives.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-cost-caches-'));
delete process.env.L2NODE_CONFIG_SHARED_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ItemIndex = invoke('GameServer/Item/ItemTemplateIndex');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (error) { failures++; console.error(`not ok - ${name}\n${error.stack}`); }
}

const POWER = ['pAtk', 'mAtk', 'atkSpd', 'castSpd', 'pDef', 'mDef', 'maxHp'];
const subset = profile => Object.fromEntries(POWER.map(key => [key, profile[key]]));
const weapon = Data.items.find(item => String(item.template?.kind || '').startsWith('Weapon.') && item.etc?.rank === 'c'
    && Number(item.stats?.pAtk) > 0);
const armor = Data.items.find(item => String(item.template?.kind || '').startsWith('Armor.') && item.etc?.rank === 'c'
    && Number(item.etc?.slot) === 10);
assert.ok(weapon && armor, 'fixture items');
const row = (item, enchant = 0, equipped = true) => ({ selfId: Number(item.selfId), amount: 1, equipped,
    equippedCount: Number(equipped), slot: Number(item.etc.slot), enchant,
    instances: [{ id: 9000 + Number(item.selfId), selfId: Number(item.selfId), amount: 1, equipped, slot: Number(item.etc.slot), enchant }] });
const base = (patch = {}) => ({ characterId: 77, level: 52, adena: 1000, exp: 1,
    inventory: { [weapon.selfId]: row(weapon), [armor.selfId]: row(armor) },
    stats: { classId: 2, hennas: [], coldCombat: Profile.legacySnapshot({ stats: { classId: 2 }, level: 52 }, [], 0) }, ...patch });

check('invoke() returns the module require() returns, reloads after a cache delete, follows replaced exports', () => {
    const file = require.resolve('../src/GameServer/Formulas');
    const first = invoke('GameServer/Formulas');
    assert.equal(first, require(file));
    assert.equal(invoke('GameServer/Formulas'), first);
    const saved = require.cache[file];
    delete require.cache[file];
    const reloaded = invoke('GameServer/Formulas');
    assert.notEqual(reloaded, first);
    assert.equal(reloaded, require(file));
    require.cache[file].exports = { replaced: true };
    assert.equal(invoke('GameServer/Formulas').replaced, true);
    require.cache[file] = saved;
    assert.equal(invoke('GameServer/Formulas'), first);
});

check('power numbers equal the full profile, for the base build and each change', () => {
    const now = Date.now();
    const variants = [
        base(),
        base({ inventory: { ...base().inventory, [weapon.selfId]: row(weapon, 3) } }),
        base({ inventory: { [armor.selfId]: row(armor) } }),
        base({ inventory: { ...base().inventory, [weapon.selfId]: row(weapon, 0, false) } }),
        base({ level: 53 }),
        base({ stats: { ...base().stats, hennas: [1] } }),
        base({ stats: { ...base().stats, classId: 3, coldCombat: Profile.legacySnapshot({ stats: { classId: 3 }, level: 52 }, [], 0) } })
    ];
    const seen = new Set();
    for (const state of variants) {
        const power = Profile.buildGainsFor(state, now).power;
        assert.deepEqual(power, subset(Profile.profileFor(state, now)));
        assert.deepEqual(Profile.powerFor(state, now), power);
        seen.add(JSON.stringify(power));
    }
    assert.ok(seen.size >= 5, `changes must change the power (${seen.size} distinct)`);
});

check('an ordinary fight (adena, exp) keeps the build entry; a gain is computed once per build', () => {
    const now = Date.now();
    const entry = Profile.buildGainsFor(base(), now);
    assert.equal(Profile.buildGainsFor(base({ adena: 999999, exp: 5000 }), now), entry);
    let computed = 0;
    const compute = () => { computed++; return { attack: 0.25, defence: 0.5 }; };
    assert.deepEqual(Profile.gainFor(entry, 'p:test', compute), { attack: 0.25, defence: 0.5 });
    assert.deepEqual(Profile.gainFor(Profile.buildGainsFor(base({ adena: 5 }), now), 'p:test', compute), { attack: 0.25, defence: 0.5 });
    assert.equal(computed, 1);
});

check('gear gains from the store equal the direct calculation, per role', () => {
    const now = Date.now();
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const better = Data.items.find(item => String(item.template?.kind || '').startsWith('Weapon.') && item.etc?.rank === 'b'
        && Number(item.stats?.pAtk) > Number(weapon.stats.pAtk));
    const direct = (state, caster) => {
        const before = Profile.powerFor(state, now);
        const inventory = Object.fromEntries(Object.entries(state.inventory).map(([key, row]) => [key,
            Number(row.slot) === Number(better.etc.slot) ? { ...row, equipped: false, equippedCount: 0, equippedSlots: [] } : row]));
        inventory[better.selfId] = { selfId: Number(better.selfId), amount: 1, equipped: true, equippedCount: 1, slot: Number(better.etc.slot), enchant: 0 };
        const after = Profile.powerFor({ ...state, inventory }, now);
        const attack = caster ? 'mAtk' : 'pAtk';
        return { attack: Math.max(0, after[attack] / Math.max(1, before[attack]) - 1),
            defence: Math.max(0, 1 - before.pDef / Math.max(1, after.pDef), 1 - before.mDef / Math.max(1, after.mDef)) };
    };
    const fighter = base({ characterId: 501 }), mage = base({ characterId: 502, stats: { ...base().stats, role: 'nuker' } });
    assert.deepEqual(Providers.gearGain(fighter, better, now), direct(fighter, false));
    assert.deepEqual(Providers.gearGain(mage, better, now), direct(mage, true));
    assert.deepEqual(Providers.gearGain(fighter, better, now), direct(fighter, false), 'remembered value is the same');
});

check('a build entry is shared by its owners and dies with the last one', () => {
    const now = Date.now();
    const a = base({ characterId: 601, level: 47 }), b = base({ characterId: 602, level: 47 });
    const shared = Profile.buildGainsFor(a, now);
    assert.equal(Profile.buildGainsFor(b, now), shared, 'equal builds share');
    const levelled = base({ characterId: 601, level: 60 });
    assert.notEqual(Profile.buildGainsFor(levelled, now), shared);
    assert.equal(Profile.buildGainsFor(b, now), shared, 'still owned by the other bot');
    Profile.forgetBuild(602);
    assert.notEqual(Profile.buildGainsFor(base({ characterId: 603, level: 47 }), now), shared, 'the last owner gone, the entry is gone');
});

check('no inventory and an empty inventory are different builds', () => {
    const now = Date.now();
    const none = base(); delete none.inventory;
    const empty = base({ inventory: {} });
    assert.notEqual(Profile.buildGainsFor(none, now), Profile.buildGainsFor(empty, now));
    assert.deepEqual(Profile.buildGainsFor(none, now).power, subset(Profile.profileFor(none, now)));
    assert.deepEqual(Profile.buildGainsFor(empty, now).power, subset(Profile.profileFor(empty, now)));
});

check('a timed effect counts while active and not after it expires', () => {
    const now = Date.now();
    const effect = { id: 1068, key: 'might', category: 'buff', expiresAt: now + 60000, stats: { pAtkMul: 1.15 } };
    const state = base();
    state.stats.coldCombat = { ...state.stats.coldCombat, effects: [effect] };
    const active = Profile.buildGainsFor(state, now).power, expired = Profile.buildGainsFor(state, now + 120000).power;
    assert.deepEqual(active, subset(Profile.profileFor(state, now)));
    assert.deepEqual(expired, subset(Profile.profileFor(state, now + 120000)));
    assert.ok(active.pAtk > expired.pAtk);
    const recast = base();
    recast.stats.coldCombat = { ...recast.stats.coldCombat, effects: [{ ...effect, expiresAt: now + 90000, sequence: 7 }] };
    assert.equal(Profile.buildGainsFor(recast, now), Profile.buildGainsFor(state, now), 'a recast of the same buff is the same build');
});

check('a caller without spots gets no sources and keeps the index built for the real spot list', () => {
    const reward = (Data.npcRewards || []).find(npc => (npc.rewards || []).some(group => (group.items || []).length));
    const npc = ItemIndex.find(Data.npcs, reward.selfId);
    const spots = [{ id: 'fixture', npcEntries: [{ selfId: Number(reward.selfId), name: npc?.template?.name, count: 3 }] }];
    const index = Planner.sourceIndexFor(spots);
    assert.ok(index.size > 0);
    assert.equal(Planner.sourceIndexFor([]).size, 0);
    assert.equal(Planner.sourceIndexFor(undefined).size, 0);
    assert.equal(Planner.sourceIndexFor(spots), index);
});

check('per-actor wish results are bounded, least recently used out, a reused actor kept', () => {
    const { WishNetwork, remember, ACTOR_LIMIT } = invoke('GameServer/Bot/Economy/WishNetwork');
    const map = new Map();
    for (let i = 0; i < ACTOR_LIMIT; i++) remember(map, `character:${i}`, i);
    remember(map, 'character:0', 0);
    remember(map, 'group:after', 1);
    assert.equal(map.size, ACTOR_LIMIT);
    assert.ok(map.has('character:0'), 'a reused actor stays');
    assert.ok(!map.has('character:1'), 'the oldest unused actor leaves');
    const engine = new WishNetwork();
    for (let i = 0; i < ACTOR_LIMIT + 40; i++) engine.build({ actorKey: `character:${i}`, inputKey: 'k', nodes: [], roots: [] });
    assert.equal(engine.cache.size, ACTOR_LIMIT);
});

check('the board keeps a change token per item: a line of one item does not touch another', () => {
    const { BoardIndex, SELL } = invoke('GameServer/AfkTrade/BoardIndex');
    const board = new BoardIndex();
    const a0 = board.itemRevision(100), b0 = board.itemRevision(200);
    board.put({ id: 1, kind: 'shop', storeType: SELL, ownerId: 5, lines: [{ lineId: 1, selfId: 100, count: 1, price: 10 }] });
    const a1 = board.itemRevision(100);
    assert.notEqual(a1, a0);
    assert.equal(board.itemRevision(200), b0);
    board.remove(1);
    assert.notEqual(board.itemRevision(100), a1);
    const b1 = board.itemRevision(200);
    board.clear();
    assert.notEqual(board.itemRevision(200), b1);
    assert.notEqual(new BoardIndex().itemRevision(100), board.itemRevision(100), 'another board is another source');
});

check('a wish review is rebuilt only by changes on items it read (design 16.5)', () => {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    const { BoardIndex, SELL } = invoke('GameServer/AfkTrade/BoardIndex');
    const board = new BoardIndex();
    const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    const deps = { board, spots };
    const state = { characterId: 902, phase: 'cold', activity: 'hunting', level: 35, adena: 50,
        inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 } },
        loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const context = Economy.forState(state, deps);
    assert.equal(Economy.forState(state, deps), context);
    // a line and a deal of an item nobody here looked at
    const unread = 1 + Math.max(...Data.items.map(item => Number(item.selfId)));
    board.put({ id: 11, kind: 'shop', storeType: SELL, ownerId: 7, lines: [{ lineId: 1, selfId: unread, count: 1, price: 10 }] });
    assert.equal(Economy.forState(state, deps), context, 'another item on the board rebuilds nobody');
    // an item the review priced while it was built
    const wished = context.network.queue.map(wish => Number(wish.object?.itemId)).find(Boolean);
    assert.ok(wished, 'fixture: a wished item');
    board.put({ id: 12, kind: 'shop', storeType: SELL, ownerId: 7, lines: [{ lineId: 1, selfId: wished, count: 1, price: 10 }] });
    const rebuilt = Economy.forState(state, deps);
    assert.notEqual(rebuilt, context, 'a line of a wished item rebuilds');
    assert.equal(Economy.forState(state, deps), rebuilt);
    // a deal in the counter of an item the review read
    Counters.deal(wished, 1000, 1, Date.now(), 7, null, 8);
    const afterDeal = Economy.forState(state, deps);
    assert.notEqual(afterDeal, rebuilt, 'a deal in the counter of a read item rebuilds');
    // an item first read later through the context (worth) joins the watched items
    const lazy = Data.items.map(item => Number(item.selfId)).find(id => id > 1000 && id !== wished && afterDeal.price(id) >= 0);
    assert.equal(Economy.forState(state, deps), afterDeal);
    board.put({ id: 13, kind: 'shop', storeType: SELL, ownerId: 7, lines: [{ lineId: 1, selfId: lazy, count: 1, price: 10 }] });
    assert.notEqual(Economy.forState(state, deps), afterDeal, 'a later price read is watched too');
    // a later board look through the context (a market look) does not widen the review's inputs
    const held = Economy.forState(state, deps);
    const looked = Data.items.map(item => Number(item.selfId)).find(id => id > 2000 && id !== wished && id !== lazy);
    held.board.first(looked, SELL);
    board.put({ id: 14, kind: 'shop', storeType: SELL, ownerId: 7, lines: [{ lineId: 1, selfId: looked, count: 1, price: 10 }] });
    assert.equal(Economy.forState(state, deps), held, 'a board look after the review is not its input');
});

check('basics() and stockFor() give what forState gives, without building a network', () => {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
    const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: Date.now() };
    for (const level of [20, 35, 52]) {
        const state = { characterId: 950 + level, phase: 'cold', activity: 'hunting', level, adena: 5000,
            inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 }, 1835: { selfId: 1835, amount: 40 } },
            loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
            stats: { classId: 1, exp: Data.experience[level - 1], persona: { traits: { commitment: .7, caution: .4,
                resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .6 } },
            timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
        Economy.reset();
        const full = Economy.forState(state, deps);
        const alone = Economy.basics(state, deps);
        for (const kind of ['shots', 'potions']) assert.deepEqual(Economy.stockFor(state, kind, deps), full.stock(kind), `${kind} at ${level}`);
        for (const field of ['deathHours', 'riskWeight', 'lostGearHours', 'karmaHours', 'expectedDeathHours', 'bestSpotId'])
            assert.deepEqual(alone[field], full[field], `${field} at ${level}`);
        assert.deepEqual(alone.hunt, full.hunt);
    }
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
