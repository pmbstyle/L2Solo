'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-context-'));
const oldCwd = process.cwd();
const oldConfig = process.env.L2NODE_CONFIG_FILE;
const oldShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.chdir(root);
let Economy, generation = null;
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
async function run() {
    require(path.join(root, 'src/Global'));
    const Data = invoke('GameServer/DataCache'); Data.init();
    const Database = invoke('Database');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    // A build holds only by its event proof, which needs the warehouse rows
    // and a recompute generation.
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    generation = Generation.metadata();
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Supply = invoke('GameServer/Clan/ClanSupplyPolicy');
    const capture = Profile.capture;
    try {
        Profile.capture = () => ({});
        let craftLevel = 0, clanId = 0;
        const actor = { fetchId: () => 999001, fetchLevel: () => 16, fetchClassId: () => 53,
            fetchClanId: () => clanId,
            backpack: { fetchItems: () => [], fetchDwarvenCraftLevel: () => craftLevel } };
        const session = { coldLifeState: { craftLevel: 1, stats: { dwarvenCraftLevel: 1, clanId: 7 } } };
        const unlearned = Economy.stateForActor(actor, session);
        assert.equal(unlearned.craftLevel, 0, 'native hot zero overrides stored cold capability');
        assert.equal(unlearned.clanId, 0, 'native hot membership overrides the stored clan');
        clanId = 9;
        craftLevel = 1;
        const learned = Economy.stateForActor(actor, session);
        assert.equal(learned.craftLevel, 1);
        assert.equal(learned.clanId, 9);
        const gearProgression = invoke('GameServer/Bot/AI/PersonalGearProgression');
        assert.equal(gearProgression.assess(learned).required, true,
            'a hot clan member still needs its own working kit');
        // Clan custody needs a clan warehouse (clan level 1+), not membership alone.
        assert.equal(gearProgression.personal(learned), true,
            'membership in a clan without a warehouse keeps personal custody');
        Supply.useRowSource(id => id === 9 ? [9, 1, [], 1] : undefined);
        try {
            assert.equal(gearProgression.personal(learned), false,
                'native hot membership retains clan custody of surplus');
        } finally { Supply.useRowSource(null); }
    } finally { Profile.capture = capture; }
    const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex;
    const board = new Board();
    const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    Economy.configure({ board: () => board, spots: () => spots });
    Config.knowledgeErrorsEnabled = false;
    const base = { characterId: 901, phase: 'cold', activity: 'hunting', level: 35, adena: 50,
        inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 } },
        loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const waiting = Economy.forState({ ...base, incomingPending: true,
        stats: { ...base.stats, decisionSeq: 7, activityLeaf: 88, wishFocus: ['power:101:7', 1, 50], money: [0, 1, 10, 40] } });
    assert.equal(waiting.intentPending, true);
    assert.equal(waiting.network.activity, null);
    assert.equal(waiting.purchaseBudget(101), 0);
    assert.equal(waiting.statsPacket.decisionSeq, 7);
    assert.equal(waiting.statsPacket.activityLeaf, 88, 'unknown incoming does not renew the tendency roll');
    assert.deepEqual(waiting.statsPacket.wishFocus, ['power:101:7', 1, 50]);
    const immutableState = { ...base, characterId: 990011 };
    const immutableContext = Economy.forState(immutableState, {
        incoming: ['power:101:7', 1, 50], money: [0, 1, 10, 40]
    });
    Object.freeze(immutableContext.plan);
    assert.throws(() => { immutableContext.gearPlanMemo = {}; }, TypeError,
        'the actual gear-plan setter preserves strict-mode writes to a frozen plan');
    Economy.forget(immutableState.characterId);
    if (process.argv.includes('--producer-status')) {
        const Life = invoke('GameServer/Bot/Population/BotLifeState');
        const Craft = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
        const cachedState = Life.cachedState, opportunities = Craft.opportunities;
        const crafter = { ...base, phase: 'hot', stats: { ...base.stats, classId: 56, playedHours: 2,
            production: { revenue: 200, crafts: 3 }, workshop: { entries: [1] } } };
        const peers = new Map([902, 903, 904].map(characterId => [characterId, {
            ...crafter, characterId, stats: { ...crafter.stats, production: { revenue: 400, crafts: 5 } } }]));
        let peerReads = 0;
        try {
            Life.cachedState = id => { if (Number(id) !== crafter.characterId) peerReads++;
                return Number(id) === crafter.characterId ? crafter : peers.get(Number(id)); };
            Craft.opportunities = () => [{ recipe: { recipeId: 1, productId: 1463 },
                margin: { hours: 1, profit: 100000, labour: 0 } }];
            const deps = { memory: { revision: 1, relations: [...peers.keys()].map(targetId => ({ targetId })) },
                workshop: { recipeId: 1, productId: 1463, incomePerHour: 100000, cycleHours: 1 } };
            const context = Economy.forState(crafter, deps);
            assert.equal(peerReads, 0, 'a crafting review reads zero other crafters');
            assert(!context.projection.nodes.some(node => node.key === 'status:producer'));
            assert(context.projection.moneyPaths.some(row => row.kind === 'production' && row.incomePerHour > 0),
                'profitable crafting remains a repeatable money path');
            peers.get(902).stats.production.revenue = 900;
            assert.equal(Economy.forState(crafter, deps).plan, context.plan, 'another producer sale cannot rebuild this bot');
            assert.equal(peerReads, 0);
            assert.equal(invoke('GameServer/Bot/Economy/CraftWorkshopService').producerStatus, undefined);
            console.log('PASS producer rank removed / 0 peer reads / production money path / own inputs only');
        } finally { Life.cachedState = cachedState; Craft.opportunities = opportunities; }
        assert.equal(Database.isReady(), false);
        assert.deepEqual(fs.readdirSync(dir), ['config.ini']);
        return;
    }
    const ProvidersForKit = invoke('GameServer/Bot/Economy/WishProviders');
    function equippedFixture(id, classId, level, adena) {
        const state = { ...base, characterId: id, level, adena, inventory: {},
            stats: { ...base.stats, classId, exp: Data.experience[level - 1] + 1 } };
        for (const [, items] of ProvidersForKit.gearCandidates(state)) {
            const item = items[0]; if (!item) continue;
            state.inventory[item.selfId] = { selfId: Number(item.selfId), amount: 1, equipped: true,
                equippedCount: 1, slot: Number(item.etc.slot), enchant: 0 };
        }
        return state;
    }
    // T43 table: shots no longer pay for a D-grade Warrior (L20-40, low loot); a C-grade Gladiator at 46 buys them.
    const warrior = equippedFixture(1300, 2, 46, 20000);
    warrior.stats.persona = { ...warrior.stats.persona, understanding: .5 };
    const kitDeps = { knowledgeEnabled: true };
    const warriorContext = Economy.forState(warrior, kitDeps);
    const reserve = warriorContext.survivalReserve, warriorStock = warriorContext.stock('shots');
    assert(reserve >= warriorStock.usePerHour * warriorStock.unitPrice,
        'the protected wallet covers one hunting hour at the bot’s current price estimate');
    assert(reserve < warrior.adena, 'this native fixture still has money beyond its mandatory kit');
    assert.equal(reserve, warriorContext.kitCost(warriorStock.itemId)
        + warriorContext.kitCost(warriorContext.stock('potions').itemId) + warriorContext.kitCost(736));
    const escapeBag = amount => ({ ...warrior, inventory: { ...warrior.inventory, 736: { selfId: 736, amount } } });
    assert.equal(Economy.basics(escapeBag(1), kitDeps).survivalReserve, reserve - warriorContext.kitCost(736));
    assert.equal(Economy.basics(escapeBag(2), kitDeps).survivalReserve, Economy.basics(escapeBag(1), kitDeps).survivalReserve);
    // One hour of the table's 1261.5/h (T43 table).
    assert(warriorContext.purchaseBudget(warriorStock.itemId) >= 1261 * warriorStock.unitPrice);
    assert(warriorContext.purchaseBudget(warriorStock.itemId) <= warrior.adena);
    assert(warriorContext.purchaseBudget(1) <= warrior.adena - reserve);
    assert(warriorContext.statsPacket.money.length >= 4 && warriorContext.statsPacket.money.length <= 28);
    assert(warriorContext.statsPacket.money.every(Number.isFinite) && warriorContext.statsPacket.money[2] > 0);
    const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
    for (const wallet of [0, 20000, 200000, 1000000, 50000000]) {
        const state = { ...warrior, adena: wallet };
        const context = Economy.forState(state, kitDeps);
        const earning = Hunt.huntIncome(state, context.timestamp);
        const row = Table.value(earning.spotId, 'dps', state.level, true);
        assert(Math.abs(context.hourAdena - Hunt.netIncome(row, Hunt.consumablePrices(state))) < 1,
            'the hunting hour deducts paid shots and healing');
        assert(context.moneyPrice >= 1 / context.hourAdena);
        assert(Profit.margin({ productCount: 100, successRate: 100, mpCost: 5 }, 10, 500,
            { ...context, mpPerHour: 1000 }));
    }
    const gladiator = Economy.forState(equippedFixture(1202, 2, 50, 1000000), kitDeps);
    const gladiatorHunt = Hunt.huntIncome(gladiator.state, gladiator.timestamp);
    assert(Math.abs(gladiator.hourAdena - Hunt.netIncome(Table.value(gladiatorHunt.spotId, 'dps', 50, true),
        Hunt.consumablePrices(gladiator.state))) < 1);
    assert.equal(gladiator.moneyPrice, 1 / gladiator.hourAdena);
    const stocked = { ...warrior, inventory: { ...warrior.inventory,
        [warriorStock.itemId]: { selfId: warriorStock.itemId, amount: Math.ceil(warriorStock.usePerHour) } } };
    assert.equal(Economy.basics(stocked, kitDeps).kitCost(warriorStock.itemId), 0);
    assert.equal(Economy.basics(stocked, kitDeps).survivalReserve, warriorContext.price(736),
        'own one-hour shot stock releases its wallet reserve and retains the escape scroll');
    const criminal = Economy.basics({ ...warrior, stats: { ...warrior.stats, karma: 100 } }, kitDeps);
    assert.equal(criminal.kitCost(736), 0);
    const without = Table.value(warriorContext.bestSpotId, 'dps', warrior.level, false);
    const benefit = 1 - without.exp / warriorContext.hunt.expPerHour;
    assert(benefit >= warriorStock.usePerHour * warriorStock.unitPrice / warriorContext.hourAdena);
    const Craft = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
    const originalOpportunities = Craft.opportunities;
    try {
        const crafter = { ...warrior, characterId: 1203, stats: { ...warrior.stats, workshop: { entries: [1] } } };
        Craft.opportunities = () => [{ recipe: { recipeId: 1, productId: 1463 }, margin: { hours: 0, profit: 1000, labour: 0 } }];
        assert.equal(Economy.forState(crafter).hourAdena, warriorContext.hourAdena,
            'main cannot turn an unsupported zero-clock opportunity into occupation income');
        Economy.forget(crafter.characterId);
        Craft.opportunities = () => [{ recipe: { recipeId: 1, productId: 1463 }, margin: { hours: .5, profit: 100000, labour: 38398.5 } }];
        const context = Economy.forState(crafter, { workshop: { recipeId: 1, productId: 1463,
            incomePerHour: 276797, cycleHours: .5 } });
        assert.equal(context.hourAdena, 276797);
        assert.equal(context.projection.moneyPaths.find(row => row.kind === 'production').incomePerHour, context.hourAdena);
    } finally { Craft.opportunities = originalOpportunities; }
    console.log('PASS repeatable wallet-independent income / survival reserve / craft hour / floor');
    const context = Economy.forState(base);
    assert(context.projection.nodes.length <= 40 && context.projection.roots.length <= 12);
    assert(context.network.queue.length && context.moneyPrice > 0 && context.hourAdena > 0);
    assert.equal(Hunt.hourValue(base).perHour, context.hourAdena);
    assert(context.network.activity && ['hunting','shopping','crafting','selling','pvp','helping'].includes(context.network.activity.activity));
    assert.equal(typeof context.statsPacket.decisionSeq, 'number');
    assert.equal(typeof context.statsPacket.activityLeaf, 'number');
    assert(context.statsPacket.activityLeaf !== 0);
    // A hit needs the build's own output published (its decision echo).
    const published = { ...base, stats: { ...base.stats, ...context.statsPacket } };
    assert.equal(Economy.forState(published).plan, context.plan, 'unchanged own inputs reuse the complete context');
    assert.equal(Economy.forState(published, { rememberContext: false }).plan, context.plan,
        'an unkept caller can read an existing valid decision');
    const temporary = Economy.forState({ ...published, level: base.level + 1 }, { rememberContext: false });
    assert.notEqual(temporary.plan, context.plan);
    assert.equal(Economy.forState(published).plan, context.plan, 'an unkept build never replaces the held decision');
    {
        const T = Date.now(), native = { ...base, characterId: 990021 };
        const held = Economy.forState(native, { timestamp: T });
        const spotId = held.network.activity?.spotId, published = { ...native, stats: { ...native.stats, ...held.statsPacket } };
        assert(held.network.activity?.activity === 'hunting' && spotId, 'fixture: a hunting decision at a spot');
        assert.equal(Economy.forState(published, { timestamp: T }).plan, held.plan, 'fixture: the published decision holds');
        const excluded = { ...published, stats: { ...published.stats, capacityBackoffs: [{ spotId, untilStep: 1 }] } };
        assert.notEqual(Economy.forState(excluded, { timestamp: T }).plan, held.plan, 'a new exclusion refuses a same-key hunting decision');
    }
    // The held decision is refused by its facts, not by the bot's own past
    // output: its town rhythm and its trip travel keep it; a clan, party,
    // skill, craft level, recipe book, clan demand or pending delivery refuses it.
    let clanRow = Supply.prepareRow([9, 1, [], 1]);
    Supply.useRowSource(id => id === 9 ? clanRow : undefined, () => true);
    try {
        const T = Date.now(), native = { ...base, characterId: 990023, stats: { ...base.stats, clanId: 9 },
            party: { partyId: 'bgp_x_17', role: 'dd', leaderId: 17 } };
        const held = Economy.forState(native, { timestamp: T });
        // The worker keeps a held entry's graph nodes for a party member only
        // (its party goal query serves them): the gate reads the string party
        // id. This fixture loads EconomyContext on the main thread, which
        // keeps every entry's nodes, so the gate is asserted directly.
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        assert.equal(Sections.partyIdOf(native), 'bgp_x_17', 'a party member keeps its graph nodes off the main thread');
        assert.equal(Sections.partyIdOf(base), '', 'a solo bot keeps the plan only off the main thread');
        const published = { ...native, stats: { ...native.stats, ...held.statsPacket } };
        const with_ = stats => ({ ...published, stats: { ...published.stats, ...stats } });
        const verdict = (state, deps = {}) => Economy.forState(state, { timestamp: T, rememberContext: false, ...deps }).plan;
        assert.equal(verdict(published), held.plan, 'fixture: the published decision holds');
        assert.equal(verdict(with_({ visitEvery: 7 })), held.plan, 'a new town rhythm keeps the decision');
        assert.equal(verdict(with_({ travel: { from: 'Giran', to: 'Dion', at: T } })), held.plan, 'a moved trip keeps the decision');
        assert.equal(verdict({ ...published, incomingPending: false }), held.plan, 'no delivery is no pending delivery');
        assert.equal(verdict({ ...published, party: { ...published.party, leaderId: 18 } }), held.plan, 'a new party leader keeps the decision');
        const refusals = {
            clan: { ...published, stats: { ...published.stats, clanId: 0 } },
            party: { ...published, party: { partyId: 'bgp_x_18', role: 'dd', leaderId: 17 } },
            skill: with_({ coldCombat: { classId: 1, skillSource: 'database', skills: [{ selfId: 3, level: 1 }] } }),
            craft: with_({ dwarvenCraftLevel: 1 }),
            demand: with_({ clanMaterialDemand: { 1864: 10 } }),
            delivery: { ...published, incomingPending: true }
        };
        for (const [name, state] of Object.entries(refusals))
            assert.notEqual(verdict(state), held.plan, `a ${name} change refuses the decision`);
        assert.notEqual(verdict(published, { knownRecipes: [{ recipeId: 1 }] }), held.plan, 'a learned recipe refuses the decision');
        const keptRow = clanRow;
        clanRow = Supply.prepareRow([9, 1, [[1864, 5]], 2]);
        assert.notEqual(verdict(published), held.plan, 'a new clan supply demand refuses the decision');
        clanRow = keptRow;
        assert.equal(Economy.forState(published, { timestamp: T }).plan, held.plan, 'the refused readers left the held decision');
        Economy.forget(native.characterId);
    } finally { Supply.useRowSource(null); }
    console.log('PASS held decision: own output keeps / facts refuse');
    // The gear-threat mask the decision weighed is kept with it: the same
    // mask holds the decision, a flip between physical-only and both refuses it.
    // A saved decision restores under its own byte format and generation only.
    {
        const T = Date.now(), native = { ...base, characterId: 990024 };
        const deps = () => ({ timestamp: T, memoryIdentity: 'fixture-memory', sourceReady: true });
        const held = Economy.forState(native, deps());
        const packet = held.statsPacket, published = { ...native, stats: { ...native.stats, ...packet } };
        const options = { baseline: packet.wishSections, leaf: held.network.activity, timestamp: T };
        const proof = held.eventProof(), mask = held.gearThreatMask;
        assert(proof && (mask === 1 || mask === 3), 'fixture: a held proof and its threat mask');
        assert.equal(Economy.eventProofHolds(published, proof, { ...deps(), gearThreatMask: mask }, options), true,
            'the weighed threat mask holds the decision');
        assert.equal(Economy.eventProofHolds(published, proof, { ...deps(), gearThreatMask: 4 - mask }, options), false,
            'a flipped threat mask refuses the decision');
        const accepted = { card: { activity: held.network.activity }, characterId: native.characterId,
            decisionSeq: packet.decisionSeq, activityLeaf: packet.activityLeaf, focus: packet.wishFocus?.[0] ?? null,
            baseline: packet.wishSections };
        const bytes = Economy.restartEventProof(proof, accepted);
        assert(bytes instanceof Uint8Array, 'a restartable decision saves its prefix');
        const restored = Economy.restoreEventProof(bytes, accepted);
        assert.equal(Economy.eventProofHolds(published, restored, deps(), options), true,
            'the restored prefix holds the saved decision');
        const older = Uint8Array.from(bytes); older[0] = 6;
        assert.equal(Economy.restoreEventProof(older, accepted), null, 'a prefix of the former format is refused');
        const kept = Generation.metadata();
        try {
            Generation.configure({ code: '3'.repeat(40), config: '2'.repeat(64) });
            assert.equal(Economy.restoreEventProof(bytes, accepted), null, 'a prefix of another generation is refused');
        } finally { Generation.configure(kept); }
        assert(Economy.restoreEventProof(bytes, accepted), 'fixture: the generation is back');
        Economy.forget(native.characterId);
    }
    // The sections mask decides which held piece a rebuild reuses: a source
    // raise keeps the foundation (hunt, kit) and rebuilds the source walk; a
    // build raise rebuilds both. A rebuild's money bounds are its own weighing's,
    // never the last decision's. A build without a held entry re-weighs no event.
    {
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const diagnosticsBefore = Config.developerDiagnostics;
        Config.developerDiagnostics = true;
        try {
            const T = Date.now();
            // T43 table: the focus is now a power wish, which the ground keys on (economicHunt), so the bot
            // carries its own published focus, as a live bot does, and a raise does not move that key.
            const focus = Economy.forState({ ...base, characterId: 990027 }, { timestamp: T }).statsPacket.wishFocus;
            Economy.forget(990027);
            const native = { ...base, characterId: 990027, stats: { ...base.stats, wishFocus: focus } };
            const counts = () => invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts || {};
            const delta = (before, key) => (counts()[key] || 0) - (before[key] || 0);
            const held = Economy.forState(native, { timestamp: T });
            assert(held.plan.hunt && typeof held.plan.kit === 'object' && held.plan.kit, 'fixture: a held hunt and kit');
            const stale = { wallet: 7, cashBounds: [-3, 11], budgetBounds: [-5, 13], moneyError: 0.5 };
            const raised = (from, bit) => ({ ...native, stats: { ...native.stats, ...from.statsPacket,
                decisionSeq: from.statsPacket.decisionSeq + 1, wishDirty: Sections.sectionBit(bit),
                wishSections: { ...from.statsPacket.wishSections, ...stale } } });
            let before = counts();
            const sources = Economy.forState(raised(held, 'sources'), { timestamp: T });
            assert.notEqual(sources.plan, held.plan, 'a raised source section rebuilds');
            assert.equal(sources.plan.hunt, held.plan.hunt, 'a source raise keeps the foundation hunt');
            assert.equal(sources.plan.kit, held.plan.kit, 'a source raise keeps the foundation kit');
            assert.equal(delta(before, 'source_memo:miss:sections'), 1, 'a source raise rebuilds the source walk');
            assert.equal(delta(before, 'source_route:ground:reuse'), 1, 'a source raise keeps the ground verdict');
            assert.equal(delta(before, 'context:foundation:kept'), 1, 'the kept foundation is counted');
            assert.notDeepEqual(sources.statsPacket.wishSections.cashBounds, stale.cashBounds,
                'the rebuild records its own money bounds, not the last decision\'s');
            before = counts();
            const money = Economy.forState(raised(sources, 'money'), { timestamp: T });
            assert.notEqual(money.plan, sources.plan, 'a raised money section rebuilds');
            assert.equal(delta(before, 'source_route:ground:reuse'), 1, 'a money raise keeps the ground verdict');
            before = counts();
            Economy.forState(raised(money, 'occupation'), { timestamp: T });
            assert.equal(delta(before, 'source_route:ground:reuse'), 1, 'an occupation raise keeps the ground verdict');
            Economy.forget(native.characterId);
            const again = Economy.forState(native, { timestamp: T });
            before = counts();
            const build = Economy.forState(raised(again, 'build'), { timestamp: T });
            assert.notEqual(build.plan.hunt, again.plan.hunt, 'a build raise rebuilds the foundation');
            assert.equal(delta(before, 'source_memo:miss:sections'), 1, 'a build raise rebuilds the source walk');
            assert.equal(delta(before, 'source_route:ground:build'), 1, 'a build raise rebuilds the ground verdict');
            assert.equal(delta(before, 'context:foundation:built'), 1, 'the rebuilt foundation is counted');
            // No held entry (a deploy, an eviction) and nothing raised: every
            // piece is built, no event re-weighs the published focus and step.
            const published = { ...native, stats: { ...native.stats, ...build.statsPacket, wishDirty: 0 } };
            Economy.forget(native.characterId);
            before = counts();
            Economy.forState(published, { timestamp: T });
            const named = Object.keys(counts()).filter(key => key.startsWith('network:reconsider:')
                && !key.startsWith('network:reconsider:quiet:') && delta(before, key) > 0);
            assert.deepEqual(named, [], 'a build without a held entry re-weighs no event');
            assert(Object.keys(counts()).some(key => key.startsWith('network:reconsider:quiet:') && delta(before, key) > 0),
                'fixture: the held focus was weighed (a quiet reconsider counted)');
        } finally {
            Config.developerDiagnostics = diagnosticsBefore;
            Economy.forget(990027);
        }
    }
    // A card refused right before the build of the same step on the same
    // state hands its verdict to that build: the verdict is computed once,
    // the card answers its first refusal and the build weighs every refusal,
    // the same mask as with its own verdict. A state that moved between them,
    // a received card (another proof object) and a held leaf its compact form
    // reads otherwise (more than 8 sale rows) recompute.
    {
        const Card = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const diagnosticsBefore = Config.developerDiagnostics;
        Config.developerDiagnostics = true;
        const T = Date.now(), native = { ...base, characterId: 990028, adena: 1000000 };
        try {
            const counts = () => invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts || {};
            const delta = (before, key) => (counts()[key] || 0) - (before[key] || 0);
            const held = Economy.forState(native, { timestamp: T });
            const published = { ...native, stats: { ...native.stats, ...held.statsPacket } };
            const accepted = Card.advisory(held, published, published.activity, { timestamp: T });
            assert.equal(accepted?.eventProof, held.eventProof(), 'fixture: the card carries the held proof');
            // Two refusals: a learned skill (its sections) first, the wallet
            // below the decision's bounds (money) later.
            const moved = { ...published, adena: 0, stats: { ...published.stats,
                coldCombat: { classId: 1, skillSource: 'database', skills: [{ selfId: 3, level: 1 }] } } };
            // The worker's step deps carry its trip rows (main fills them in the build).
            const deps = { timestamp: T, routeRows: [] };
            const refused = (state, options, card = accepted) => {
                const prepared = {};
                assert.equal(Card.refreshAdvisory(state, card, deps, { prepared, ...options }), null,
                    'fixture: a learned skill refuses the card');
                return prepared.eventVerdict;
            };
            const build = (state, eventVerdict) => Economy.forState(state, { ...deps, rememberContext: false, eventVerdict });
            const reused = (state, card) => {
                const before = counts();
                build(state, refused(state, { collect: true }, card));
                return [delta(before, 'context:held_verdict:computed'), delta(before, 'context:held_verdict:reused')];
            };
            const plain = refused(moved, {});
            const own = build(moved, plain);
            const money = Sections.sectionBit('money');
            assert(plain.touchedSections && !(plain.touchedSections & money), 'fixture: the first refusal names no money');
            assert(own.mask & money, 'fixture: the build\'s own verdict names money');
            let before = counts();
            const handed = refused(moved, { collect: true });
            const served = build(moved, handed);
            assert.equal(delta(before, 'context:held_verdict:computed'), 1, 'one verdict for the card and the build');
            assert.equal(delta(before, 'context:held_verdict:reused'), 1, 'the build serves the card\'s verdict');
            assert.deepEqual([handed.valid, handed.reason, handed.touchedSections, handed.movedSections],
                [plain.valid, plain.reason, plain.touchedSections, plain.movedSections], 'the card answers its first refusal');
            assert.equal(served.mask, own.mask, 'the build weighs every refusal, as with its own verdict');
            assert.equal(handed.collected, null, 'the hand-off is read once');
            // The build reads a state that moved after the card's verdict.
            before = counts();
            build({ ...moved, adena: 1 }, refused(moved, { collect: true }));
            assert.deepEqual([delta(before, 'context:held_verdict:computed'), delta(before, 'context:held_verdict:reused')], [2, 0],
                'a moved input recomputes');
            const received = { ...accepted, eventProof: Economy.receiveEventProof(Economy.wireEventProof(accepted.eventProof)) };
            assert(received.eventProof && received.eventProof !== accepted.eventProof, 'fixture: a received proof');
            assert.deepEqual(reused(moved, received), [2, 0], 'a received card recomputes');
            // A held selling leaf with its proof and its card (the leaf's compact
            // form): up to 8 sale rows the compact form is the leaf, a 9th row
            // is cut from the card's.
            const plan = held.plan, kept = { leaf: plan.network.activity, proof: plan.eventProof };
            const selling = rows => {
                const leaf = plan.network.activity = { activity: 'selling', kind: 'liquidate', funding: true, town: 'Giran',
                    items: Array.from({ length: rows }, (_, at) => 1864 + at) };
                const eventProof = plan.eventProof = Economy.captureEventProof(published, {}, { plan });
                assert(eventProof, 'fixture: the selling leaf\'s proof');
                return { ...accepted, eventProof, card: { activity: new Card.CompactActivity(leaf) } };
            };
            try {
                assert.deepEqual(reused(moved, selling(8)), [1, 1], 'a selling leaf of 8 rows serves the card\'s verdict');
                assert.deepEqual(reused(moved, selling(9)), [2, 0], 'a selling leaf of 9 rows recomputes');
            } finally { plan.network.activity = kept.leaf; plan.eventProof = kept.proof; }
        } finally {
            Config.developerDiagnostics = diagnosticsBefore;
            Economy.forget(native.characterId);
        }
        console.log('PASS card verdict handed to the build of its step');
    }
    // The crafter's workshop is kept with its held build: on the same route,
    // known, with a finite income and no workshop section moved (the
    // foundation's or money); otherwise it is asked again. The step judges
    // its held build before the build (heldWorkshop): a valid verdict keeps
    // the workshop, a refusal keeps it under its sections. A build with a
    // productive workshop watches its product's buyers and its materials'
    // sellers.
    {
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
        const workshop = { known: true, recipeId: 2, productId: 3, incomePerHour: 1200, cycleHours: 2 };
        const state = { ...base, characterId: 990031 };
        const heldOf = (value, routeKey = Trip.key(state)) => ({ plan: { workshop: value, routeKey } });
        assert.equal(Economy.heldWorkshopOf(heldOf(workshop), 0, state), workshop, 'a held workshop on its route is kept');
        assert.equal(Economy.heldWorkshopOf(heldOf({ ...workshop, incomePerHour: 0 }), 0, state)?.incomePerHour, 0,
            'a known zero income is kept');
        for (const name of ['build', 'combat', 'supply', 'occupation', 'relations', 'money'])
            assert.equal(Economy.heldWorkshopOf(heldOf(workshop), Sections.sectionBit(name), state), null, `a moved ${name} section asks again`);
        for (const name of ['benefits', 'sources'])
            assert.equal(Economy.heldWorkshopOf(heldOf(workshop), Sections.sectionBit(name), state), workshop, `a moved ${name} section keeps it`);
        assert.equal(Economy.heldWorkshopOf(heldOf(workshop, 'elsewhere'), 0, state), null, 'another route asks again');
        assert.equal(Economy.heldWorkshopOf(heldOf({ ...workshop, known: false }), 0, state), null, 'an unknown workshop asks again');
        assert.equal(Economy.heldWorkshopOf(heldOf({ ...workshop, incomePerHour: NaN }), 0, state), null, 'no income asks again');
        assert.equal(Economy.heldWorkshopOf(null, 0, state), null, 'no held build asks');
        const diagnosticsBefore = Config.developerDiagnostics;
        Config.developerDiagnostics = true;
        try {
            const counts = () => invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts || {};
            const unknown = () => counts()['occupation:workshop:unknown'] || 0;
            let before = unknown();
            assert.equal(Economy.keptWorkshop(null, 0, state).known, false, 'nothing kept is an unknown workshop');
            assert.equal(unknown(), before, 'a bot without workshop entries is not counted');
            const crafter = { ...state, stats: { ...state.stats, workshop: { entries: [{ recipeId: 2 }] } } };
            before = unknown();
            Economy.keptWorkshop(heldOf(workshop), Sections.sectionBit('build'), crafter);
            assert.equal(unknown(), before + 1, 'a crafter without a kept workshop is counted');
        } finally { Config.developerDiagnostics = diagnosticsBefore; }
        const routeRows = Trip.prepared(state);
        const built = Economy.forState(state, { routeRows, workshop });
        assert.equal(built.plan.workshop, workshop, 'fixture: the build holds its workshop');
        const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(workshop.recipeId);
        const watched = built.statsPacket.wishSections.marketWatch || [];
        const watches = (id, storeType) => watched.some(row => row[0] === id && row[1] === storeType);
        assert(watches(recipe.productId, 3), 'the product\'s buyers are watched');
        assert(watched.length < Sections.MARKET_WATCH, 'fixture: a short queue, every row fits under the cap');
        assert(recipe.materials.every(row => watches(row.selfId, 1)), 'the materials\' sellers are watched');
        Economy.forget(state.characterId);
        // The step on a crafter's held build: its verdict is judged once,
        // before the workshop ask, and served to the build that follows. A
        // valid verdict keeps the workshop (no ask) and the build serves the
        // held decision, unless the held workshop is unknown or of another
        // route (asked); a refusal by its MP alone (sources) keeps it, with
        // or without the card refused before; a wallet below the decision's
        // bounds (money) asks.
        const Card = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const T = Date.now(), crafter = { ...base, characterId: 990032, craftLevel: 1, adena: 1000000 };
        const deps = { timestamp: T, routeRows: Trip.prepared(crafter) };
        const counts = () => invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts || {};
        const delta = (before, key) => (counts()[key] || 0) - (before[key] || 0);
        // The worker's step: the workshop, then the build on the same deps.
        const stepOf = (state, eventVerdict = {}, before = counts()) => {
            const step = { ...deps };
            const kept = Economy.heldWorkshop(state, step, eventVerdict);
            const built = Economy.forState(state, { ...step, workshop: kept, eventVerdict });
            return { kept, built, verdicts: [delta(before, 'context:held_verdict:computed'), delta(before, 'context:held_verdict:reused')] };
        };
        Config.developerDiagnostics = true;
        try {
            // A refused step rebuilds the held entry: each case starts on a fresh one.
            const fresh = () => {
                Economy.forget(crafter.characterId);
                const held = Economy.forState(crafter, { ...deps, workshop });
                const published = { ...crafter, stats: { ...crafter.stats, ...held.statsPacket } };
                return { held, published, tired: { ...published, vitals: { ...published.vitals, mp: published.vitals.mp - 1 } } };
            };
            let { held, published, tired } = fresh();
            const valid = stepOf(published);
            assert.equal(valid.kept, workshop, 'a valid held build keeps its workshop');
            assert.deepEqual(valid.built.statsPacket, held.statsPacket, 'the build that follows serves the held decision');
            assert.deepEqual(valid.verdicts, [1, 1], 'one verdict for the step\'s workshop and its build');
            const plan = held.plan, routeKey = plan.routeKey;
            plan.routeKey = 'elsewhere';
            try { assert.equal(stepOf(published).kept, null, 'a held workshop of another route asks'); }
            finally { plan.routeKey = routeKey; }
            const refused = stepOf(tired);
            assert.equal(refused.kept, workshop, 'a refusal by the MP alone keeps it');
            assert.deepEqual(refused.verdicts, [1, 1], 'one verdict for a refused step');
            ({ held, published, tired } = fresh());
            const accepted = Card.advisory(held, published, published.activity, deps);
            const before = counts(), prepared = {};
            assert.equal(Card.refreshAdvisory(tired, accepted, deps, { prepared, collect: true }), null, 'fixture: the MP refuses the card');
            assert(!(prepared.eventVerdict.collected.verdict.touchedSections & Sections.COMPUTED.workshop),
                'fixture: the refusal names no workshop section');
            const afterCard = stepOf(tired, prepared.eventVerdict, before);
            assert.equal(afterCard.kept, workshop, 'a refusal by the MP alone keeps it after the card refused');
            assert.deepEqual(afterCard.verdicts, [1, 1], 'one verdict for the card, the step\'s workshop and its build');
            ({ published } = fresh());
            assert.equal(stepOf({ ...published, adena: 0 }).kept, null, 'a moved wallet asks');
            const unknownCrafter = { ...crafter, characterId: 990033 };
            const unknownHeld = Economy.forState(unknownCrafter, { ...deps, workshop: { ...workshop, known: false } });
            const unknown = stepOf({ ...unknownCrafter, stats: { ...unknownCrafter.stats, ...unknownHeld.statsPacket } });
            assert.equal(unknown.kept, null, 'a held unknown workshop asks');
            assert.deepEqual(unknown.built.statsPacket, unknownHeld.statsPacket, 'fixture: the verdict holds, the held decision is served');
        } finally {
            Config.developerDiagnostics = diagnosticsBefore;
            Economy.forget(990033);
            Economy.forget(crafter.characterId);
        }
    }
    console.log('PASS workshop kept with the held build / asked when it moved');
    // The cheap check by kind of leaf: an enchant or special-ability decision
    // names its object: it holds while that object is in the bag at the
    // enchant level read; one without an object (an exchange) holds by its
    // bag rows. A failed row names itself and lights its own sections.
    {
        const check = (state, leaf) => Economy.leafCheck(state, leaf, {}, { heldUnits: undefined });
        const leaf = improvement => ({ activity: 'improving', improvement });
        const bag = enchant => ({ ...base, inventory: { 1310: { selfId: 1310, amount: 1, instances: [{ id: 77, enchant }] } } });
        const enchant = { kind: 'enchant', itemId: 1310, objectId: 77, from: 2, to: 3 };
        assert.equal(check(bag(2), leaf(enchant)), '', 'the named object at its level holds');
        assert.equal(check({ ...base, inventory: {} }, leaf(enchant)).reason, 'check:improvement', 'a gone object refuses');
        assert.equal(check(bag(3), leaf(enchant)).reason, 'check:improvement', 'a moved enchant level refuses');
        assert.equal(check(bag(3), leaf({ kind: 'exchange', itemId: 1310 })), '',
            'an improvement without an object holds');
        assert.equal(check(bag(2), leaf(null)).reason, 'check:improvement', 'an improving leaf without its improvement refuses');
        // A hunting leaf on a spot the bot marked ("was full") refuses while
        // the mark lives the bot's own steps, then holds again.
        const hunt = { activity: 'hunting', spotId: 'crowded' };
        const marked = stepCount => ({ ...base, stats: { ...base.stats, stepCount,
            capacityBackoffs: [{ spotId: 'crowded', untilStep: 12 }] } });
        const excluded = check(marked(11), hunt);
        assert.equal(excluded.reason, 'check:excluded', 'a marked spot refuses its hunt');
        assert.deepEqual([...excluded.sections].sort(), ['occupation', 'sources'], 'an excluded spot re-weighs occupation and sources');
        assert.equal(check(marked(12), hunt), '', 'the mark is forgotten after its steps');
        const craft = check(base, { activity: 'crafting', recipeId: 999999 });
        assert.equal(craft.reason, 'check:craft', 'an unknown recipe refuses the craft');
        assert(craft.sections.includes('supply'), 'a failed craft re-weighs supply');
        assert.equal(check(base, { activity: 'pvp', targetId: 5, rootKey: 'care:5' }).reason, 'check:target',
            'a pvp leaf whose root is not its target refuses');
        assert.equal(check(base, { activity: 'dancing' }).reason, 'check:unsupported', 'an unknown kind refuses');
        assert.equal(check(base, { activity: 'resting' }), '', 'resting has no check');
    }
    console.log('PASS threat mask kept / restart prefix format and generation / improving object');
    // MVP-6 Bounds: a gear candidate's reads wait in its scope; only a kept
    // scope reports its sources (the occupation planner's dependencies).
    const ScopedProviders = invoke('GameServer/Bot/Economy/WishProviders');
    const build = ScopedProviders.build;
    try {
        ScopedProviders.build = (state, ctx, deps) => {
            const admitted = ctx.readScope.open(); ctx.price(990001); ctx.readScope.close();
            ctx.readScope.open(); ctx.price(990002); ctx.readScope.close();
            ctx.readScope.keep(admitted);
            return build(state, ctx, deps);
        };
        const sources = new Set();
        const scoped = { ...base, characterId: 905 };
        const scopedContext = Economy.forState(scoped, { onSourceRead: id => sources.add(id) });
        assert(scopedContext.plan, 'fixture: the scoped build completes');
        assert(sources.has(990001) && !sources.has(990002), 'only the kept scope subscribes its sources');
    } finally { ScopedProviders.build = build; }
    console.log('PASS candidate read scopes');
    // The build's memos (inventory row keys, the kit fact, the bag tokens)
    // end with it: a row changed after the build reads fresh.
    // A nested build of another bot leaves the outer build's keys exact.
    {
        const T = Date.now(), deps = { timestamp: T }, Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const fixture = equippedFixture(1310, 1, 30, 20000);
        const worn = Object.keys(fixture.inventory).find(id => fixture.inventory[id].equipped);
        const state = { ...fixture, inventory: { ...fixture.inventory, [worn]: { ...fixture.inventory[worn] } } };
        const kitBefore = Sections.kit(state);
        const bagRead = ctx => { const local = ctx.nodeInputs.begin(); ctx.nodeInputs.bag(worn); ctx.nodeInputs.end();
            return local.bag.get(Number(worn)); };
        let outer = null, nested = null, bagDuring = null;
        try {
            ScopedProviders.build = (subject, ctx, buildDeps) => {
                if (subject === state && outer === null) {
                    outer = ctx; bagDuring = bagRead(ctx);
                    Economy.forState(equippedFixture(1311, 1, 32, 30000), deps);
                    nested = [Sections.kit(state), bagRead(ctx)];
                }
                return build(subject, ctx, buildDeps);
            };
            Economy.forState(state, deps);
        } finally { ScopedProviders.build = build; }
        assert(outer, 'the build reached its providers');
        assert.deepEqual(nested, [kitBefore, bagDuring],
            'a nested build of another bot leaves the outer build\'s keys');
        state.inventory[worn].enchant = 3;
        const fresh = structuredClone(state);
        assert.equal(Sections.kit(state), Sections.kit(fresh), 'the kit reads the changed row');
        assert.notEqual(Sections.kit(state), kitBefore);
        assert.equal(bagRead(outer), JSON.stringify([state.inventory[worn], 0]), 'a late bag read reads the changed row');
        assert.notEqual(bagRead(outer), bagDuring);
        Economy.forget(state.characterId);
    }
    console.log('PASS build memos end with the build / nested build');
    // An item the purchase reader finds no offer for is still reported as
    // read (the occupation planner's dependency); the first offer for it is
    // no reason to drop the held decision: the market is heard only through
    // the decision's watch list, at the soft point (ARCH-05).
    const Evidence = invoke('GameServer/Bot/Economy/WishPurchaseEvidence');
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const absentBoard = new BoardIndex(), ABSENT = 990003;
    try {
        ScopedProviders.build = (state, ctx, deps) => {
            assert.equal(Evidence.reader(state, ctx, deps)(ABSENT), null);
            return build(state, ctx, deps);
        };
        const sources = new Set();
        const absentDeps = () => ({ board: absentBoard, onSourceRead: id => sources.add(id) });
        const absent = { ...base, characterId: 906 };
        const absentContext = Economy.forState(absent, absentDeps());
        const absentOut = { ...absent, stats: { ...absent.stats, ...absentContext.statsPacket } };
        assert(sources.has(ABSENT), 'an item with no offer is an input of the review');
        assert.equal(Economy.forState(absentOut, absentDeps()).plan, absentContext.plan, 'no offer change keeps the context');
        absentBoard.put({ id: 1, ownerId: 77, storeType: 1, custodyPolicy: 1, revision: 1, town: 'Giran',
            lines: [{ lineId: 2, selfId: ABSENT, count: 1, price: 100 }] });
        assert(!(absentContext.statsPacket.wishSections.marketWatch || []).some(row => row[0] === ABSENT), 'fixture: the absent item is not watched');
        assert.equal(Economy.forState(absentOut, { ...absentDeps(), timestamp: Date.now() + 10 * 60 * 1000 }).plan, absentContext.plan,
            'a first offer for an unwatched item keeps the held decision, however long after');
    } finally { ScopedProviders.build = build; }
    console.log('PASS absent item is read, its offer no event');
    // The soft point (ARCH-05): at the end of a step the bot compares its
    // wallet, its income and the items it watches against its own error, at
    // once (no delay); a watched item's clearly better line is an event, a
    // line inside the error, its own line or another item's line is none.
    {
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const Events = invoke('GameServer/Bot/AI/DecisionEvents');
        const T = Date.now(), native = { ...base, characterId: 990025 }, softBoard = new BoardIndex();
        const held = Economy.forState(native, { board: softBoard, timestamp: T });
        const baseline = held.statsPacket.wishSections;
        const published = { ...native, stats: { ...native.stats, ...held.statsPacket } };
        const watched = baseline.marketWatch?.find(row => row[1] === 1);
        assert(watched && watched[2] > 0 && watched[3] >= 0, `a build watches its wish roots on the sell side: ${JSON.stringify(baseline.marketWatch)}`);
        const soft = (state, more = {}, board = softBoard) => Sections.softEvents(state, { ...baseline, ...more },
            { board, buyOrderEscrow: 0, timestamp: T + 1000, memory: () => null });
        assert.deepEqual(soft(published), [], 'fixture: the published decision is quiet');
        const wallet = { moneyError: 10, cashBounds: [-1, null], budgetBounds: [-1, null] };
        const richer = amount => ({ ...published, adena: published.adena + amount });
        assert.deepEqual(soft(richer(5), wallet), [], 'a wallet drift inside the error is no event');
        assert.deepEqual(soft(richer(50), wallet), ['money'], 'a wallet drift beyond the error is an event a second later');
        assert.deepEqual(soft({ ...published, stats: { ...published.stats, frustration: 1 } }, { frustration: 0, incomeError: 0.1 }),
            ['occupation', 'benefits', 'sources'], 'a frustration beyond the error is an observation event');
        const [item, , reference, error] = watched, below = Math.floor(reference * (1 - error)) - 1;
        assert(below > 0, 'fixture: a price below the watched reference');
        let record = 1;
        const offer = (selfId, price, storeType = 1, ownerId = 77) => softBoard.put({ id: 9000 + record, ownerId, storeType,
            custodyPolicy: 1, revision: record++, town: 'Giran', lines: [{ lineId: 1, selfId, count: 1, price }] });
        offer(990004, 1);
        assert.deepEqual(soft(published), [], 'a cheap line of an unwatched item is no event');
        offer(item, below, 1, native.characterId);
        assert.deepEqual(soft(published), [], 'the bot\'s own line is no event');
        offer(item, Math.ceil(reference * (1 - error)));
        assert.deepEqual(soft(published), [], 'a line inside the error is no event');
        offer(item, below);
        assert.deepEqual(soft(published), ['sources', 'money'], 'a watched item\'s clearly cheaper line is an event');
        assert.deepEqual(soft(published, {}, null), [], 'without the board mirror the market waits');
        const buyWatch = { marketWatch: [[990005, 3, 100, 0.1]] };
        offer(990005, 105, 3);
        assert.deepEqual(soft(published, buyWatch), [], 'a buy line inside the error is no event');
        offer(990005, 120, 3);
        assert.deepEqual(soft(published, buyWatch), ['sources', 'money'], 'a watched sale\'s clearly higher bid is an event');
        // The rebuild weighed the line it saw: the same board is no new event.
        Economy.forget(native.characterId);
        const rebuilt = Economy.forState(native, { board: softBoard, timestamp: T + 2000 }).statsPacket.wishSections;
        assert.deepEqual(Sections.softEvents(published, rebuilt, { board: softBoard, buyOrderEscrow: 0, timestamp: T + 3000,
            memory: () => null }).filter(name => name === 'sources'), [], 'a decision that saw the cheap line does not cross on it again');
        // A sale of an item the bot has no use for (worth 0) is watched at its price.
        const junk = Economy.forState({ ...native, characterId: 990026, inventory: { ...native.inventory,
            1872: { selfId: 1872, amount: 200 } } }, { board: softBoard, timestamp: T + 4000 });
        assert.equal(junk.worth(1872), 0, 'fixture: the junk item is worth nothing to the bot');
        assert(junk.statsPacket.wishSections.marketWatch?.some(row => row[0] === 1872 && row[1] === 3 && row[2] > 0),
            `a liquidation of a zero-usefulness item is watched on the buy side: ${JSON.stringify(junk.statsPacket.wishSections.marketWatch)}`);
        Economy.forget(990026);
        Economy.forget(native.characterId);
        // One raise per step: the round's and the soft point's sections in one
        // bump, ORed into the bits raised before.
        const before = { stats: { decisionSeq: 3 } }, after = { stats: { decisionSeq: 3, wishDirty: Sections.sectionBit('supply') } };
        Events.raiseSections(before, after, [], []);
        assert.equal(after.stats.decisionSeq, 3, 'no section, no bump');
        Events.raiseSections(before, after, ['money'], ['money', 'sources']);
        assert.equal(after.stats.decisionSeq, 4, 'one bump for both lists');
        assert.equal(after.stats.wishDirty, Sections.sectionMask(['supply', 'money', 'sources']), 'the raised bits join the earlier ones');
    }
    console.log('PASS soft point: money / observation / watched market / one raise');
    const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    const shopRecipe = Object.values(invoke('GameServer/Items/C4RecipeItems').loadRecipeItems())
        .find(row => row.type === 'dwarven' && Number(row.mpCost) > 0);
    const shopOwner = { ...base, characterId: 1801, simulation: { revision: 1 },
        vitals: { ...base.vitals, mp: shopRecipe.mpCost * 5 },
        stats: { ...base.stats, workshop: { entries: [{ recipeId: shopRecipe.recipeId, price: 100 }] } } };
    const shopSaved = changes => Workshop.register({ ...shopOwner, ...changes,
        simulation: { ...shopOwner.simulation, revision: shopOwner.simulation.revision + 1 } });
    try {
        Workshop.register(shopOwner);
        assert.equal(Workshop.publicRecipeRows(shopOwner.characterId).length, 1);
        const shopDeps = () => ({ workshops: Workshop.publicForRecipe });
        const shopContext = Economy.forState(base, shopDeps());
        const shopBase = { ...base, stats: { ...base.stats, ...shopContext.statsPacket } };
        assert.equal(Economy.forState(shopBase, shopDeps()).plan, shopContext.plan);
        shopSaved({ vitals: { ...shopOwner.vitals, mp: shopRecipe.mpCost * 6 } });
        assert.equal(Economy.forState(shopBase, shopDeps()).plan, shopContext.plan,
            'a workshop owner save without an offer change keeps the customer cache hit');
    } finally { Workshop.remove(shopOwner.characterId); }
    const physicalSpot = { id: 'gear-physical', npcEntries: [{ selfId: 130 }] };
    const mixedSpot = { id: 'gear-mixed', npcEntries: [{ selfId: 130 }, { selfId: 264 }] };
    const threatSpots = [physicalSpot, mixedSpot];
    const threatBot = { ...base, characterId: 1901, spotId: physicalSpot.id,
        stats: { ...base.stats, decisionSeq: 7, activityLeaf: 88,
            targetCombat: { lastDefeatedNpcIds: [130] } } };
    const threatDeps = { spots: threatSpots };
    const physical = Economy.forState(threatBot, threatDeps);
    assert.equal(physical.gearThreatMask, 1);
    assert.equal(threatBot.stats.activityLeaf, 88, 'preparing threat never changes the saved activity');
    assert.equal(threatBot.stats.decisionSeq, 7, 'preparing threat never starts a decision event');
    // A hit needs the build's own output published (its decision echo).
    Object.assign(threatBot.stats, physical.statsPacket);
    assert.equal(Economy.forState(threatBot, threatDeps).plan, physical.plan);
    threatBot.stats.targetCombat.lastDefeatedNpcIds = [130, 130];
    assert.equal(Economy.forState(threatBot, threatDeps).plan, physical.plan, 'same applicability preserves context');
    threatBot.spotId = mixedSpot.id;
    const stillPhysical = Economy.forState(threatBot, threatDeps);
    assert.equal(stillPhysical.gearThreatMask, 1, 'unobserved magic is not personal knowledge');
    threatBot.stats.targetCombat.lastDefeatedNpcIds = [130, 264];
    const magical = Economy.forState(threatBot, threatDeps);
    assert.equal(magical.gearThreatMask, 3);
    assert.notEqual(magical.plan, stillPhysical.plan, 'own magic observation invalidates the whole projection');
    assert.equal(magical.statsPacket.decisionSeq, physical.statsPacket.decisionSeq);
    threatBot.stats.targetCombat.lastDefeatedNpcIds = [130];
    assert.equal(Economy.forState(threatBot, threatDeps).gearThreatMask, 1);
    threatBot.stats.relations = [{ hostility: 1, targetId: 77 }];
    assert.equal(Economy.forState(threatBot, threatDeps).gearThreatMask, 3, 'hostile intent prevents physical-only valuation');
    Economy.forget(threatBot.characterId);
    console.log('PASS contextual gear projection / own observation / unchanged tendency roll');
    const rich = { ...base, adena: 1e12 };
    const richContext = Economy.forState(rich);
    assert.equal(richContext.moneyPrice, 1 / richContext.hourAdena);
    const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
    assert(richContext.network.gap && !richContext.network.gap.funded
        && richContext.network.gap.price < rich.adena,
        'an affordable mandatory kit still waits for a confirmed supplier');
    assert(richContext.gapHorizonHours > 0, 'affordable useful wishes retain their own waiting horizon');
    assert(PriceDecision.traderOf({ traits: { commitment: 0 } }, richContext).wait > 0);
    assert(PriceDecision.traderOf({ traits: { commitment: 0 } }, richContext).wait
        > PriceDecision.traderOf({ traits: { commitment: 1 } }, richContext).wait);

    assert.equal(richContext.hourAdena, context.hourAdena, 'wallet cannot change repeatable income');
    assert.notEqual(richContext.plan, context.plan, 'native wallet changes invalidate funding');
    console.log('PASS shared network hour / funding / input cache / bounded native gear');

    {
        // T43 table: shots no longer pay for this NG Warrior (low loot); the shot stock is read on a C-grade Gladiator at 46 that buys them.
        const base = equippedFixture(1301, 2, 46, 50), context = Economy.forState(base);
        const stock = context.stock('shots');
        assert(stock.usePerHour > 0 && stock.target === Math.ceil(stock.usePerHour * stock.targetHours));
        const Shot = invoke('GameServer/Inventory/ShotStock');
        assert.equal(Shot.keptAmounts(base)[stock.itemId], stock.target);
        assert(invoke('GameServer/Bot/Economy/PurchaseFunding').operatingReserve({ level: 78, adena: 1e9 }) > 0);
        const plan = Shot.restockPlan({ ...base, adena: 1e8 }, { unitPrice: 10 });
        assert.equal(plan.targetAmount, stock.target);
        assert(plan.amount >= stock.survivalMissing && plan.amount <= stock.target, 'the floor permits survival and only worthwhile extra stock');
        assert.equal(plan.reserve, context.survivalReserve);
        const potion = context.stock('potions');
        assert.equal(invoke('GameServer/Bot/AI/HealingPotionStock').targetAmountFor(base), potion.target);
        const gap = context.network.queue.find(row => !row.funded);
        const stockWish = context.network.queue.find(row => row.key === 'stock:shots');
        if (stockWish && gap.key !== stockWish.key && context.network.queue.indexOf(gap) < context.network.queue.indexOf(stockWish)) {
            assert.equal(context.purchaseBudget(stock.itemId), Math.min(base.adena, context.kitCost(stock.itemId)), 'survival stock retains its own allowance below the gap');
        }
        console.log('PASS shot / potion hours and one wallet without percentage reserve');
    }

    let sampled = { ...base, characterId: 902 };
    for (let i = 0; i < 3; i++) sampled = { ...sampled, stats: { ...sampled.stats,
        huntEfficiency: Hunt.record(sampled, { spotId: 'own', cycleMs: 60000, exp: 1000,
            adena: 9000, loot: 1000, kills: 10 }) } };
    assert.equal(Hunt.huntIncome(sampled).perHour, 600000);
    Hunt.observe(sampled);
    assert.equal(Hunt.huntIncome(base).source, 'table', 'another bot cannot donate private income to a cohort median');
    const death = invoke('GameServer/Progression/DeathExperience').calculateLoss({ ...base, exp: base.stats.exp });
    const deathHours = Valuation.deathHours(base, { expPerHour: 100000 });
    assert.equal(deathHours, death.expLost / 100000 + 90 / 3600);
    assert.equal(Valuation.karmaHours({ ...base, stats: { ...base.stats, karma: 100 } }, { expPerHour: 100000 }), .26);
    const pk = { ...base, stats: { ...base.stats, karma: 100, pk: 6 }, inventory: { 1864: { selfId: 1864, amount: 10 } } };
    assert.equal(Valuation.pkDropValue(pk, () => 100), invoke('GameServer/PkDropPolicy').expectedValue(pk, () => 100));
    console.log('PASS private calibration / native death / shared PK and karma hours');

    const clock = Date.now();
    const prior = { ...base, stats: { ...base.stats, economyClock: clock - 3600000, playedHours: 3, lifelongKills: 10, frustration: 1 } };
    const progress = Valuation.progressStats(prior, { timestamp: clock, startedAt: clock - 7200000,
        kills: 2, losses: 1, lossHours: 2, persona: { traits: { resilience: .5 } } });
    assert.equal(progress.playedHours, 4); assert.equal(progress.lifelongKills, 12);
    assert(progress.frustration > 1, 'a real loss costs lost progress after gradual decay');
    assert.equal(Valuation.progressStats(prior, { timestamp: clock, kills: 2, knowledgeEnabled: false }).lifelongKills, 10);
    const Mob = invoke('GameServer/Progression/MobExperience');
    assert.equal(Mob.gapFactor(5), 1);
    assert.equal(Mob.gapFactor(6), 5 / 6);
    assert.deepEqual(Mob.rewards(120, 60, 36, 30), { exp: 100, sp: 50 });
    assert.equal(Table.expGapFactor(6), 5 / 6);
    console.log('PASS played hours / losses / lifelong own kills / native C4 XP gap');

    const group = Economy.forGroup({ id: 44, wallet: 100, playedHours: 4 }, [base, sampled]);
    assert(group.network.queue.length > 0 && group.actorKey === 'group:44');
    assert.equal(Economy.forGroup({ id: 44, wallet: 100, playedHours: 4 }, [base, sampled]), group);
    assert(group.network.queue.every(wish => /^\d+:/.test(wish.key)), 'actual member graphs share one group queue');
    // perf C1: members that hit give the group the same graph as fresh builds.
    const groupDigest = g => JSON.stringify([g.inputKey, g.network.focus, g.network.activity?.key,
        g.network.queue.map(wish => [wish.key, wish.funded, wish.price, wish.valueHours])]);
    const fromHits = Economy.forGroup({ id: 'proposal:44', wallet: 100, playedHours: 4 }, [base, sampled]);
    Economy.forget(base.characterId); Economy.forget(sampled.characterId);
    const fromBuilds = Economy.forGroup({ id: 'proposal:44', wallet: 100, playedHours: 4 }, [base, sampled]);
    assert.equal(groupDigest(fromHits), groupDigest(fromBuilds), 'a group of held member reviews equals one of fresh builds');
    console.log('PASS real member providers reuse one group engine / purse');

    const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const ownedIngredient = { key: 'item:990002', price: 2,
        paths: [{ kind: 'buy', activity: 'shopping', itemId: 990002, price: 2, executable: true }] };
    const ownedCraftRoot = { key: 'closure-owned-craft', need: 'power', valueHours: 1e9, price: 1,
        paths: [{ kind: 'craft', activity: 'crafting', itemId: 990001, recipeId: 1, productCount: 1,
            requirements: [], grossRequirements: [{ key: ownedIngredient.key, amount: 4 }] }] };
    const closure = Providers.build(base, context, { spots, nodes: [ownedCraftRoot, ownedIngredient] });
    assert(closure.nodes.some(node => node.key === ownedIngredient.key),
        'provider pruning retains already owned ingredients needed by whole-batch allocation');
    const closureNetwork = new (require('../src/GameServer/Bot/Economy/WishNetwork').WishNetwork)().build({
        actorKey: 'closure', inputKey: 'owned', ...closure, wallet: 1000, hourAdena: 100,
        stockFor: id => id === 990002 ? { owned: 4 } : {}, remembered: false });
    assert.equal(closureNetwork.plans.get(ownedCraftRoot.key).requirements.length, 0,
        'physical owned ingredients remain executable after native provider pruning');
    // Clan membership does not introduce a book requirement for free skills.
    Supply.useRowSource(id => id === 1 ? [1, 1, [], 1] : undefined);
    const mage = { ...base, characterId: 903, level: 40, sp: 100000,
        stats: { ...base.stats, clanId: 1, classId: 14, exp: Data.experience[39], coldCombat: { classId: 14, skillSource: 'database', skills: [] } } };
    assert.deepEqual(Catalog.missingBooks(mage), []);
    const valuable = { skillId: 1184, level: 1, selfId: Catalog.bookFor(1184) };
    const bookContext = Economy.forState(mage);
    assert(!bookContext.projection.nodes.some(node => node.key.startsWith('book:')), 'free skills never compete for gear funding');
    const withBook = { ...mage, inventory: { ...mage.inventory, [valuable.selfId]: { selfId: valuable.selfId, amount: 2 } } };
    const granted = Catalog.applyTraining(withBook, { spentSp: 0, consumedBooks: [] });
    assert.equal(granted.sp, withBook.sp);
    assert.deepEqual(granted.inventory, withBook.inventory);
    const artisan = Economy.forState({ ...base, characterId: 904, level: 70, adena: 1e6,
        stats: { ...base.stats, classId: 57, exp: Data.experience[69] } });
    console.log('CONTEXT artisan', JSON.stringify({ hour: artisan.hourAdena, hunt: artisan.hunt,
        money: artisan.moneyPrice, focus: artisan.network.focus, queue: artisan.network.queue.map(row => ({key:row.key,value:row.valueHours,price:row.price,funded:row.funded})) }));
    const realSpot = spots.find(row => String(row.id) === String(context.bestSpotId));
    if (realSpot) {
        const score = invoke('GameServer/Bot/AI/LevelingRoutes').scoreSpot(realSpot, base);
        const valued = context.spotValue(realSpot);
        assert.equal(score.efficiencyAdjustment, valued.valueHours * 100, 'route and wish readers share the same native table valuation');
    }
    Supply.useRowSource(null);
    console.log('PASS no book wishes, free grant balance and skill event key');

    const Decisions = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
    const decisions = new Decisions.ColdEconomyDecisions();
    const decidedBase = { ...base, stats: { ...base.stats, ...context.statsPacket } };
    decisions.accept(base.characterId, Decisions.capture(context, decidedBase, base));
    const requests = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(decidedBase, { decisions, errand: null });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].inputHash, require('../src/GameServer/Bot/Fnv1a').fnv1a32(context.inputKey));
    const dead = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate({ ...base, activity: 'dead' });
    assert.equal(dead[0].type, 'recover'); assert.equal(dead[0].priority, 100);
    const beforeProfile = Profile.profileFor(base);
    assert(beforeProfile.pAtk > 0);
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const resolveInput = { ...base, exp: base.stats.exp, sp: 0,
        stats: { ...base.stats, classProgressionLevel: base.level, classProgressionClassId: 1,
            decisionSeq: 9, activityLeaf: context.statsPacket.activityLeaf, wishFocus: context.network.focus,
            coldCombat: { classId: 1, skillSource: 'database', skills: [] } } };
    const resolveResult = {
        patch: { activity: 'hunting' }, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        debug: {}, nextResolveAt: Date.now() + 60000
    };
    const resolveOptions = { persist: false, projectClassProgression: true, timestamp: Date.now() };
    const prepared = await Life.prepareResolve(resolveInput, resolveResult, resolveOptions);
    const retried = await Life.prepareResolve(resolveInput, resolveResult, resolveOptions);
    assert.equal(prepared.stats.decisionSeq, 9, 'an ordinary round records facts without renewing the accepted decision');
    assert.equal(retried.stats.decisionSeq, prepared.stats.decisionSeq);
    assert.equal(retried.stats.activityLeaf, prepared.stats.activityLeaf);
    assert.equal(resolveInput.stats.decisionSeq, 9, 'projection does not mutate its decision source');
    assert.equal(prepared.stats.wishFocus?.length, 3);
    assert.equal(prepared.inventory[1].amount, 1);
    const interrupted = await Life.prepareResolve(resolveInput, { ...resolveResult,
        patch: { activity: 'hunting', vitals: { mp: 50 }, stats: { targetCombat: { targetId: 1001, hp: 20 } } } }, resolveOptions);
    assert.equal(interrupted.stats.decisionSeq, 9, 'an unfinished fight updates current combat facts without changing the strategic decision');
    assert.equal(interrupted.vitals.mp, 50, 'current combat resources remain authoritative');
    const actualDeath = await Life.prepareResolve(resolveInput, { ...resolveResult,
        patch: { activity: 'dead' } }, resolveOptions);
    assert.equal(actualDeath.stats.decisionSeq, 10, 'actual death creates one meaningful decision');
    assert.equal(actualDeath.stats.activityLeaf, resolveInput.stats.activityLeaf, 'death keeps the held step for the next build to reconsider');
    const levelExpGain = Math.max(1, Data.experience[base.level] - resolveInput.exp + 1);
    const levelGain = await Life.prepareResolve(resolveInput, { ...resolveResult,
        materialize: { ...resolveResult.materialize, exp: levelExpGain } }, resolveOptions);
    assert(levelGain.level > resolveInput.level, 'the fixture really earns a new level');
    assert.equal(levelGain.stats.decisionSeq, 10, 'actual level gain updates dependent calculations once');
    assert.equal(Database.isReady(), false);
    assert.deepEqual(fs.readdirSync(dir), ['config.ini']);
    console.log('PASS actual needs hookup / hard survival floor / no SQL or saves');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Economy?.reset();
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(null);
    if (generation) Generation.configure(generation);
    process.chdir(oldCwd);
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(dir, { recursive: true, force: true });
});
