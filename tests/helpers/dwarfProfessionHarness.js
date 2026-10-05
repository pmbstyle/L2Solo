// Dwarf walkthroughs use the live recipe packets, skill models and SQLite.
const assert = require('node:assert/strict');
const shared = require('./secondProfessionHarness');
const { Database, DataCache, Service, H } = shared;
const Actor = invoke('GameServer/Actor/Actor');
const Writes = invoke('GameServer/Persistence/CharacterWriteQueue');
const UseItem = invoke('GameServer/Network/Request/UseItem');
const Make = invoke('GameServer/Network/Request/RecipeItemMakeSelf');
const Book = invoke('GameServer/Network/Request/RecipeBookOpen');
const Recipes = invoke('GameServer/Items/C4RecipeItems');

async function createTrialWorld(...args) {
    const c = await shared.createTrialWorld(...args), level = c.level;
    c.level = async n => { c.session.actor.setLevel?.(n); await level(n); };
    return c;
}

async function realActor(c, train = false) {
    c.session.actor.automation?.abortAll(c.session.actor, { notifyClient: false });
    const row = await c.world.character(c.id), template = DataCache.classTemplates.find(t => t.classId === row.classId);
    const recipes = await Database.fetchCharacterRecipes(c.id);
    c.session.actor = new Actor(c.session, { ...row, ...utils.crushOb(template), id: c.id, name: row.name, username: row.username,
        level: row.level, classId: row.classId, title: '', isActive: 1, items: await Database.fetchItems(c.id),
        paperdoll: utils.tupleAlloc(16, {}), dwarvenRecipes: recipes.filter(r => r.type === 'dwarven'), commonRecipes: recipes.filter(r => r.type === 'common') });
    c.session.dataSendToOthers = p => c.session.packets.push(p);
    if (train) {
        // Existing first-class dwarves retain Create Item learned as a Dwarven Fighter.
        await c.session.actor.skillset.awardSkills(c.id, 53, row.level);
        await c.session.actor.skillset.awardSkills(c.id, row.classId, row.level);
    } else await c.session.actor.skillset.populate(c.id);
    invoke('GameServer/Actor/Generics/CalculateStats')(c.session, c.session.actor);
}

async function learn(c, itemId, recipeId) {
    const item = c.session.actor.backpack.fetchItems().find(i => i.fetchSelfId() === itemId);
    assert(item, `recipe scroll ${itemId}`);
    const packet = Buffer.alloc(5); packet.writeInt32LE(item.fetchId(), 1);
    UseItem(c.session, packet);
    await Writes.flushCharacter(c.id);
    assert((await Database.fetchCharacterRecipes(c.id)).some(r => r.recipeId === recipeId));
    Book(c.session, Buffer.alloc(5));
    const book = c.session.packets.filter(p => p[0] === 0xd6).at(-1);
    assert(Array.from({ length: book.readInt32LE(9) }, (_, n) => book.readInt32LE(13 + n * 8)).includes(recipeId));
}

async function craft(c, recipeId, n = 1) {
    const recipe = Recipes.resolveByRecipeId(recipeId), packet = Buffer.alloc(5);
    packet.writeInt32LE(recipeId, 1);
    for (let i = 0; i < n; i++) {
        // Regeneration between crafts replenishes the actor; the craft packet spends real MP.
        c.session.actor.setMp(c.session.actor.fetchMaxMp());
        await Database.execute(['UPDATE characters SET mp = ? WHERE id = ?', [c.session.actor.fetchMp(), c.id]]);
        const before = await c.amount(recipe.productId), mp = c.session.actor.fetchMp();
        assert.equal(await Make(c.session, packet), true);
        assert.equal(await c.amount(recipe.productId), before + recipe.productCount);
        assert.equal(c.session.actor.fetchMp(), mp - recipe.mpCost);
        assert.equal((await c.world.character(c.id)).mp, mp - recipe.mpCost);
        c.session.actor.automation.abortAll(c.session.actor, { notifyClient: false });
    }
}

async function guildsman(c, { artisan = false, weak = false, stopAtRecipe = false } = {}) {
    const before = await c.world.character(c.id), diamonds = await c.amount(7562);
    await c.level(34); await Service.giveItem(c.session, 57, 1999);
    assert.equal(await c.event(216, 'start', 7103), false);
    await c.level(35); assert.equal(await c.event(216, 'start', 7103), false);
    await Service.giveItem(c.session, 57, 1); await c.click(216, 'start', 7103);
    assert.equal(await c.amount(57), 0);
    for (const npc of [7283, 7103]) await c.click(216, 'handin', npc);
    await c.kill(154); await c.click(216, 'handin', 7283);
    await realActor(c, true); await learn(c, 3024, 315);
    if (stopAtRecipe) return;
    await c.click(216, 'handin', 7298); assert.equal(c.state(216).getInt('pinter'), 0);
    await c.level(36); await realActor(c, true);
    // Start both independent branches; complete Pinter before Norman's materials.
    for (const npc of [7210, 7688, 7298]) await c.click(216, 'handin', npc);
    await c.kill(267, 1, .31); assert.equal(await c.amount(3128), 0);
    await c.kill(268, 31, .30); assert.equal(await c.amount(3128), 30);
    await c.click(216, 'handin', 7210);
    if (artisan) {
        const npc = H.spawn(c.state(216), 79, [0, 0, 0]);
        await Service.onSkillSee(c.session, npc, c.session.actor.skillset.fetchSkill(254));
        assert.equal(await c.amount(3136), 0, 'Artisans obtain beads by hunting/crafting');
        H.clearSpawns(c.state(216), 79);
        await c.kill(79, 14, .31); assert.equal(await c.amount(3137), 14);
        await learn(c, 3025, 316); await c.reopen(); await realActor(c);
        await craft(c, 316, 14); assert.equal(await c.amount(3137), 0);
    } else {
        const Spoil = invoke('GameServer/Npc/SpoilSweep'), actor = c.session.actor, skill = actor.skillset.fetchSkill(254);
        // Capture the cast scheduler so we can execute completion deterministically;
        // the real Spoil handler, MP cost, NPC indexing and quest callback run unchanged.
        const timer = actor.attack.queueTimer, regen = actor.automation.replenishVitals;
        let complete;
        actor.attack.queueTimer = fn => { complete = fn; };
        actor.automation.replenishVitals = () => {};
        try {
            for (let i = 0; i < 14; i++) {
                const npc = H.spawn(c.state(216), 79, [0, 0, 0]);
                const previous = await c.amount(3136);
                if (i === 0) {
                    await Service.onSkillSee(c.session, npc, { fetchSelfId: () => 302 });
                    await Service.onSkillSee(c.session, { fetchSelfId: () => 79, fetchId: () => npc.fetchId(), isDead: () => false }, skill);
                    const owner = npc.questSpawn.ownerId; npc.questSpawn.ownerId++;
                    await Service.onSkillSee(c.session, npc, skill); npc.questSpawn.ownerId = owner;
                    actor.setMp(actor.fetchMaxMp()); Spoil.castSpoil(c.session, actor, npc, skill);
                    actor.setMp(0); complete(); await c.session.questMutationTail;
                    assert.equal(await c.amount(3136), previous, 'failed MP cost and unrelated skill/NPC cannot award beads');
                }
                actor.setMp(actor.fetchMaxMp());
                Spoil.castSpoil(c.session, actor, npc, skill);
                assert.equal(await c.amount(3136), previous, 'casting alone awards no beads');
                complete(); await c.session.questMutationTail;
                assert.equal(await c.amount(3136), previous + 5);
                await Service.onSkillSee(c.session, npc, skill);
                await Service.onSkillSee(c.session, npc, skill, {});
                assert.equal(await c.amount(3136), previous + 5, 'duplicate cast and foreign caster award nothing');
                H.clearSpawns(c.state(216), 79);
            }
        } finally { actor.attack.queueTimer = timer; actor.automation.replenishVitals = regen; }
    }
    assert.equal(await c.amount(3136), 70); await c.click(216, 'handin', 7298);
    assert(!(await Database.fetchCharacterRecipes(c.id)).some(r => r.recipeId === 316));
    for (const [npc, n, item] of [[200, 36, 3130], [83, 11, 3131], [202, 10, 3132], [168, 8, 3133]]) {
        await c.kill(npc, n); assert.equal(await c.amount(item), 70);
    }
    await c.reopen(); await c.click(216, 'handin', 7210); assert.equal(c.cond(216), 6);
    for (const [item, n] of [[1880, 7], [1865, 70], [1458, 70]]) await Service.giveItem(c.session, item, n);
    await realActor(c);
    const packet = Buffer.alloc(5); packet.writeInt32LE(315, 1);
    c.session.actor.setMp(0);
    assert.equal(await Make(c.session, packet), false);
    assert.equal(await c.amount(3139), 0); assert.equal(await c.amount(3134), 7);
    await craft(c, 315, 6);
    assert.equal(await c.event(216, 'bribes', 7103), false, 'seven rings are required');
    await craft(c, 315); await c.click(216, weak ? 'virtues' : 'bribes', 7103);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, weak ? 32000 : 80933); assert.equal(after.sp - before.sp, weak ? 3900 : 12250);
    assert.equal(await c.amount(7562) - diamonds, weak ? 0 : 8);
    assert.equal(await c.amount(3119), 1);
    assert(!(await Database.fetchCharacterRecipes(c.id)).some(r => [315, 316].includes(r.recipeId)));
    assert.equal(await c.event(216, 'bribes', 7103), false);
    await c.reopen();
}

async function prosperity(c, { wait = true, reverse = false, stopAtRecipe = false } = {}) {
    const before = await c.world.character(c.id), diamonds = await c.amount(7562);
    await c.level(36); assert.equal(await c.event(221, 'start', 7104), false);
    await c.level(37); await c.click(221, 'start', 7104);
    // Petals can be gathered with the first ring before Bright's list.
    await c.kill(223, 1, .3); assert.equal(await c.amount(3265), 0);
    await c.kill(156, 21); await c.kill(228, 11);
    assert.equal(await c.amount(3265), 20); assert.equal(await c.amount(3266), 10);
    const proofs = async () => {
        for (const npc of [7597, 7005, 7368, 7466, 7466, 7620]) await c.click(221, 'handin', npc);
    };
    if (reverse) await proofs();
    await c.click(221, 'handin', 7531);
    for (const npc of (reverse ? [7536, 7535, 7534, 7533, 7532] : [7532, 7533, 7534, 7535, 7536])) await c.click(221, 'handin', npc);
    for (const npc of [7517, 7519, 7553, 7555, 7554, 7556]) await c.click(221, 'handin', npc);
    assert.equal(await c.event(221, 'handin', 7553), false);
    await Service.giveItem(c.session, 1867, 100); await c.click(221, 'handin', 7553);
    assert.equal(await c.event(221, 'handin', 7534), false);
    await Service.giveItem(c.session, 57, 5000);
    for (const npc of [7532, 7533, 7534, 7535, 7536, 7531]) await c.click(221, 'handin', npc);
    if (!reverse) await proofs();
    if (wait) {
        await c.click(221, 'handin', 7104); assert.equal(c.cond(221), 2);
        await c.click(221, 'handin', 7104); assert.equal(c.cond(221), 2); await c.reopen();
    }
    await c.level(38); await c.click(221, 'handin', 7104);
    await c.kill(157, 1, .2); assert.equal(await c.amount(3273), 0);
    for (const [npc, item] of [[234, 3273], [231, 3274], [233, 3275]]) {
        await c.kill(npc, 21); assert.equal(await c.amount(item), 20);
    }
    for (const npc of [7621, 7622, 7621]) await c.click(221, 'handin', npc);
    await realActor(c, true); await learn(c, 3023, 314);
    if (stopAtRecipe) return;
    const packet = Buffer.alloc(5); packet.writeInt32LE(314, 1);
    assert.equal(await Make(c.session, packet), false, 'missing D-grade crystals prevent crafting');
    await Service.giveItem(c.session, 1458, 10); await craft(c, 314);
    assert.equal(await c.amount(3274), 10); assert.equal(await c.amount(3275), 10);
    await c.reopen(); await realActor(c); await c.click(221, 'handin', 7622);
    assert(!(await Database.fetchCharacterRecipes(c.id)).some(r => r.recipeId === 314));
    assert(!c.session.actor.backpack.fetchRecipeBook(c.session.actor, 'dwarven').some(r => r.recipeId === 314));
    await c.click(221, 'handin', 7104);
    const after = await c.world.character(c.id);
    assert.equal(after.exp - before.exp, 12969); assert.equal(after.sp - before.sp, 1000);
    assert.equal(await c.amount(7562) - diamonds, 16); assert.equal(await c.amount(3238), 1);
    assert.equal(await c.event(221, 'handin', 7104), false);
    await c.reopen();
}
module.exports = { ...shared, createTrialWorld, realActor, learn, craft, guildsman, prosperity };
