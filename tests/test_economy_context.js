'use strict';
const assert = require('node:assert/strict');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
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
            const deps = { memory: { revision: 1, relations: [...peers.keys()].map(targetId => ({ targetId })) } };
            const context = Economy.forState(crafter, deps);
            assert.equal(peerReads, 0, 'a crafting review reads zero other crafters');
            assert(!context.projection.nodes.some(node => node.key === 'status:producer'));
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
    const warrior = equippedFixture(1300, 2, 46, 100000);
    warrior.stats.persona = { ...warrior.stats.persona, understanding: .5 };
    const kitDeps = { knowledgeEnabled: true };
    const warriorContext = Economy.forState(warrior, kitDeps);
    // Decision 11-02 (situations F1): a build the gear plan did not wake weighs only the
    // gear the bot follows and keeps what it follows; a full review (gear_plan woken),
    // a move of the kit or of the goal weighs everything.
    {
        const rich = { ...base, characterId: 1301, level: 46, adena: 3000000, inventory: {}, phase: 'cold', activity: 'hunting',
            stats: { ...base.stats, classId: 2, exp: Data.experience[45] + 1 } };
        const atWork = (state, goalRevision, fullReview = false) => Economy.forState(state, { ...kitDeps, goalRevision, caller: 'step', fullReview });
        const full = atWork(rich, 1, true);
        const quiet = atWork(rich, 1);
        const weighed = context => context.projection.admission.candidates;
        assert(weighed(quiet) < weighed(full), `a quiet build weighs fewer candidates: ${weighed(quiet)} of ${weighed(full)}`);
        assert.deepEqual(quiet.projection.roots, full.projection.roots, 'and keeps every root the bot follows');
        const rare = full.projection.admission.rare;
        assert(rare > 0 && quiet.projection.admission.rare === rare, 'the rare piece stays followed');
        assert(quiet.projection.roots.some(key => invoke('GameServer/Bot/Economy/WishNetwork').rootItem(key) === rare), 'and keeps its root');
        assert.deepEqual(quiet.network.focus, full.network.focus, 'and its goal');
        assert.equal(weighed(atWork({ ...rich, level: 47, stats: { ...rich.stats, exp: Data.experience[46] + 1 } }, 1)), weighed(full),
            'a kit move is a real review');
        assert.equal(weighed(atWork(rich, 2)), weighed(full), 'a goal main moved too');
        atWork({ ...rich, adena: 0 }, 2);
        assert.deepEqual(atWork(rich, 2).projection.roots, full.projection.roots,
            'a poor quiet build drops nothing the bot follows');
        Economy.forget(rich.characterId);
    }
    const reserve = warriorContext.refillReserve, warriorStock = warriorContext.stock('shots');
    assert(reserve >= warriorStock.usePerHour * warriorStock.survivalPrice,
        'the protected wallet covers one hunting hour at the merchant’s price');
    assert(reserve < warrior.adena, 'this native fixture still has money beyond its mandatory kit');
    assert.equal(reserve, warriorContext.kitCost(warriorStock.itemId)
        + warriorContext.kitCost(warriorContext.stock('potions').itemId) + warriorContext.kitCost(736));
    const escapeBag = amount => ({ ...warrior, inventory: { ...warrior.inventory, 736: { selfId: 736, amount } } });
    assert.equal(Economy.basics(escapeBag(1), kitDeps).refillReserve, reserve - warriorContext.kitCost(736));
    assert.equal(Economy.basics(escapeBag(2), kitDeps).refillReserve, Economy.basics(escapeBag(1), kitDeps).refillReserve);
    // One hour of the table's shot use (T43).
    assert(warriorContext.purchaseBudget(warriorStock.itemId) >= Math.floor(warriorStock.usePerHour) * warriorStock.unitPrice);
    assert(warriorContext.purchaseBudget(warriorStock.itemId) <= warrior.adena);
    assert(warriorContext.purchaseBudget(1) <= warrior.adena - reserve);
    assert(Packet.hasMoney(warriorContext.statsPacket.money) && Packet.fundedRows(warriorContext.statsPacket.money) <= Packet.MONEY_ROWS);
    assert(warriorContext.statsPacket.money.every(Number.isFinite) && Packet.refillReserve(warriorContext.statsPacket.money) > 0);
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
    // The reserve is the next outing's refill whatever the bag holds (plan §5): a bag with
    // its refill owes the counter nothing, yet gear never takes the refill's money.
    const warriorPotions = warriorContext.stock('potions');
    const stocked = { ...warrior, inventory: { ...warrior.inventory,
        [warriorStock.itemId]: { selfId: warriorStock.itemId, amount: warriorStock.refill },
        [warriorPotions.itemId]: { selfId: warriorPotions.itemId, amount: warriorPotions.refill } } };
    assert.equal(Economy.basics(stocked, kitDeps).kitCost(warriorStock.itemId), 0);
    assert.equal(Economy.basics(stocked, kitDeps).refillReserve, reserve, 'the refill stays reserved');
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
            'a craft opportunity is no hour income: a crafter\'s hour is its hunt\'s');
        Economy.forget(crafter.characterId);
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
    assert.equal(Economy.forState(published, { caller: 'meeting_prepare' }).plan, context.plan,
        'an unkept caller can read an existing valid decision');
    // A reader is served the held decision while it names the bot's decision (its proof's
    // identity), near a player too; an unkept reader with none builds and keeps nothing.
    assert.equal(Economy.forState({ ...published, phase: 'hot', level: base.level + 1 }, { caller: 'meeting_prepare' }).plan, context.plan,
        'a reader reads the held decision whatever moved');
    assert.equal(Economy.forState(published).plan, context.plan, 'an unkept read never replaces the held decision');
    // The held decision is not judged on its facts (situations step 4 C6): it serves its
    // readers until a situation wakes its build; the woken build decides anew.
    let clanRow = Supply.prepareRow([9, 1, [], 1]);
    Supply.useRowSource(id => id === 9 ? clanRow : undefined, () => true);
    try {
        const T = Date.now(), native = { ...base, characterId: 990023, phase: 'hot', stats: { ...base.stats, clanId: 9 },
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
        const read = (state, deps = {}) => Economy.forState(state, { timestamp: T, caller: 'meeting_prepare', ...deps }).plan;
        const moved = {
            clan: { ...published, stats: { ...published.stats, clanId: 0 } },
            party: { ...published, party: { partyId: 'bgp_x_18', role: 'dd', leaderId: 17 } },
            skill: with_({ coldCombat: { classId: 1, skillSource: 'database', skills: [{ selfId: 3, level: 1 }] } }),
            craft: with_({ dwarvenCraftLevel: 1 }), demand: with_({ clanMaterialDemand: { 1864: 10 } }), rhythm: with_({ visitEvery: 7 })
        };
        for (const [name, state] of Object.entries(moved)) assert.equal(read(state), held.plan, `a ${name} move is read, not judged`);
        assert.notEqual(Economy.forState(moved.clan, { timestamp: T, caller: 'step' }).plan, held.plan, 'the woken build decides anew');
        // A far member hears its clan's request open or close, not each count (clan_call).
        const Moments = invoke('GameServer/Bot/Economy/DecisionSections');
        const heard = (demand = { 1864: 10 }) => Moments.semanticFacts({ ...published, phase: 'cold', party: null, partyId: null,
            stats: { ...published.stats, clanMaterialDemand: demand } }).stores;
        clanRow = Supply.prepareRow([9, 1, [[1864, 3]], 3]);
        const gatedRequest = heard();
        clanRow = Supply.prepareRow([9, 1, [[1864, 5]], 4]);
        assert.equal(heard({ 1864: 4 }), gatedRequest, 'a member hears no count');
        clanRow = Supply.prepareRow([9, 1, [[1864, 5], [1865, 2]], 5]);
        assert.notEqual(heard(), gatedRequest, 'a new item is heard');
        clanRow = Supply.prepareRow([9, 1, [], 6]);
        assert.notEqual(heard(), gatedRequest, 'and a closed request');
        Economy.forget(native.characterId);
    } finally { Supply.useRowSource(null); }
    console.log('PASS held decision: read until woken / a woken build decides');
    // A held decision's proof names it (its identity: owner, generation, echo, leaf).
    // A saved decision restores under its own byte format and generation only.
    {
        const T = Date.now(), native = { ...base, characterId: 990024 };
        const deps = () => ({ timestamp: T, memoryIdentity: 'fixture-memory', sourceReady: true });
        const held = Economy.forState(native, deps());
        const packet = held.statsPacket, published = { ...native, stats: { ...native.stats, ...packet } };
        const proof = held.eventProof(), leaf = held.network.activity;
        assert(proof, 'fixture: a held proof');
        assert.equal(Economy.proofIdentity(published, proof, leaf), '', 'the proof names the published decision');
        assert.equal(Economy.proofIdentity({ ...published, stats: { ...published.stats, decisionSeq: packet.decisionSeq + 1 } }, proof, leaf),
            'decision_seq', 'and no other');
        const accepted = { card: { activity: held.network.activity }, characterId: native.characterId,
            decisionSeq: packet.decisionSeq, activityLeaf: packet.activityLeaf, focus: packet.wishFocus?.[0] ?? null,
            baseline: packet.wishSections };
        const bytes = Economy.restartEventProof(proof, accepted);
        assert(bytes instanceof Uint8Array, 'a restartable decision saves its prefix');
        const restored = Economy.restoreEventProof(bytes, accepted);
        assert.equal(Economy.proofIdentity(published, restored, leaf), '', 'the restored prefix names the saved decision');
        const older = Uint8Array.from(bytes); older[0] = 7;
        assert.equal(Economy.restoreEventProof(older, accepted), null, 'a prefix of the former format is refused');
        const kept = Generation.metadata();
        try {
            Generation.configure({ code: '3'.repeat(40), config: '2'.repeat(64) });
            assert.equal(Economy.restoreEventProof(bytes, accepted), null, 'a prefix of another generation is refused');
        } finally { Generation.configure(kept); }
        assert(Economy.restoreEventProof(bytes, accepted), 'fixture: the generation is back');
        Economy.forget(native.characterId);
        // A server with no published code identity (a branch tree) holds its
        // decisions within the process, but saves none for a restart.
        try {
            Generation.configure({ code: '4'.repeat(40), config: '2'.repeat(64), local: true });
            const local = Economy.forState(native, deps());
            const localPacket = local.statsPacket, localState = { ...native, stats: { ...native.stats, ...localPacket } };
            const localProof = local.eventProof();
            assert(localProof, 'a local identity still proves the decision');
            assert.equal(Economy.proofIdentity(localState, localProof, local.network.activity), '',
                'the held decision holds within the process');
            assert.equal(Economy.restartEventProof(localProof, { ...accepted, decisionSeq: localPacket.decisionSeq,
                activityLeaf: localPacket.activityLeaf, focus: localPacket.wishFocus?.[0] ?? null, baseline: localPacket.wishSections,
                card: { activity: local.network.activity } }), null, 'and saves no prefix for a restart');
            assert.equal(Economy.restoreEventProof(bytes, accepted), null, 'nor restores one');
        } finally { Generation.configure(kept); Economy.forget(native.characterId); }
    }
    // An unwoken far bot's step serves its card (situations step 4 C6): the card names its
    // decision whatever moved in its wallet, its bag or the prices (ColdEconomyDecision.refusal:
    // its proof's identity and the field guards only), and serving it clears no bit. A
    // situation that wakes its build (goal_affordable, a goal done) is the gate's, not the card's.
    {
        const T = Date.now(), native = { ...base, characterId: 990025, phase: 'cold', activity: 'hunting',
            inventory: { ...base.inventory, 1864: { selfId: 1864, amount: 50 } } };
        const deps = () => ({ timestamp: T, memoryIdentity: 'fixture-memory', sourceReady: true });
        const held = Economy.forState(native, { ...deps(), caller: 'step' });
        const packet = held.statsPacket, published = { ...native, stats: { ...native.stats, ...packet } };
        const Card = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const Situations = invoke('GameServer/Bot/Situations');
        const card = Card.advisory(held, published, published.activity, deps());
        assert(card, 'fixture: a card');
        assert.equal(Situations.woken(published.stats, 'build'), false, 'the build that made it took its bit');
        const moved = {
            wallet: { ...published, adena: published.adena * 3 + 1000 },
            loot: { ...published, inventory: { ...published.inventory, 1864: { selfId: 1864, amount: 90 }, 1865: { selfId: 1865, amount: 5 } } },
            rest: { ...published, activity: 'resting' }
        };
        for (const [name, state] of Object.entries(moved)) {
            assert.equal(Card.refusal(state, card, deps()), '', `a moved ${name} is no reason to decide`);
            const served = Card.refreshAdvisory(state, card, deps());
            assert(served, `the ${name} step serves the card`);
            assert.equal(served.economy.statsPacket.woken, undefined, 'a served card clears no bit');
        }
        // The craft step the decision prepared rides its served view: a town visit's plan carries it out.
        const shot = { wealth: [90001, 2] };
        assert.deepEqual(Card.refreshAdvisory(published, { ...card, card: Card.cardWithShot(card.card, shot) }, deps()).economy.shot, shot);
        const raised = Situations.raise({ ...published.stats }, 'goal_affordable:focus', null, Situations.place(published));
        assert(Situations.woken(raised, 'build'), 'its goal in reach wakes the build');
        assert.equal(Card.refusal({ ...published, stats: { ...published.stats, decisionSeq: packet.decisionSeq + 1 } }, card, deps()),
            'decision_seq', 'a card of another decision is refused');
        // The field guards: a field card serves no dead bot, nor a far bot whose held build is lost.
        assert.equal(Card.refusal({ ...published, activity: 'dead' }, card, deps()), 'not_field:dead', 'a dead bot builds');
        // A visit serves only the leaf that ordered it (its own town step: test_detour_own_trip); any
        // other (a hunting leaf's, a bag cleanup's, a stale one) builds in town at each step.
        assert.equal(Card.refusal({ ...published, activity: 'shopping', currentRegion: 'Giran' }, card, deps()), 'not_field:shopping',
            'a visit its leaf did not order builds');
        Economy.forget(native.characterId);
        assert.equal(Card.refusal(published, card, deps()), 'no_held', 'a lost held build builds');
    }
    // A woken build keeps the held entry's pieces while the facts each reads are the same
    // (EconomyContext PIECE_FACTS): the foundation (hunt, kit rates) and the ground verdict;
    // a kit move rebuilds both. Its money bounds are its own weighing's, never the last
    // decision's. A reader's build with no held entry re-weighs nothing.
    {
        const diagnosticsBefore = Config.developerDiagnostics;
        Config.developerDiagnostics = true;
        try {
            const T = Date.now();
            // T43 table: the focus is a power wish, which the ground keys on (economicHunt), so the bot
            // carries its own published focus, as a live bot does.
            const focus = Economy.forState({ ...base, characterId: 990027, phase: 'hot' }, { timestamp: T }).statsPacket.wishFocus;
            Economy.forget(990027);
            const native = { ...base, characterId: 990027, phase: 'hot', stats: { ...base.stats, wishFocus: focus } };
            const counts = () => invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts || {};
            const delta = (before, key) => (counts()[key] || 0) - (before[key] || 0);
            const held = Economy.forState(native, { timestamp: T });
            assert(held.plan.hunt && typeof held.plan.rates === 'object' && held.plan.rates, 'fixture: a held hunt and kit rates');
            const stale = { affordAt: { at: 11, kind: 'focus' } };
            const published = (from, extra = {}) => ({ ...native, ...extra, stats: { ...native.stats, ...from.statsPacket,
                wishSections: { ...from.statsPacket.wishSections, ...stale } } });
            const woken = state => Economy.forState(state, { timestamp: T, caller: 'step' });
            // The published decision (its kit rates read by the supply fact) is the held one.
            const first = woken(published(held));
            let before = counts();
            const same = woken(published(first));
            assert.notEqual(same.plan, first.plan, 'a woken build decides anew');
            assert.equal(same.plan.hunt, first.plan.hunt, 'and keeps the foundation hunt its facts name');
            assert.equal(same.plan.rates, first.plan.rates, 'and its kit rates');
            assert.equal(delta(before, 'source_route:ground:reuse'), 1, 'and the ground verdict');
            assert.equal(delta(before, 'context:foundation:kept'), 1, 'the kept foundation is counted');
            assert.notDeepEqual(same.statsPacket.wishSections.affordAt, stale.affordAt,
                'the build records its own money threshold, not the last decision\'s');
            before = counts();
            const leveled = woken(published(same, { level: native.level + 1 }));
            assert.notEqual(leveled.plan.hunt, same.plan.hunt, 'a kit move rebuilds the foundation');
            assert.equal(delta(before, 'source_route:ground:build'), 1, 'and the ground verdict');
            assert.equal(delta(before, 'context:foundation:built'), 1, 'the rebuilt foundation is counted');
            // No held entry (a deploy, an eviction): a reader builds every piece and re-weighs
            // no event (only a woken build reconsiders the published focus and step).
            Economy.forget(native.characterId);
            before = counts();
            Economy.forState(published(leveled), { timestamp: T });
            const named = Object.keys(counts()).filter(key => key.startsWith('network:reconsider:')
                && !key.startsWith('network:reconsider:quiet:') && delta(before, key) > 0);
            assert.deepEqual(named, [], 'a reader\'s build re-weighs no event');
        } finally {
            Config.developerDiagnostics = diagnosticsBefore;
            Economy.forget(990027);
        }
    }
    // A rest reads the held build's route rows.
    {
        const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
        const crafter = { ...base, characterId: 990032, craftLevel: 1, adena: 1000000 };
        const routeRows = Trip.prepared(crafter);
        try {
            Economy.forState(crafter, { routeRows });
            assert.strictEqual(Economy.preparedRouteRows({ ...crafter, activity: 'resting' }), routeRows, 'a rest reads the held build\'s route rows');
        } finally { Economy.forget(crafter.characterId); }
    }
    console.log('PASS a rest reads the held route rows');
    // The cheap check by kind of leaf: an enchant or special-ability decision
    // names its object: it holds while that object is in the bag at the
    // enchant level read; one without an object (an exchange) holds by its
    // bag rows. A failed row names itself.
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
            spotBackoffs: [{ spotId: 'crowded', untilStep: 12 }] } });
        const excluded = check(marked(11), hunt);
        assert.equal(excluded.reason, 'check:excluded', 'a marked spot refuses its hunt');
        // What the step that carries a leaf out raises on it (EconomyContext.leafOutcome).
        // A hunt's spot ruled out is the spot's situations' (they raised it): the hunt's step raises
        // only a material hunt's count reached.
        assert.equal(Economy.leafOutcome({ ...marked(11), phase: 'cold', activity: 'hunting' }, hunt), '', 'a marked spot is no hunt outcome');
        const material = { activity: 'hunting', spotId: 'crowded', itemId: 1864, amount: 5, heldAtDecision: 0 };
        assert.equal(Economy.leafOutcome({ ...base, phase: 'cold', activity: 'hunting', inventory: { 1864: { selfId: 1864, amount: 5 } } },
            material), 'goal_done:goal', 'a material hunt\'s count reached is its goal done');
        assert.equal(Economy.leafOutcome({ ...base, phase: 'cold', activity: 'hunting', inventory: {} }, material), '', 'a held hunt raises nothing');
        assert.equal(Economy.leafOutcome({ ...base, phase: 'cold', activity: 'hunting' }, { activity: 'shopping', itemId: 1 }), '',
            'a shop is checked where it happens, in town');
        // A sale is spent by the visit that ended after the build took it, the bot back toward its
        // ground: done when its items left the bag, refused when they stayed. Held past the visit, a
        // sale taken in town sent the bot back to town with its next loot.
        const sale = { activity: 'selling', town: 'Giran', items: [1864] };
        const back = (look, inventory = {}, activity = 'hunting', travel = null, seen = undefined) => ({ ...base, phase: 'cold', activity,
            inventory, stats: { ...base.stats, travel, wishSections: { at: 1000 }, townLook: { at: look, n: 1 },
                ...(seen ? { marketSellSeen: seen } : {}) } });
        assert.equal(Economy.leafOutcome(back(500), sale), '', 'a sale taken after the last visit waits for its own');
        assert.equal(Economy.leafOutcome(back(2000), sale), 'goal_done:goal', 'the visit that ended after it spent the sale');
        assert.equal(Economy.leafOutcome(back(2000, {}, 'traveling', { arrivalActivity: 'hunting' }), sale), 'goal_done:goal',
            'on the way back to its ground too');
        // Refused: the kinds left are on the visit's sale retry, which keeps them out of the next build's
        // sale until a new kind or a better buyer comes, so the refusal sends the bot back for nothing.
        const unsold = { 1864: { selfId: 1864, amount: 3 } };
        assert.equal(Economy.leafOutcome(back(2000, unsold, 'hunting', null, { items: [1864], buyers: null }), sale), 'goal_failed',
            'a visit that could not place its items refused it');
        assert.equal(Economy.leafOutcome(back(2000, unsold), sale), '',
            'a visit that never offered them (its sale did not run) leaves the step to its own trip');
        assert.equal(Economy.leafOutcome(back(2000, {}, 'traveling', { arrivalActivity: 'shopping' }), sale), '',
            'a trip on to a town (a craft warehouse return) is not the way back');
        assert.equal(check(marked(12), hunt), '', 'the mark is forgotten after its steps');
        const craft = check(base, { activity: 'crafting', recipeId: 999999 });
        assert.equal(craft.reason, 'check:craft', 'an unknown recipe refuses the craft');
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
    // The build's memos (inventory row keys, the kit fact) end with it: a row
    // changed after the build (a new bag: states are replaced, not edited in
    // place) reads fresh.
    // A nested build of another bot leaves the outer build's keys exact.
    {
        const T = Date.now(), deps = { timestamp: T }, Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        const fixture = equippedFixture(1310, 1, 30, 20000);
        const worn = Object.keys(fixture.inventory).find(id => fixture.inventory[id].equipped);
        const state = { ...fixture, inventory: { ...fixture.inventory, [worn]: { ...fixture.inventory[worn] } } };
        const kitBefore = Sections.kit(state);
        let outer = null, nested = null;
        try {
            ScopedProviders.build = (subject, ctx, buildDeps) => {
                if (subject === state && outer === null) {
                    outer = ctx;
                    Economy.forState(equippedFixture(1311, 1, 32, 30000), deps);
                    nested = Sections.kit(state);
                }
                return build(subject, ctx, buildDeps);
            };
            Economy.forState(state, deps);
        } finally { ScopedProviders.build = build; }
        assert(outer, 'the build reached its providers');
        assert.equal(nested, kitBefore, 'a nested build of another bot leaves the outer build\'s keys');
        const changed = { ...state, inventory: { ...state.inventory, [worn]: { ...state.inventory[worn], enchant: 3 } } };
        const fresh = structuredClone(changed);
        assert.equal(Sections.kit(changed), Sections.kit(fresh), 'the kit reads the changed row');
        assert.notEqual(Sections.kit(changed), kitBefore);
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
        assert.equal(Economy.forState(absentOut, { ...absentDeps(), timestamp: Date.now() + 10 * 60 * 1000 }).plan, absentContext.plan,
            'a first offer for an unwatched item keeps the held decision, however long after');
    } finally { ScopedProviders.build = build; }
    console.log('PASS absent item is read, its offer no event');
    {
        // A step's raises join the bits raised before; a raise is no decision, its sequence stays.
        const Situations = invoke('GameServer/Bot/Situations');
        const after = { decisionSeq: 3, woken: 0, wishSections: {}, equipmentPlan: {}, earning: {} };
        Situations.raise(after, 'grade_changed', null, Situations.REST);
        Situations.raise(after, 'goal_affordable:focus');
        assert.equal(after.decisionSeq, 3, 'no bump');
        assert(Situations.woken(after, 'build') && Situations.woken(after, 'earning_spot') && Situations.woken(after, 'gear_plan'),
            'the raised bits join the earlier ones');
    }
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
    // A reader reads the held plan; the bot's build reads what it observed (its gear threat).
    const threatBot = { ...base, characterId: 1901, phase: 'hot', spotId: physicalSpot.id,
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
    const decide = { ...threatDeps, caller: 'step' };
    const stillPhysical = Economy.forState(threatBot, decide);
    assert.equal(stillPhysical.gearThreatMask, 1, 'unobserved magic is not personal knowledge');
    threatBot.stats.targetCombat.lastDefeatedNpcIds = [130, 264];
    const magical = Economy.forState(threatBot, decide);
    assert.equal(magical.gearThreatMask, 3);
    assert.notEqual(magical.plan, stillPhysical.plan, 'own magic observation invalidates the whole projection');
    assert.equal(magical.statsPacket.decisionSeq, physical.statsPacket.decisionSeq);
    threatBot.stats.targetCombat.lastDefeatedNpcIds = [130];
    assert.equal(Economy.forState(threatBot, decide).gearThreatMask, 1);
    threatBot.stats.relations = [{ hostility: 1, targetId: 77 }];
    assert.equal(Economy.forState(threatBot, decide).gearThreatMask, 3, 'hostile intent prevents physical-only valuation');
    Economy.forget(threatBot.characterId);
    console.log('PASS contextual gear projection / own observation / unchanged tendency roll');
    const rich = { ...base, phase: 'hot', adena: 1e12 };
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
        // Main reads the rates this build publishes over the same bag.
        const rated = { ...base, stats: { ...base.stats, kitRates: context.statsPacket.kitRates,
            earning: { shotsPerHour: stock.usePerHour, potionsPerHour: context.stock('potions').usePerHour } } };
        assert.equal(Shot.keptAmounts(rated)[stock.itemId], stock.target);
        assert.equal(invoke('GameServer/Bot/Economy/PurchaseFunding').operatingReserve({ level: 78, adena: 1e9 }),
            Economy.basics({ level: 78, adena: 1e9 }).refillReserve, 'a bot without a packet reserves its kit, not a share of its wallet');
        const plan = Shot.restockPlan({ ...rated, adena: 1e8 }, { unitPrice: 10 });
        assert.equal(plan.targetAmount, stock.target);
        assert(plan.amount >= stock.survivalMissing && plan.amount <= stock.target, 'the floor permits survival and only worthwhile extra stock');
        assert.equal(plan.reserve, context.refillReserve);
        const potion = context.stock('potions');
        assert(invoke('GameServer/Bot/AI/HealingPotionStock').targetAmountFor(rated) >= potion.target,
            'the sale keeps at least the build\'s potion target (the wallet bounds a purchase, not what is kept)');
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
    // T126: a table row's death already waited for its respawn; a live one adds it.
    const deathHours = Valuation.deathHours(base, { expPerHour: 100000 });
    assert.equal(deathHours, death.expLost / 100000);
    // One live death price (a kill, a death in a fight, a PvP risk): the table row's plus the respawn wait.
    assert.equal(Valuation.liveDeathHours(deathHours), death.expLost / 100000 + 90 / 3600);
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
    // A situation raised on a member (its situationSeq) solves the group answer again.
    const raisedMember = { ...sampled, stats: { ...sampled.stats, situationSeq: (Number(sampled.stats?.situationSeq) || 0) + 1 } };
    assert.notEqual(Economy.forGroup({ id: 44, wallet: 100, playedHours: 4 }, [base, raisedMember]), group,
        'a member\'s raise solves the group answer again');
    assert(group.network.queue.every(wish => /^\d+:/.test(wish.key)), 'actual member graphs share one group queue');
    // perf C1: members that hit give the group the same graph as fresh builds.
    const groupDigest = g => JSON.stringify([g.inputKey, g.network.focus, g.network.activity?.key,
        g.network.queue.map(wish => [wish.key, wish.funded, wish.price, wish.valueHours])]);
    const fromHits = Economy.forGroup({ id: 'proposal:44', wallet: 100, playedHours: 4 }, [base, sampled]);
    Economy.forget(base.characterId); Economy.forget(sampled.characterId);
    const fromBuilds = Economy.forGroup({ id: 'proposal:44', wallet: 100, playedHours: 4 }, [base, sampled]);
    assert.equal(groupDigest(fromHits), groupDigest(fromBuilds), 'a group of held member reviews equals one of fresh builds');
    console.log('PASS real member providers reuse one group engine / purse');

    // A source fact kept with the held build (KeptSourceFacts) is served while
    // every input it read is the same, and answers as its fresh walk: walked
    // again on each input that moved, never on anything else.
    {
        const Providers = invoke('GameServer/Bot/Economy/WishProviders');
        const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
        const SpotEconomics = invoke('GameServer/Bot/Economy/SpotEconomics');
        const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
        const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
        // Two fields of Excuro (level 41, drops Cokes), the bot on the near one.
        const field = (id, center) => ({ id, avgLevel: 41, minLevel: 41, maxLevel: 41, levelCounts: { 41: 4 }, capacity: 9, density: 4,
            center, npcEntries: [{ selfId: 214, count: 4 }], npcSelfIds: [214] });
        const near = field('kept-near', { locX: 82000, locY: 148000, locZ: -3500 });
        const far = field('kept-far', { locX: 17000, locY: 170000, locZ: -3500 });
        const keptSpots = [...spots, near, far], cokes = 1879;
        const walk = Planner.sourceFacts;
        let walks = 0, walked = null;
        Planner.sourceFacts = function (...args) { walks++; walked?.add(Number(args[1])); return walk.apply(this, args); };
        try {
            const T = Date.now();
            let bot = { ...equippedFixture(990031, 2, 44, 20000), spotId: near.id, loc: near.center };
            bot.stats = { ...bot.stats, coldCombat: Profile.legacySnapshot(bot, Profile.skillRecordsFromTree(2, 44), T) };
            for (let n = 0; n < 3; n++) for (const spot of [near, far]) bot = { ...bot, stats: { ...bot.stats,
                huntEfficiency: Hunt.record(bot, { spotId: spot.id, timestamp: T, cycleMs: 60000, adena: 900, costs: 50, exp: 300, kills: 10 }) } };
            const built = Economy.forState(bot, { timestamp: T, spots: keptSpots });
            // The build's spot value reader, made again from these options; `read`: the spots any fact read.
            const valueOptions = { timestamp: T, persona: built.persona, price: built.price, deathHours: built.deathHours,
                hunt: built.hunt?.source === 'route' ? undefined : built.hunt };
            const read = new Set();
            const spotValueOf = (state, options = {}) => {
                const reader = SpotEconomics.create(state, { ...valueOptions, ...options });
                return Object.assign(spot => { read.add(spot); return reader(spot); }, { inputs: reader.inputs, hunters: reader.hunters });
            };
            // A stock root of Cokes: its fact walks both fields.
            const stock = kind => kind === 'shots' ? { ...built.stock('shots'), itemId: cokes, missing: 3, survivalMissing: 0,
                unitPrice: 1000, benefitPerUnit: 1, target: 3, current: 0 } : built.stock(kind);
            const contextOf = (state, extra = {}, options = {}) => ({ ...built, stock, spotValue: spotValueOf(state, options), ...extra });
            // walks: the held build's items walked again (an item it did not ask has no fact to keep).
            let asked = null;
            const project = (state, ctx, kept = null, deps = {}) => {
                walked = new Set();
                const projection = Providers.build(state, ctx, { spots: keptSpots, sourceGround: kept?.sourceGround ?? null,
                    keptFacts: kept?.keptFacts ?? null, ...deps });
                const again = [...walked].filter(id => !asked || asked.has(id));
                walked = null;
                return { projection, walks: again.length, items: again };
            };
            const answer = ({ projection }) => JSON.stringify({ nodes: projection.nodes, roots: projection.roots, values: [...projection.values],
                moneyPaths: projection.moneyPaths, horizon: projection.horizon, admission: projection.admission });
            const first = project(bot, contextOf(bot));
            assert(first.items.includes(cokes) && first.projection.keptFacts, 'fixture: the build walks the Cokes fact and keeps it');
            assert(read.has(near) && read.has(far), 'fixture: the fact read both fields');
            assert(first.projection.nodes.some(node => node.key === `item:${cokes}` && node.paths.some(path => path.kind === 'drop' && path.spotId === near.id)),
                'fixture: Cokes drops on the near field');
            asked = new Set(first.items);
            // A held build of the bot as it was: its ground cells and its facts.
            const held = () => project(bot, contextOf(bot)).projection;
            // The same rebuild walking every fact, on the same ground history.
            const walkedOn = (state, ctx, deps = {}) => project(state, ctx, { sourceGround: held().sourceGround }, deps);
            const same = project(bot, contextOf(bot), held());
            assert.equal(same.walks, 0, 'the same inputs walk no source fact');
            assert.equal(answer(same), answer(walkedOn(bot, contextOf(bot))), 'kept facts answer as walked ones');
            assert.equal(answer(same), answer(first), 'and as the build that kept them');
            // Anything a fact does not read keeps it: the wallet, a field no fact read.
            const unread = keptSpots.find(spot => !read.has(spot));
            for (const [name, state, ctx] of [['wallet', { ...bot, adena: bot.adena + 1e6 }, contextOf(bot, { wallet: 1e6 })],
                ['crowd elsewhere', bot, contextOf(bot, {}, { spotHunters: (spot, who) => SpotProfiles.spotHunters(spot, who) + (spot === unread ? 5 : 0) })]])
                assert.equal(project(state, ctx, held()).walks, 0, `${name}: kept`);
            // Every input a fact reads walks it again, to the walked answer.
            const moved = {
                level: [{ ...bot, level: bot.level + 1 }],
                readiness: [{ ...bot, inventory: {} }],
                spoiler: [{ ...bot, stats: { ...bot.stats, coldCombat: { ...bot.stats.coldCombat, skills: [...bot.stats.coldCombat.skills, { selfId: 254, level: 1 }] } } }],
                current: [{ ...bot, spotId: far.id }],
                economic_hunt: [{ ...bot, stats: { ...bot.stats, wishFocus: ['resale:1864', 1, 1] } }],
                excluded: [{ ...bot, stats: { ...bot.stats, spotBackoffs: [{ spotId: near.id, untilStep: 1e9 }] } }],
                hour: [bot, { hourAdena: built.hourAdena + 1 }],
                trip_rows: [bot, { trip: Trip.preparedReader(Trip.towns.map(() => [true, 0.5, 100]), { hourAdena: 100 }) }],
                death_hours: [bot, {}, { deathHours: built.deathHours * 2 + 1 }],
                consumable_price: [bot, {}, { price: id => 3 * built.price(id) + 1 }],
                money_weight: [{ ...bot, stats: { ...bot.stats, money: Packet.money({ hourAdena: 5000, moneyPrice: 3, refillReserve: 0, firstUnfundedPrice: 0 }) } }],
                samples: [{ ...bot, stats: { ...bot.stats, huntEfficiency: Hunt.record(bot, { spotId: far.id, timestamp: T, cycleMs: 30000, adena: 900, costs: 50, exp: 300, kills: 10 }) } }],
                risk: [{ ...bot, stats: { ...bot.stats, frustration: 1 } }],
                spot_risk: [{ ...bot, stats: { ...bot.stats, spotRisk: { spotId: near.id, windowFights: 10, windowDeaths: 5 } } }],
                crowd: [bot, {}, { spotHunters: (spot, who) => SpotProfiles.spotHunters(spot, who) + (spot === near ? 5 : 0) }]
            };
            for (const [name, [state, extra = {}, options = {}]] of Object.entries(moved)) {
                const rebuilt = project(state, contextOf(state, extra, options), held());
                assert(rebuilt.items.includes(cokes), `${name}: walked again`);
                assert.equal(answer(rebuilt), answer(walkedOn(state, contextOf(state, extra, options))), `${name}: as walked`);
            }
            // Another spot value table (a new file or rates) walks it again.
            {
                const before = held();
                invoke('GameServer/Bot/AI/SpotValueTable').useFile();
                const rebuilt = project(bot, contextOf(bot), before);
                assert(rebuilt.items.includes(cokes), 'table: walked again');
                assert.equal(answer(rebuilt), answer(walkedOn(bot, contextOf(bot))), 'table: as walked');
            }
            assert(project(bot, contextOf(bot), { ...held(), sourceGround: null }).items.includes(cokes), 'new ground cells: walked again');
            assert(project(bot, contextOf(bot), held(), { spots: [...keptSpots] }).items.includes(cokes), 'another spot list: walked again');
            // The build as a whole: a rebuild on kept facts decides, reads and
            // proves as the same rebuild walking them (a trip reader that names
            // no rows keeps none, with the same answers).
            const rebuild = (deps = {}) => {
                Economy.forget(bot.characterId);
                let state = bot;
                for (let round = 0; round < 3; round++) {
                    const ids = new Set(), before = walks;
                    const next = Economy.forState(state, { timestamp: T, spots: keptSpots, caller: 'step', ...(round === 2 ? deps : {}),
                        onSourceRead: id => ids.add(id) });
                    if (round === 2) return { next, ids: [...ids].sort((a, b) => a - b), walks: walks - before };
                    state = { ...state, adena: state.adena + 1000, stats: { ...state.stats, ...next.statsPacket } };
                }
            };
            const rows = Trip.preparedReader([], { hourAdena: 0 });
            const kept = rebuild(), fresh = rebuild({ tripCost: Object.assign(town => rows(town), { details: rows.details }) });
            assert(fresh.walks > kept.walks, 'fixture: the rebuild kept facts the other walked');
            const decision = ({ next }) => JSON.stringify({ queue: next.network.queue.map(wish => [wish.key, wish.funded, wish.price, wish.valueHours]),
                focus: next.network.focus, activity: next.network.activity, packet: next.statsPacket, watch: next.watchList,
                proof: next.eventProof() });
            assert(kept.next.eventProof(), 'fixture: the rebuild has its event proof');
            assert.equal(decision(kept), decision(fresh), 'the same decision and event proof');
            assert.deepEqual(kept.ids, fresh.ids, 'the same read items');
        } finally { Planner.sourceFacts = walk; Economy.forget(990031); }
        console.log('PASS kept source facts: same inputs served, each moved input walked, same decision and proof');
    }

    // The gear candidates a review weighed are kept with the held build
    // (KeptGearCandidates) and served while everything they read is the same:
    // weighed again on each input that moved, never on anything else, and the
    // build decides, reads and proves as the same build with nothing kept.
    {
        const Kept = invoke('GameServer/Bot/Economy/KeptGearCandidates');
        const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
        const Recipes = invoke('GameServer/Items/C4RecipeItems');
        // Weighing asks of each candidate whether the bot may take it up at
        // its acquisition rank: whether the list was weighed.
        const considerable = Planner.considerable;
        let weighed = 0;
        Planner.considerable = function (...args) { if (args.length === 4) weighed++; return considerable.apply(this, args); };
        // An artisan at 45 after its earring and ring (crafted from Silver Mold, Gemstone C, ...).
        const crafter = equippedFixture(990041, 56, 45, 1000000), gearBoard = new BoardIndex();
        const T = Date.now(), frameRecipe = Recipes.resolveVariantsByProductId(1892)[0].recipeId;
        const earringCounter = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(852);
        // [name, change, whether the list is weighed again]
        const steps = [
            ['same', {}, false],
            ['wallet', { adena: 1 }, false],
            // Lines and the bag of items no candidate is.
            ['material line', { line: [1886, 900] }, false],
            // The bot's own line on a candidate moves its lines, not its price.
            ['own line', { line: [852, 900], owner: crafter.characterId }, false],
            ['own line back', {}, false],
            ['material bag', { bag: 2131 }, false],
            ['workshop', { workshop: true }, false],
            ['recipes', { recipes: [frameRecipe] }, false],
            // A candidate's price: the held foundation's prices stand while the facts it
            // reads are the same (a price is no situation, EconomyContext PIECE_FACTS).
            ['gear price', { line: [852, 4000] }, false],
            ['gear price back', {}, false],
            // Trades on a candidate's counter move its price (the bot's error), not its lines.
            ['gear trades', { trades: 40 }, true],
            ['gear trades back', {}, true],
            ['poor', { adena: -998000 }, true],
            ['poor back', {}, true],
            ['level', { level: 46 }, true]
        ];
        // The bot through every step, each a build after a money event; keep
        // false: the same steps with nothing kept.
        const walk = (keep, bot = crafter, path = steps) => {
            Economy.forget(bot.characterId);
            const session = Kept.session;
            if (!keep) Kept.session = () => null;
            const out = [];
            // Each build's kit rates are the bot's, as a step publishes them.
            let kitRates;
            try {
                for (const [at, [name, change]] of [['first', {}], ...path].entries()) {
                    for (const id of [...gearBoard.records.keys()]) gearBoard.remove(id);
                    if (change.line) gearBoard.put({ id: 9100, ownerId: change.owner || 77, storeType: 1, custodyPolicy: 1, revision: 1, town: 'Giran',
                        lines: [{ lineId: 1, selfId: change.line[0], count: 3, price: change.line[1] }] });
                    const state = { ...bot, adena: bot.adena + at * 1000 + (change.adena || 0), level: change.level || bot.level,
                        marketTrades: change.trades ? { [earringCounter]: change.trades } : undefined,
                        inventory: change.bag ? { ...bot.inventory, [change.bag]: { selfId: change.bag, amount: 1 } } : bot.inventory,
                        stats: { ...bot.stats, ...(kitRates ? { kitRates } : {}) } };
                    const workshops = recipeId => change.workshop && recipeId === frameRecipe ? [{ characterId: 77, recipeId, price: 500,
                        townName: 'Giran', loc: { locX: 81000, locY: 148000, locZ: -3500 }, capacityBatches: 5 }] : [];
                    const ids = [];
                    weighed = 0;
                    const next = Economy.forState(state, { timestamp: T, spots, caller: 'step', fullReview: true, board: gearBoard, workshops,
                        knowledgeEnabled: true, ...(change.recipes ? { knownRecipes: change.recipes } : {}), onSourceRead: id => ids.push(id) });
                    kitRates = next.statsPacket.kitRates;
                    out.push({ name, weighed, decision: JSON.stringify({ nodes: next.projection.nodes, roots: next.projection.roots,
                        admission: next.projection.admission, queue: next.network.queue.map(wish => [wish.key, wish.funded, wish.price, wish.valueHours]),
                        focus: next.network.focus, activity: next.network.activity, packet: next.statsPacket, watch: next.watchList,
                        proof: next.eventProof(), ids },
                    (key, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value) });
                }
            } finally { Kept.session = session; Economy.forget(bot.characterId); }
            return out;
        };
        const check = (bot, path) => {
            const kept = walk(true, bot, path), fresh = walk(false, bot, path);
            assert(fresh.every(step => step.weighed > 0), 'fixture: with nothing kept every build weighs its gear candidates');
            for (const [at, [name, , again]] of path.entries())
                assert.equal(kept[at + 1].weighed > 0, again, `${name}: gear candidates ${again ? 'weighed again' : 'kept'}`);
            for (const [at, step] of kept.entries()) assert.equal(step.decision, fresh[at].decision, `${step.name}: the same decision, reads and event proof`);
        };
        try {
            check(crafter, steps);
            // A bot at 30 weighs its C pieces for the kit it prepares (level 40):
            // its wallet keeps them, a C piece in its bag (worn in the
            // preparation) weighs them again.
            // Its D kit worn (paired jewellery on both sides), so no gap is required.
            const preparing = { ...equippedFixture(990042, 1, 30, 300000), inventory: {} };
            for (const entry of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 1, level: 20 }).items) {
                const row = preparing.inventory[entry.selfId] ||= { selfId: Number(entry.selfId), amount: 0, equipped: true, equippedCount: 0,
                    equippedSlots: [], slot: Number(entry.slot), enchant: 0 };
                row.amount++; row.equippedCount++; row.equippedSlots.push(Number(entry.slot));
            }
            const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
            assert(Progression.preparation(preparing), 'fixture: the bot prepares its C kit');
            const future = Progression.preparation(preparing);
            const piece = [...ProvidersForKit.gearCandidates(future).values()].flat().find(item => item.etc?.rank === 'c'
                && !preparing.inventory[item.selfId] && Progression.preparation({ ...preparing,
                    inventory: { ...preparing.inventory, [item.selfId]: { selfId: Number(item.selfId), amount: 1 } } })?.inventory[item.selfId]?.equippedCount > 0);
            assert(piece, 'fixture: a C piece the preparation would wear');
            check(preparing, [['same', {}, false], ['wallet', { adena: 1 }, false], ['C piece in bag', { bag: Number(piece.selfId) }, true],
                ['C piece back', {}, true]]);
        } finally { Planner.considerable = considerable; }
        console.log('PASS kept gear candidates: same inputs served, each moved input weighed again, same decision, reads and proof');
    }

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
    const Situations = invoke('GameServer/Bot/Situations');
    assert(Situations.woken(actualDeath.stats, 'build'), 'actual death wakes the build');
    assert.equal(actualDeath.stats.decisionSeq, 9, 'a raise is no decision: its sequence waits for the build');
    assert.equal(actualDeath.stats.activityLeaf, resolveInput.stats.activityLeaf, 'death keeps the held step for the next build to reconsider');
    const levelExpGain = Math.max(1, Data.experience[base.level] - resolveInput.exp + 1);
    // A far bot hears its new level at the rest (on the hunt it waits).
    const levelGain = await Life.prepareResolve(resolveInput, { ...resolveResult, patch: { activity: 'resting' },
        materialize: { ...resolveResult.materialize, exp: levelExpGain } }, resolveOptions);
    assert(levelGain.level > resolveInput.level, 'the fixture really earns a new level');
    assert(Situations.woken(levelGain.stats, 'build'), 'actual level gain wakes the build at the rest');
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
