'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Shots = invoke('GameServer/Inventory/ShotStock');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const Cold = invoke('GameServer/Bot/Population/BackgroundResolver');
const Profiles = invoke('GameServer/Bot/Population/ColdCombatProfile');
const saved = { value: Table.value, best: Table.best, income: Hunt.huntIncome, prior: Belief.prior, npc: Profiles.npcForSpot };
const state = { characterId: 77, name: 'Shot policy', phase: 'cold', activity: 'hunting', level: 7, spotId: 'policy',
    adena: 100000, inventory: { 2369: { selfId: 2369, amount: 1, equipped: true, slot: 7 },
        1835: { selfId: 1835, amount: 1000 }, 736: { selfId: 736, amount: 1 } }, stats: { classId: 31, role: 'dps' },
    loc: { locX: 0, locY: 0, locZ: 0 }, timing: {} };
let benefit = .05;
Table.value = (id, role, level, shots) => ({ exp: shots ? 1000 : 1000 * (1-benefit), shots: shots ? 100 : 0, potions: 0, deaths: 0 });
Table.best = (role, level, shots) => Table.value('policy', role, level, shots);
Hunt.huntIncome = () => ({ perHour: 10000, expPerHour: 1000, source: 'own', spotId: 'policy' });
Belief.prior = id => ({ mu: Math.log(Number(id) === 1835 ? 14 : 1), K: 1 });
const deps = { board: { first: () => null }, spots: [], workshop: null, workshops: null, knownRecipes: [],
    npcOffersFor: () => [], timestamp: 1800000000000, persona: { traits: {}, understanding: 1 } };
try {
    let stock = Economy.basics(state, deps).stock('shots');
    assert.equal(Shots.usePolicy(state).usePerHour, 100, 'own use loses only NPC buyback3, not retail14');
    assert.equal(stock.usePerHour, 100);
    assert.equal(stock.target, 200);
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const offers = Disposition.saleCandidates(state, { keptAmounts: Shots.keptAmounts(state, { stock: () => stock }), unlimited: true });
    assert.equal(offers.find(row => row.selfId === 1835).count, 800, 'only surplus beyond useful owned stock is sellable');
    assert.equal(stock.survivalMissing, 0);
    assert.equal(stock.missing, 0, 'expensive replacement cannot become a new wish');
    const small = { ...state, inventory: { ...state.inventory, 1835: { selfId: 1835, amount: 20 } } };
    stock = Economy.basics(small, deps).stock('shots');
    assert.equal(stock.target, 20, 'keep the useful remainder without demanding an expensive refill');
    assert.equal(stock.survivalMissing, 0);
    assert.equal(stock.needed, false);
    assert.equal(Economy.basics(small, deps).kitCost(1835), 0);
    const refill = Shots.restockPlan(small, { context: Economy.basics(small, deps), unitPrice: 14 });
    assert.equal(refill.amount, 0);
    assert.equal(refill.cost, 0, 'actual restock cannot buy the expensive replacement');
    const empty = { ...state, inventory: { ...state.inventory, 1835: { selfId: 1835, amount: 0 } } };
    const emptyStock = Economy.basics(empty, deps).stock('shots');
    assert.equal(emptyStock.target, 0);
    assert.equal(emptyStock.ownedUsePerHour, 100, 'useful future gifts do not imply a replacement purchase');
    const actor = { backpack: { fetchItemFromSelfId: id => id === 1835 ? {} : null }, fetchClassId: () => 31,
        autoSoulshots: new Set([2509]) };
    Shots.enableAutoShot(actor, { stock });
    assert.deepEqual([...actor.autoSoulshots], [1835]);
    const actorState = Economy.stateForActor;
    try {
        let snapshots = 0, actorLevel = 7;
        actor.session = { botSession: true, coldLifeState: state };
        actor.fetchLevel = () => actorLevel;
        Economy.stateForActor = () => { snapshots++; return { ...state, level: actorLevel }; };
        Shots.enableAutoShot(actor);
        assert.deepEqual([...actor.autoSoulshots], [1835], 'spawn/weapon refresh use the same native policy');
        const Backpack = invoke('GameServer/Actor/Backpack');
        snapshots = 0;
        for (let tick = 0; tick < 1000; tick++) Backpack.prototype.fetchAutoShot.call(actor.backpack, actor, 'soulshot');
        assert.equal(snapshots, 0, '1,000 unchanged hot charge checks build no actor snapshots or policy');
        actorLevel++;
        benefit = .01;
        assert.equal(Backpack.prototype.fetchAutoShot.call(actor.backpack, actor, 'soulshot'), null);
        assert.equal(snapshots, 1, 'a level change refreshes once even for a party follower without a held wish review');
        Backpack.prototype.fetchAutoShot.call(actor.backpack, actor, 'soulshot');
        assert.equal(snapshots, 1);
        // Equipment changes invalidate own hunt samples even without a follower hold.
        const BackpackModel = invoke('GameServer/Model/Backpack');
        const Item = invoke('GameServer/Item/Item');
        const gear = new Item(900, { selfId: 23, amount: 1, equipped: false, slot: 10 });
        const pack = new BackpackModel({});
        pack.items = [gear]; Item.bindInventory(pack);
        actor.backpack = pack;
        const huntIncome = Hunt.huntIncome;
        const initialSignature = Hunt.signature(state);
        Hunt.huntIncome = s => ({ perHour: Hunt.signature(s) === initialSignature ? 10000 : 1000 });
        Economy.stateForActor = () => {
            snapshots++;
            const inventory = { ...state.inventory };
            if (gear.fetchEquipped()) inventory[23] = { selfId: 23, amount: 1, equipped: true,
                slot: 10, enchant: gear.fetchEnchantLevel() };
            return { ...state, inventory };
        };
        try {
            benefit = .05;
            Shots.enableAutoShot(actor);
            assert.ok(actor.autoSoulshots.has(1835));
            snapshots = 0;
            pack.equipPaperdoll(10, 900, 23); gear.setEquipped(true);
            Backpack.prototype.fetchAutoShot.call(pack, actor, 'soulshot');
            assert.equal(snapshots, 1, 'armor equip refreshes a follower once');
            assert.equal(actor.autoSoulshots.size, 0, 'invalidated own income no longer funds shot use');
            gear.setEnchantLevel(1);
            Backpack.prototype.fetchAutoShot.call(pack, actor, 'soulshot');
            assert.equal(snapshots, 2, 'equipped enchant refreshes once');
            gear.setEnchantLevel(1); gear.setAmount(2);
            Backpack.prototype.fetchAutoShot.call(pack, actor, 'soulshot');
            assert.equal(snapshots, 2, 'same enchant and stack consumption do not refresh equipment policy');
            pack.unequipPaperdoll(10); gear.setEquipped(false);
            Backpack.prototype.fetchAutoShot.call(pack, actor, 'soulshot');
            assert.equal(snapshots, 3, 'armor removal refreshes once');
            assert.ok(actor.autoSoulshots.has(1835), 'original equipment restores the usable own sample');
        } finally { Hunt.huntIncome = huntIncome; }
        benefit = .01;
        const Events = invoke('GameServer/Bot/AI/DecisionEvents');
        actor.autoSoulshots.add(1835);
        const denied = Economy.basics(state, deps).stock('shots');
        Events.hold(actor.session, actor, { routePending: true, stock: () => denied });
        assert.equal(actor.autoSoulshots.size, 0, 'waiting for a route must not defer an already prepared stock choice');
    } finally { Economy.stateForActor = actorState; }
    benefit = .01;
    stock = Economy.basics(state, deps).stock('shots');
    assert.equal(stock.target, 0);
    assert.equal(Shots.usePolicy(state).usePerHour, 0);
    const cheap = Shots.usePolicy(state, { plan: Shots.planForState(state), bestTable: Table.value('policy', 'dps', 7, true),
        withoutShots: Table.value('policy', 'dps', 7, false), hourAdena: 10000, unitPrice: .1 });
    assert.equal(cheap.purchaseUsePerHour, 0, 'a consumption wish cannot buy shots it would immediately reject for use');
    Shots.enableAutoShot(actor, { stock });
    assert.equal(actor.autoSoulshots.size, 0, 'a denied use clears a previously enabled compatible shot');
    // Actual solo/party charge sites: a real fixed monster and native weapon.
    Profiles.npcForSpot = () => ({ selfId: 456, level: 5, maxHp: 100000, pAtk: 1, pAtkRnd: 0,
        pDef: 20, mDef: 10, accur: 1, evasion: 0, critical: 0, atkSpd: 500 });
    const spot = { id: 'policy', minLevel: 5, maxLevel: 5, avgLevel: 5, density: 1,
        rewards: { exp: 100, sp: 1, adenaMin: 1, adenaMax: 1 } };
    const make = () => { const s = structuredClone(state); const profile = Profiles.profileFor(s, deps.timestamp);
        s.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp }; return s; };
    for (const allowed of [false, true]) {
        benefit = allowed ? .05 : .01;
        const solo = Cold.resolveSolo({ state: make(), spot, timestamp: deps.timestamp, elapsedMs: 12000, rng: () => .5 });
        const party = Cold.resolvePartyFight({ members: [make()], spot, timestamp: deps.timestamp, rng: () => .5 });
        assert.equal(solo.debug.shotActions > 0, allowed, 'solo combat obeys the common retained-use choice');
        assert.equal(party.members[0].shotActions > 0, allowed, 'party combat obeys the same choice');
    }
    assert.equal(invoke('Database').isReady(), false);
    console.log('PASS owned use / expensive replacement / retention / hot enable / cold solo-party choice');
} finally {
    Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.income;
    Belief.prior = saved.prior; Profiles.npcForSpot = saved.npc;
}
