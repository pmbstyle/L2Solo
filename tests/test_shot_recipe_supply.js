'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
require('./helpers/progressionRate').useRate('x50');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Economy = require('../src/GameServer/Bot/Economy/EconomyContext');
const Providers = require('../src/GameServer/Bot/Economy/WishProviders');
const Planner = require('../src/GameServer/Bot/AI/GearAcquisitionPlanner');
const Profile = require('../src/GameServer/Bot/Population/ColdCombatProfile');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const ShotPolicy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Hunt = require('../src/GameServer/Bot/AI/HuntCycle');
const pos = { locX: 85396, locY: 147904, locZ: -3400 };
const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });

for (const [scroll, npcId, classId, level, kind] of [[1805,584,55,43,'spoil'],[3954,586,55,45,'spoil'],[3033,796,2,45,'drop']]) {
    const reward = Data.npcRewards.find(row => Number(row.selfId) === npcId);
    assert(reward, 'the test uses the real NPC rewards');
    const npc = Data.npcs.find(row => Number(row.selfId) === npcId);
    const mobLevel = Number(npc.template.level);
    const spot = { id: `scroll-source-${scroll}`, avgLevel: mobLevel, minLevel: mobLevel, maxLevel: mobLevel,
        levelCounts: { [mobLevel]: 10 }, capacity: 10, density: 10, center: pos,
        npcEntries: [{ selfId: npcId, count: 10, pull: 1 }], npcSelfIds: [npcId] };
    const state = { ...Hunt.referenceState(classId, level), characterId: 911000 + scroll,
        name: `ScrollSupplier${scroll}`, adena: 1000000, currentRegion: 'Giran', spotId: spot.id, loc: pos,
        stats: { ...Hunt.referenceState(classId, level).stats, generatedCold: true } };
    const stats = Profile.profileFor(state);
    state.vitals = { hp: stats.maxHp, maxHp: stats.maxHp, mp: stats.maxMp, maxMp: stats.maxMp };
    const shot = invoke('GameServer/Inventory/ShotStock').planForState(state);
    if (shot.selfId) state.inventory[shot.selfId] = { selfId: shot.selfId, amount: 10000, stackable: true };
    const board = new BoardIndex();
    const order = { id: 920000 + scroll, ownerId: 990001, kind: 'shop', custodyPolicy: 0, storeType: 3,
        town: 'Giran', revision: 1, lines: [{ id: 930000 + scroll, lineId: 930000 + scroll,
            selfId: scroll, count: 1, price: 2000000, enchant: 0 }] };
    board.put(order);
    const deps = { board, spots: [], knownRecipes: [], producerRecipes: [], workshop: null,
        tripCost: trip, npcOffersFor: () => [], hunt: { perHour: 100000, expPerHour: 1000 }, knowledgeEnabled: false };
    Economy.reset();
    const base = Economy.forState(state, deps);
    const context = { ...base, spotValue: () => ({ kills: 200, valueHours: .8 }) };
    const projection = Providers.build(state, context, { ...deps, spots: [spot] });
    const root = projection.nodes.find(row => row.key === `resale:${scroll}`);
    assert(root, `public demand admits the native ${kind} source for scroll ${scroll}`);
    assert.equal(root.object.amount, 1, 'a one-scroll order never funds surplus collection');
    const source = projection.nodes.find(row => row.key === `${kind}:${scroll}`)?.paths[0];
    assert.equal(source?.kind, kind);
    assert.equal(source?.npcId, npcId);
    const solved = new WishNetwork().build({ actorKey: `supplier:${scroll}`, inputKey: 'quoted',
        nodes: projection.nodes, roots: projection.roots, wallet: state.adena, hourAdena: context.hourAdena,
        persona: context.persona, stockFor: () => ({}) });
    assert(solved.plans.has(`resale:${scroll}`), 'the native network retains the finite delivery plan');
    const unsafe = { ...spot, npcEntries: [{ selfId: npcId, count: 10, pull: 50 }] };
    assert(!Providers.build(state, context, { ...deps, spots: [unsafe] }).roots.includes(`resale:${scroll}`),
        'a high recipe price cannot authorize an unsafe pull');
    board.remove(order.id);
    assert(!Providers.build(state, context, { ...deps, spots: [spot] }).roots.includes(`resale:${scroll}`),
        'withdrawn demand immediately retires recipe farming');
    if (kind === 'spoil') {
        board.put(order);
        const untrained = { ...state, stats: { ...state.stats, coldCombat: { ...state.stats.coldCombat,
            skills: state.stats.coldCombat.skills.filter(skill => Number(skill.selfId) !== 254) } } };
        assert(!Providers.build(untrained, { ...context, state: untrained }, { ...deps, spots: [spot] })
            .roots.includes(`resale:${scroll}`), 'a spoiler cannot plan an unlearned Spoil');
    }
    const yieldAtRate = Planner.itemDropYield(reward, scroll, kind, { npcLevel: mobLevel, killerLevel: level });
    console.log('PASS C recipe supply', JSON.stringify({ scroll, npcId, kind, level, yieldAtRate }));
}
const ordinary = Data.npcRewards.find(row => Number(row.selfId) === 796);
assert(!ordinary.spoils.some(group => group.items.some(item => Number(item.selfId) === 3033)),
    'Spiritshot C has no invented spoil source');
assert(ShotPolicy.SHOT_RECIPE_ITEM_IDS.has(3033));
console.log('PASS C shot recipes use authored spoils or drops, learned skills and finite public demand');
