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
    if (process.argv.includes('--producer-status')) {
        const zero = Economy.forState(base, { productionStatus: { incomePerHour: 0, nextIncomePerHour: 200,
            rank: 2, inputKey: 'known-zero' } });
        const wish = zero.projection.nodes.find(node => node.key === 'status:producer');
        assert(wish?.valueHours > 0, 'known zero production income can seek a known better producer rate');
        assert.equal(wish.paths[0].available, false, 'status alone cannot invent an executable recipe');
        const unknown = Economy.forState(base, { productionStatus: { incomePerHour: null, nextIncomePerHour: 200,
            rank: null, inputKey: 'unplayed-unknown' } });
        assert(!unknown.projection.nodes.some(node => node.key === 'status:producer'));
        assert.equal(Database.isReady(), false);
        assert.deepEqual(fs.readdirSync(dir), ['config.ini']);
        console.log('PASS known zero producer ambition / unknown income refusal / concrete recipe gate / no SQL');
        return;
    }
    const context = Economy.forState(base);
    assert(context.projection.nodes.length <= 40 && context.projection.roots.length <= 12);
    assert(context.network.queue.length && context.moneyPrice > 0 && context.hourAdena > 0);
    assert.equal(Hunt.hourValue(base).perHour, context.hourAdena);
    assert(context.network.activity && ['hunting','shopping','crafting','selling','pvp','helping'].includes(context.network.activity.activity));
    assert.equal(Economy.forState(base), context, 'unchanged own inputs reuse the complete context');
    const rich = { ...base, adena: 1e12 };
    const richContext = Economy.forState(rich);
    assert.equal(richContext.moneyPrice, 0);
    assert.equal(richContext.hourAdena, null, 'all funded is no meaningful price of money');
    assert.notEqual(richContext, context, 'native wallet changes invalidate funding');
    console.log('PASS shared network hour / funding / input cache / bounded native gear');

    const stock = context.stock('shots');
    assert(stock.usePerHour > 0 && stock.target === Math.ceil(stock.usePerHour * stock.targetHours));
    const Shot = invoke('GameServer/Inventory/ShotStock');
    assert.equal(Shot.keptAmounts(base)[stock.itemId], stock.target);
    assert.equal(invoke('GameServer/Bot/Economy/PurchaseFunding').operatingReserve({ level: 78, adena: 1e9 }), 0);
    const plan = Shot.restockPlan({ ...base, adena: 1e8 }, { unitPrice: 10 });
    assert.equal(plan.targetAmount, stock.target);
    assert.equal(plan.amount, stock.target);
    assert.equal(plan.reserve, 0);
    const potion = context.stock('potions');
    assert.equal(invoke('GameServer/Bot/AI/HealingPotionStock').targetAmountFor(base), potion.target);
    const gap = context.network.queue.find(row => !row.funded);
    const stockWish = context.network.queue.find(row => row.key === 'stock:shots');
    if (stockWish && gap.key !== stockWish.key && context.network.queue.indexOf(gap) < context.network.queue.indexOf(stockWish)) {
        assert.equal(context.purchaseBudget(stock.itemId), 0, 'stock below the first gap cannot spend its earmarked money');
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

    const requests = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(base);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].inputKey, context.inputKey);
    const dead = invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate({ ...base, activity: 'dead' });
    assert.equal(dead[0].type, 'recover'); assert.equal(dead[0].priority, 100);
    const beforeProfile = Profile.profileFor(base);
    assert(beforeProfile.pAtk > 0);
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const prepared = await Life.prepareResolve({ ...base, exp: base.stats.exp, sp: 0,
        stats: { ...base.stats, classProgressionLevel: base.level, classProgressionClassId: 1,
            coldCombat: { classId: 1, skillSource: 'database', skills: [] } } }, {
        patch: { activity: 'hunting' }, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        debug: {}, nextResolveAt: Date.now() + 60000
    }, { persist: false, projectClassProgression: true });
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
