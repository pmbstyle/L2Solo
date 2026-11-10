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
const { BoardIndex, rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
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
    if (scroll === 1805) {
        const npcById = new Map(Data.npcs.map(row => [Number(row.selfId), row]));
        const minimumLevel = new Map();
        for (const row of Data.npcRewards) {
            const level = Number(npcById.get(Number(row.selfId))?.template?.level || 0);
            for (const group of row.spoils || []) for (const item of group.items || [])
                minimumLevel.set(Number(item.selfId), Math.min(level, minimumLevel.get(Number(item.selfId)) ?? Infinity));
        }
        const locked = [];
        for (const row of Data.npcRewards) {
            const npc = npcById.get(Number(row.selfId));
            if (npc?.template?.kind !== 'Monster' || npc.template.level < 60) continue;
            for (const group of row.spoils || []) for (const item of group.items || []) {
                const id = Number(item.selfId);
                if (minimumLevel.get(id) < 60 || locked.some(entry => entry.id === id) || locked.length >= 8) continue;
                locked.push({ id, npc });
            }
        }
        assert.equal(locked.length, 8, 'the competing orders use real high-level spoil sources');
        const lockedSpots = locked.map(({ id, npc }, at) => {
            board.put({ ...order, id: 950000 + at, lines: [{ ...order.lines[0], lineId: 951000 + at,
                selfId: id, price: 100000000 }] });
            const level = Number(npc.template.level);
            return { ...spot, id: `locked-source-${id}`, avgLevel: level, minLevel: level, maxLevel: level,
                levelCounts: { [level]: 10 }, npcSelfIds: [npc.selfId],
                npcEntries: [{ selfId: npc.selfId, count: 10, pull: 1 }] };
        });
        const crowded = Providers.build(state, context, { ...deps, spots: [spot, ...lockedSpots] });
        assert(crowded.roots.includes(`resale:${scroll}`),
            'eight expensive unreachable orders cannot displace an attainable shot scroll before source evaluation');
        for (let at = 0; at < locked.length; at++) board.remove(950000 + at);
    }
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

const Review = require('../src/GameServer/Bot/Population/CraftMarketReview');
for (const recipeId of [21, 318, 324]) {
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(recipeId);
    const wanted = { itemId: recipe.recipeItemId, recipeId, amount: 1, batches: 4,
        maxSpend: 200000, inputCash: 100000, at: Date.now() };
    const state = { ...Hunt.referenceState(57, 40), characterId: 940000 + recipeId,
        phase: 'cold', activity: 'hunting', inventory: {}, stats: { classId: 57, shotRecipeDemand: wanted } };
    const board = new BoardIndex(), record = {};
    assert(Review.shotRecipeBidDue(state, record, board), 'a missing scroll needs no equipment project to reach the board');
    assert(!Review.shotRecipeBidDue(state, record, board), 'unchanged facts cannot spin a failed review');
    assert(!Review.shotRecipeBidDue({ ...state, stats: { ...state.stats,
        shotRecipeDemand: { ...wanted, at: wanted.at + 60000 } } }, record, board),
    'refreshing only the request timestamp cannot trigger another review');
    const rival = { id: 940100, ownerId: 990001, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 940101, selfId: wanted.itemId, count: 1, price: 100000 }] };
    board.put(rival);
    assert(Review.shotRecipeBidDue(state, record, board), 'a competing bid changes the procurement facts');
    assert(!Review.shotRecipeBidDue(state, record, board));
    const own = { ...rival, id: 940110, ownerId: state.characterId,
        lines: [{ ...rival.lines[0], lineId: 940111 }] };
    board.put(own);
    assert(!Review.shotRecipeBidDue(state, record, board), 'a sufficient standing request already covers the scroll');
    board.remove(own.id);
    assert(Review.shotRecipeBidDue(state, record, board), 'withdrawal of the owner\'s bid wakes procurement');
    for (const pending of [{ partyId: 'busy' }, { incomingPending: true }, { activity: 'traveling' },
        { stats: { ...state.stats, tradeMeeting: { token: 'pending' } } }])
        assert(!Review.shotRecipeBidDue({ ...state, ...pending }, {}, board), 'procurement respects an existing handoff');
    const arrived = { ...state, inventory: { [wanted.itemId]: { amount: 1 } } }, receipt = {};
    assert(Review.shotRecipeBidDue(arrived, receipt, board),
        'an arrived scroll wakes the native learning step');
    assert(!Review.shotRecipeBidDue(arrived, receipt, board), 'an unchanged receipt cannot spin the review');
    assert(!Review.shotRecipeBidDue({ ...state, acceptedIncoming: { [wanted.itemId]: 1 } }, {}, board),
        'an accepted delivery cannot create a duplicate request');
    assert(!Review.shotRecipeBidDue({ ...state, stats: { ...state.stats, shotRecipeDemand: null } }, record, board));
    assert(Review.shotRecipeBidDue(state, record, board), 'a new acceptance can reuse the same finite terms after a clear');
    assert(!Review.shotRecipeBidDue({ ...state, stats: { ...state.stats,
        shotRecipeDemand: { ...wanted, inputCash: undefined } } }, {}, board), 'legacy unfunded wants wait for native preparation');
}
console.log('PASS C shot recipes use authored spoils or drops, learned skills and finite public demand');

(async () => {
    const now = Date.now(), state = Hunt.referenceState(57, 41);
    Object.assign(state, { characterId: 940021, name: 'RecipeHunter', accountName: 'bot_pop_recipe_hunter',
        adena: 30000000, spotId: '15_34', currentRegion: 'Crokian fields',
        loc: { locX: 92025, locY: 207614, locZ: -3672 }, timing: {} });
    state.inventory = Object.fromEntries(Object.values(state.inventory).map(row => [row.selfId, row]));
    state.inventory[57] = { selfId: 57, amount: state.adena, stackable: true };
    for (const id of [736, 1061]) state.inventory[id] = { selfId: id, amount: 100, stackable: true };
    state.stats = { ...state.stats, generatedCold: true, money: [500000, .000002, 0, 0],
        shotRecipeDemand: { itemId: 1805, recipeId: 21, batches: 8, amount: 1, maxSpend: 800000,
            inputCash: 200000, at: now },
        equipmentPlan: { status: 'deferred', strategy: 'none', reason: 'wish_focus', next: null } };
    const profile = Profile.profileFor(state);
    state.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
    state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
    const records = [
        { id: 940100, ownerId: 990001, kind: 'buy_ad', custodyPolicy: 1, storeType: 3, town: 'Giran', revision: 1,
            lines: [{ id: 940101, lineId: 940101, selfId: 1464, count: 4760, price: 500, enchant: 0 }] },
        { id: 940200, ownerId: 990002, kind: 'shop', custodyPolicy: 0, storeType: 1, town: 'Giran', revision: 1,
            lines: [{ id: 940201, lineId: 940201, selfId: 1459, count: 100, price: 5000, enchant: 0 }] }
    ];
    const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
    const result = await require('./helpers/workerEconomyDecision')(state, { timestamp: now, townVisit: true,
        recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] },
        tables: [{ name: 'board', from: null, to: 0, full: true, removed: [], rows: records.map(row => [row.id, rowOf(row)]) },
            ...['personal_warehouse', 'clan_supplies'].map(name => ({ name, from: null, to: 0, full: true, removed: [], rows: [] }))] });
    assert.equal(result.plan.activityPick.activity, 'hunting', 'the ordinary leaf stays on the current hunt');
    assert.equal(result.plan.plannedState.activity, 'hunting', 'no town arrival or unrelated action publishes this request');
    const plan = result.plan.economyPlan;
    assert(plan?.buyAds?.some(row => row[0] === 1805 && row[1] === 1 && row[2] > 0),
        'the actual hunting lifecycle prepares the missing recipe bid without a seller');
    assert.equal(plan.shot, undefined, 'a market-only review cannot carry an unknown craft that clears procurement');
    const received = { ...state, inventory: { ...state.inventory,
        1805: { selfId: 1805, amount: 1, stackable: true } } };
    const delivery = await require('./helpers/workerEconomyDecision')(received, { timestamp: now, townVisit: true,
        recipes: { recipeBook: Codec.pack([20]), knownShotRecipes: [20] },
        tables: [{ name: 'board', from: null, to: 0, full: true, removed: [], rows: records.map(row => [row.id, rowOf(row)]) },
            ...['personal_warehouse', 'clan_supplies'].map(name => ({ name, from: null, to: 0, full: true, removed: [], rows: [] }))] });
    assert.equal(delivery.plan.economyPlan?.learnRecipe, 21,
        'the actual hunting lifecycle sends the received learning target to its native executor');
    assert(!delivery.plan.economyPlan.sell.some(row => row[0] === 1805));
    assert(!delivery.plan.economyPlan.buyAds?.some(row => row[0] === 1805));
    console.log('PASS native hunting lifecycle publishes shot-recipe procurement and completes its receipt');
})().catch(error => { console.error(error); process.exit(1); });
