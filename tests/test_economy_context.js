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
let Economy;
async function run() {
    require(path.join(root, 'src/Global'));
    const Data = invoke('GameServer/DataCache'); Data.init();
    const Database = invoke('Database');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const capture = Profile.capture;
    try {
        Profile.capture = () => ({});
        let craftLevel = 0;
        const actor = { fetchId: () => 999001, fetchLevel: () => 16, fetchClassId: () => 53,
            backpack: { fetchItems: () => [], fetchDwarvenCraftLevel: () => craftLevel } };
        const session = { coldLifeState: { craftLevel: 1, stats: { dwarvenCraftLevel: 1 } } };
        const unlearned = Economy.stateForActor(actor, session);
        assert.equal(unlearned.craftLevel, 0, 'native hot zero overrides stored cold capability');
        craftLevel = 1;
        const learned = Economy.stateForActor(actor, session);
        assert.equal(learned.craftLevel, 1);
        assert.notEqual(Economy.inputKey(unlearned), Economy.inputKey(learned), 'learning invalidates the planning inputs');
        assert.notEqual(Economy.inputKey({ level: 16, stats: { classId: 53, dwarvenCraftLevel: 0 } }),
            Economy.inputKey({ level: 16, stats: { classId: 53, dwarvenCraftLevel: 1 } }));
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
            assert.equal(Economy.forState(crafter, deps), context, 'another producer sale cannot rebuild this bot');
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
    const warrior = equippedFixture(1300, 1, 30, 20000);
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
    assert(warriorContext.purchaseBudget(warriorStock.itemId) >= 1728 * warriorStock.unitPrice);
    assert(warriorContext.purchaseBudget(warriorStock.itemId) <= warrior.adena);
    assert(warriorContext.purchaseBudget(1) <= warrior.adena - reserve);
    assert(warriorContext.statsPacket.money.length >= 4 && warriorContext.statsPacket.money.length <= 28);
    assert(warriorContext.statsPacket.money.every(Number.isFinite) && warriorContext.statsPacket.money[2] > 0);
    const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
    for (const wallet of [0, 20000, 200000, 1000000, 50000000]) {
        const state = { ...warrior, adena: wallet };
        const context = Economy.forState(state, kitDeps);
        assert(Math.abs(context.hourAdena - 76797) < 1);
        assert(context.moneyPrice >= 1 / context.hourAdena);
        assert(Profit.margin({ productCount: 100, successRate: 100, mpCost: 5 }, 10, 500,
            { ...context, mpPerHour: 1000 }));
    }
    const gladiator = Economy.forState(equippedFixture(1202, 2, 50, 1000000), kitDeps);
    assert(Math.abs(gladiator.hourAdena - 123854) < 1);
    assert.equal(gladiator.moneyPrice, 1 / gladiator.hourAdena);
    const stocked = { ...warrior, inventory: { ...warrior.inventory,
        [warriorStock.itemId]: { selfId: warriorStock.itemId, amount: Math.ceil(warriorStock.usePerHour) } } };
    assert.equal(Economy.basics(stocked, kitDeps).kitCost(warriorStock.itemId), 0);
    assert.equal(Economy.basics(stocked, kitDeps).survivalReserve, warriorContext.price(736),
        'own one-hour shot stock releases its wallet reserve and retains the escape scroll');
    const criminal = Economy.basics({ ...warrior, stats: { ...warrior.stats, karma: 100 } }, kitDeps);
    assert.equal(criminal.kitCost(736), 0);
    const without = Table.value(warriorContext.bestSpotId, 'dps', 30, false);
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
    assert.equal(Economy.forState(base), context, 'unchanged own inputs reuse the complete context');
    const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    const shopRecipe = Object.values(invoke('GameServer/Items/C4RecipeItems').loadRecipeItems())
        .find(row => row.type === 'dwarven' && Number(row.mpCost) > 0);
    const shopOwner = { ...base, characterId: 1801, simulation: { ownerId: 'legacy_main', revision: 1 },
        vitals: { ...base.vitals, mp: shopRecipe.mpCost * 5 },
        stats: { ...base.stats, workshop: { entries: [{ recipeId: shopRecipe.recipeId, price: 100 }] } } };
    const shopSaved = changes => Workshop.register({ ...shopOwner, ...changes,
        simulation: { ...shopOwner.simulation, revision: shopOwner.simulation.revision + 1 } });
    try {
        Workshop.register(shopOwner);
        assert.equal(Workshop.publicRecipeRows(shopOwner.characterId).length, 1);
        // Every market read of this customer carries the workshop digest.
        const shopDeps = () => ({ workshops: Workshop.publicForRecipe,
            workshopRevision: () => Workshop.publicRecipeDigest(shopRecipe.productId) });
        const shopContext = Economy.forState(base, shopDeps());
        assert.equal(Economy.forState(base, shopDeps()), shopContext);
        shopSaved({ vitals: { ...shopOwner.vitals, mp: shopRecipe.mpCost * 6 } });
        assert.equal(Economy.forState(base, shopDeps()), shopContext,
            'a workshop owner save without an offer change keeps the customer cache hit');
        shopSaved({ vitals: { ...shopOwner.vitals, mp: shopRecipe.mpCost * 2 } });
        assert.notEqual(Economy.forState(base, shopDeps()), shopContext, 'halved capacity is an offer change');
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
    assert.equal(Economy.forState(threatBot, threatDeps), physical);
    threatBot.stats.targetCombat.lastDefeatedNpcIds = [130, 130];
    assert.equal(Economy.forState(threatBot, threatDeps), physical, 'same applicability preserves context');
    threatBot.spotId = mixedSpot.id;
    const stillPhysical = Economy.forState(threatBot, threatDeps);
    assert.equal(stillPhysical.gearThreatMask, 1, 'unobserved magic is not personal knowledge');
    threatBot.stats.targetCombat.lastDefeatedNpcIds = [130, 264];
    const magical = Economy.forState(threatBot, threatDeps);
    assert.equal(magical.gearThreatMask, 3);
    assert.notEqual(magical, stillPhysical, 'own magic observation invalidates the whole projection');
    assert.equal(magical.statsPacket.decisionSeq, physical.statsPacket.decisionSeq);
    assert.equal(threatBot.stats.activityLeaf, 88, 'preparing threat never changes the saved activity');
    assert.equal(threatBot.stats.decisionSeq, 7, 'preparing threat never starts a decision event');
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
    assert.equal(richContext.network.gap, null);
    assert(richContext.gapHorizonHours > 0, 'affordable useful wishes retain their own waiting horizon');
    assert(PriceDecision.traderOf({ traits: { commitment: 0 } }, richContext).wait > 0);
    assert(PriceDecision.traderOf({ traits: { commitment: 0 } }, richContext).wait
        > PriceDecision.traderOf({ traits: { commitment: 1 } }, richContext).wait);

    assert.equal(richContext.hourAdena, context.hourAdena, 'wallet cannot change repeatable income');
    assert.notEqual(richContext, context, 'native wallet changes invalidate funding');
    console.log('PASS shared network hour / funding / input cache / bounded native gear');

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
    const mage = { ...base, characterId: 903, level: 40, sp: 100000,
        stats: { ...base.stats, classId: 14, exp: Data.experience[39], coldCombat: { classId: 14, skillSource: 'database', skills: [] } } };
    const missing = Catalog.missingBooks(mage);
    const valuable = missing.find(book => Providers.skillGain(mage, book).attack > 0);
    assert(valuable, 'actual unlearned first-rank offensive skill has native improvement');
    const bookContext = Economy.forState(mage);
    assert(bookContext.projection.nodes.some(node => node.key === `book:${valuable.skillId}`), 'real book competes with gear roots');
    const withBook = { ...mage, inventory: { ...mage.inventory, [valuable.selfId]: { selfId: valuable.selfId, amount: 2 } } };
    const paid = Catalog.applyTraining(withBook, { spentSp: valuable.sp, consumedBooks: [{ selfId: valuable.selfId, amount: 1 }] });
    assert.equal(paid.sp, withBook.sp - valuable.sp);
    assert.equal(paid.inventory[valuable.selfId].amount, 1);
    assert.notEqual(Economy.inputKey(mage), Economy.inputKey({ ...mage, sp: mage.sp + 1 }));
    assert.notEqual(Economy.inputKey(mage), Economy.inputKey({ ...mage, stats: { ...mage.stats,
        coldCombat: { ...mage.stats.coldCombat, skills: [{ selfId: valuable.skillId, level: 1 }] } } }));
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
    console.log('PASS actual book gain/provider/paid delta and skill/SP event key');

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
    assert.equal(prepared.stats.decisionSeq, 10);
    assert.equal(retried.stats.decisionSeq, prepared.stats.decisionSeq);
    assert.equal(retried.stats.activityLeaf, prepared.stats.activityLeaf);
    assert.equal(resolveInput.stats.decisionSeq, 9, 'projection does not mutate its decision source');
    assert.equal(prepared.stats.wishFocus?.length, 3);
    assert.equal(prepared.inventory[1].amount, 1);
    assert.equal(Database.isReady(), false);
    assert.deepEqual(fs.readdirSync(dir), ['config.ini']);
    console.log('PASS actual needs hookup / hard survival floor / no SQL or saves');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Economy?.reset();
    process.chdir(oldCwd);
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(dir, { recursive: true, force: true });
});
