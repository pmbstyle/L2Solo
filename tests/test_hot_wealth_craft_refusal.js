'use strict';
// A near crafter's resale craft refused at the act holds the same refusal mark a
// far bot's does, on its body, so its next build does not pick that craft again.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const World = invoke('GameServer/World/World');
const Craft = invoke('GameServer/Bot/Economy/CraftShopService');
const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
const Hot = require('../src/GameServer/Bot/Economy/HotWealthCraftService');
const ColdWealth = require('../src/GameServer/Bot/Economy/ColdWealthCraftService');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Writes = invoke('GameServer/Persistence/CharacterWriteQueue');
const Database = invoke('Database');

const recipe = Recipes.resolveByRecipeId(79);
const id = 990701;
const actor = { fetchId: () => id, fetchHp: () => 100, fetchMp: () => 1000, isDead: () => false,
    fetchIsOnline: () => true, fetchPrivateStoreType: () => 0, state: { fetchHits: () => false, fetchCasts: () => false },
    backpack: { fetchRecipeBook: () => [{ recipeId: recipe.recipeId }] } };
const session = { actor, decisionStats: { townLook: { n: 3 } } };
const leaf = { activity: 'crafting', rootKey: `resale:${recipe.productId}`, recipeId: recipe.recipeId };
const original = { stateForActor: Economy.stateForActor, registered: World.registeredActorById,
    isServiceCrafter: Craft.isServiceCrafter, canCraft: Craft.canCraft, recheck: ColdWealth.recheck, admit: Commit.admit,
    cachedState: Life.cachedState, flush: Writes.flushCharacter, craft: Database.craftInventoryItems };
(async () => {
    try {
        Economy.stateForActor = (_actor, body) => ({ characterId: id, phase: 'hot', activity: 'hunting', accountName: 'bot_hot',
            inventory: {}, stats: Events.decisionStatsFor(body) });
        const registered = { actor, session };
        World.registeredActorById = () => registered;
        Craft.isServiceCrafter = () => true;
        Craft.canCraft = () => true;
        assert(Hot.canStart(session, leaf), 'the fixture crafter may start its held craft');
        // No money packet: the step's recheck refuses the craft (recipe_state).
        const before = Events.rejections()['wealth:recipe_state'] || 0;
        const result = await Hot.review(session, { network: { activity: leaf }, statsPacket: {} });
        assert.equal(result.attempted, false);
        const stats = Events.statsFor(session);
        assert.deepEqual(stats.wealthRefused?.recipes, [recipe.recipeId], 'the refused craft holds its mark on the body');
        assert(Wealth.refused({ stats }, recipe.recipeId), 'the build does not pick it again before the next town look');
        assert(!Wealth.refused({ stats: { ...stats, townLook: { n: 4 } } }, recipe.recipeId), 'the next town look ends the mark');
        assert.equal(Events.rejections()['wealth:recipe_state'], before + 1, 'the refusal is counted by its reason');
        // A refusal of a decision the body no longer holds marks nothing: its newer
        // decision was built on newer facts.
        const newer = registered.session = { actor, decisionStats: { townLook: { n: 3 }, decisionSeq: 5 } };
        const late = await Hot.review(newer, { network: { activity: leaf }, statsPacket: { decisionSeq: 4 } });
        assert.equal(late.attempted, false);
        assert.equal(Events.statsFor(newer).wealthRefused, undefined, 'a stale refusal leaves the newer decision unmarked');
        assert.equal(Events.rejections()['wealth:recipe_state'], before + 1, 'a stale refusal is not counted');
        // The durable exchange refuses a craft the recheck let through: the act marks
        // it as a recheck refusal does, and the next tick hunts instead of trying again.
        const material = (row, index) => ({ fetchId: () => 500 + index, fetchSelfId: () => row.selfId,
            fetchAmount: () => row.amount, fetchEquipped: () => false });
        const crafter = { ...actor, backpack: { ...actor.backpack, fetchItems: () => recipe.materials.map(material),
            fetchDwarvenCraftLevel: () => recipe.level, fetchCommonCraftLevel: () => recipe.level } };
        const body = registered.session = { actor: crafter, botSession: true, decisionStats: { townLook: { n: 3 } } };
        registered.actor = crafter;
        ColdWealth.recheck = () => ({ basket: { purchases: [] } });
        Life.cachedState = () => ({ characterId: id, phase: 'hot' });
        Commit.admit = async () => ({ command: ['near-craft', Commit.KINDS.craft, 0] });
        Writes.flushCharacter = async () => {};
        let exchanges = 0;
        Database.craftInventoryItems = async () => { exchanges++; throw Error('craft_skill_or_mp_changed'); };
        const refusedBefore = Events.rejections()['wealth:craft_refused'] || 0;
        const act = await Hot.review(body, { network: { activity: leaf }, statsPacket: {} });
        assert.deepEqual(act, { attempted: true, crafted: false });
        assert.equal(exchanges, 1);
        assert(Wealth.refused({ stats: Events.statsFor(body) }, recipe.recipeId), 'the craft refused at the act holds its mark');
        assert.equal(Events.rejections()['wealth:craft_refused'], refusedBefore + 1, 'the act refusal is counted');
        assert(!Hot.canStart(body, leaf), 'the next tick does not start the refused craft');
        assert.deepEqual(await Hot.review(body, { network: { activity: leaf }, statsPacket: {} }), { attempted: false });
        assert.equal(exchanges, 1, 'no second exchange for the refused craft');
        console.log('PASS a near crafter refused at the act holds the craft refusal mark until its next town look');
    } finally {
        Economy.stateForActor = original.stateForActor; World.registeredActorById = original.registered;
        Craft.isServiceCrafter = original.isServiceCrafter; Craft.canCraft = original.canCraft;
        ColdWealth.recheck = original.recheck; Commit.admit = original.admit; Life.cachedState = original.cachedState;
        Writes.flushCharacter = original.flush; Database.craftInventoryItems = original.craft;
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
