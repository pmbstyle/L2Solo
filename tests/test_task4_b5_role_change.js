'use strict';
// Task 4 B5 (N8): the role side changes between the worker's card and the
// craft step. A committed role loss (level 30 -> 20, Artisan craft level 3 -> 2)
// landing before the step makes it stale: no recipe check, no write, one
// refresh, goal kept. A card on the lowered state for a recipe above the new
// craft level stops at the craft-skill check: no write, no penalty, goal kept.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Goals = invoke('GameServer/Bot/Goals/GoalState');
const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const ShotPolicy = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const Craft = invoke('GameServer/Bot/Economy/CraftEligibility');
const CraftShop = invoke('GameServer/Bot/Economy/CraftShopService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const owner = 730271, ARTISAN = 56, RECIPE = 46, epoch = 'b5-role', restore = [];
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
const lifeRow = async (patch) => ({ ...(await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [owner]]))[0], ...patch });
(async () => {
    const world = await createWorld([{ id: owner, classId: ARTISAN, level: 30 }], 'task4-b5-role');
    try {
        await Life.init();
        await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Life.upsertState({ characterId: owner, phase: 'cold', activity: 'hunting', level: 30, adena: 100000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)), loc: { locX: 0, locY: 0, locZ: 0 },
            currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 500, maxMp: 500 },
            stats: { classId: ARTISAN, money: [100, 1, 1000, 0] } }, 'fixture');
        const goal = (await Goals.set(owner, { type: 'progress_level', status: 'active', target: { level: 50 } })).current;
        const recipe = Recipes.resolveByRecipeId(RECIPE);
        assert.equal(Number(recipe.level), 3);
        assert.equal(Craft.canCraft(Life.cachedState(owner), recipe), true, 'the Artisan at 30 can craft the step');
        assert.equal(Wealth.eligible(Life.cachedState(owner)), true);

        const coordinator = new ColdSimulationCoordinator();
        Object.assign(coordinator, { worker: { postMessage() {} }, workerEpoch: epoch, ready: true });
        const refreshes = [];
        coordinator.requestEconomyRefresh = id => { refreshes.push(id); return true; };
        stub(ShotPolicy, 'unpackStep', () => ({ wealth: { recipeId: RECIPE, batches: 1 } }));
        let rechecks = 0, skill = [], executes = 0, writes = 0, race = null;
        const realRecheck = Wealth.recheck, realUpsert = Life.upsertState, realAdmit = Database.withMutationAdmission;
        stub(Wealth, 'recheck', (...args) => { rechecks++; return realRecheck.apply(Wealth, args); });
        // The recipe check reads the craft skill first; record its answers.
        stub(CraftShop, 'canCraft', (state, row) => { const ok = Craft.canCraft(state, row); if (Number(row?.recipeId) === RECIPE) skill.push(ok); return ok; });
        stub(Wealth, 'execute', async state => { executes++; return { state }; });
        stub(Life, 'upsertState', async (...args) => { writes++; return realUpsert.apply(Life, args); });
        stub(Database, 'withMutationAdmission', async (before, work) => {
            if (race) { Life.acceptLifecycleRow(race); race = null; }
            return realAdmit.call(Database, before, work);
        });
        let serial = 0;
        const card = state => Protocol.envelope('ready', epoch, { phase: 'economy_plan_ready', characterId: owner,
            authority: Commit.authority(state), economyPlan: { shot: [RECIPE, 1] },
            economyDecision: { updatedAt: Number(state.updatedAt || 0), key: Decision.stateKey(state) } }, `b5-role-${++serial}`);
        const kept = () => {
            assert.deepEqual(Goals.snapshot(owner).current, goal, 'the goal is kept');
            assert.equal(Life.cachedState(owner).stats?.marketRetryAfter, undefined, 'no retry penalty');
        };

        // 0. Control: a card on the unchanged role reaches the recipe check.
        await coordinator.onMessage(card(Life.cachedState(owner)), coordinator.worker, epoch);
        assert.equal(rechecks, 1, 'the control card reaches the craft step');
        assert.deepEqual(skill, [true], 'the unchanged role passes the craft-skill check');
        const [beforeRefresh, beforeExecutes] = [refreshes.length, executes];
        writes = 0;

        // 1. The level drops by a commit after the card, before the craft step.
        const revision = Number(Life.cachedState(owner).simulation?.revision || 0);
        const prepared = Life.cachedState(owner);
        race = await lifeRow({ level: 20, simulationRevision: revision + 1 });
        await coordinator.onMessage(card(prepared), coordinator.worker, epoch);
        assert.equal(race, null, 'the role change landed mid-plan');
        assert.equal(Life.cachedState(owner).level, 20);
        assert.equal(Craft.canCraft(Life.cachedState(owner), recipe), false, 'craft level 2 is below the recipe');
        assert.equal(rechecks, 1, 'a stale craft step never reaches the recipe check');
        assert.deepEqual(skill, [true]);
        assert.equal(executes, beforeExecutes, 'nothing is crafted');
        assert.equal(writes, 0, 'no state write');
        assert.deepEqual(refreshes.slice(beforeRefresh), [owner], 'one refresh asks the worker for a new card');
        kept();

        // 2. A card on the lowered role for the same recipe stops at the craft-skill check.
        await coordinator.onMessage(card(Life.cachedState(owner)), coordinator.worker, epoch);
        assert.equal(rechecks, 2, 'the card on the new state reaches the recipe check');
        assert.deepEqual(skill, [true, false], 'the lowered craft skill refuses the recipe');
        assert.equal(executes, beforeExecutes, 'a recipe above the craft level is not crafted');
        assert.equal(writes, 0, 'no state write');
        assert.equal(refreshes.length, beforeRefresh + 1, 'a refused recipe is no stale card: no extra refresh');
        kept();
        console.log('PASS Task 4 B5 role change: stale role step writes nothing and refreshes once, lowered skill crafts nothing, goal kept');
    } finally { for (const fn of restore.reverse()) fn(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
