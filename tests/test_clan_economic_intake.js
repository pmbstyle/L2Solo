'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-economic-intake');
require('../src/Global'); isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Goals = invoke('GameServer/Clan/ClanGoalService'), Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Events = invoke('GameServer/Clan/ClanReviewEvents'), Runtime = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const Demand = require('../src/GameServer/Clan/ClanRosterDemand'), Planner = require('../src/GameServer/Clan/ClanEquipmentPlanner');
const Capabilities = require('../src/GameServer/Clan/ClanCandidateCapabilities');
const Crafting = require('../src/GameServer/Clan/ClanCraftingPolicy'), Recipes = invoke('GameServer/Items/C4RecipeItems');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Shops = invoke('GameServer/Bot/Economy/CraftShopService'), Sources = require('../src/GameServer/Items/ItemAcquisitionCatalog');
const Config = invoke('GameServer/Clan/ClanSimulationConfig'), Population = invoke('GameServer/Bot/Population/PopulationConfig');
const base = 846000, crafterId = base + 164, secondCrafter = base + 165, recipe = Recipes.resolveByRecipeId(209);
const stock = Object.fromEntries(recipe.materials.map(row => [row.selfId, { selfId: row.selfId, amount: row.amount }]));
stock[recipe.recipeItemId] = { selfId: recipe.recipeItemId, amount: 1 };
function member(characterId, classId, skills = [], inventory = {}) {
    return { characterId, classId, level: 50, clanId: 0, phase: 'cold', activity: 'hunting', spotId: 'ordinary:economic-fixture', partyId: null,
        simulationRevision: 0, accountName: 'bot_pop_economic', inventory,
        loc: { locX: 83400, locY: 148600, locZ: -3400 }, stats: { generatedCold: true, classId,
            coldCombat: { version: Combat.PROFILE_VERSION, classId, skillSource: 'database', skills: Combat.skillSnapshotsFromRecords(skills) } } };
}
const owns = [member(base, 4, [], stock), member(base + 1, 15), member(base + 2, 17)];
const external = member(crafterId, 57, [{ selfId: 172, level: 6 }], { 57: { selfId: 57, amount: 99999999 } });
const seed = new DatabaseSync(isolated.world);
seed.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
seed.exec("INSERT INTO accounts(username,password) VALUES('bot_pop_economic','fixture')");
for (const m of [...owns, ...Array.from({ length: 64 }, (_, index) => member(base + 100 + index, 57)), external,
    member(secondCrafter, 57, [{ selfId: 172, level: 6 }]), member(base + 200, 57, [{ selfId: 254, level: 1 }, { selfId: 42, level: 1 }])]) {
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES(?,'bot_pop_economic',?,?,0,50,1000,1000,0,0,0,0,83400,148600,-3400)`).run(m.characterId, `Economic${m.characterId}`, m.classId);
    for (const skill of m.stats.coldCombat.skills) seed.prepare('INSERT INTO skills(selfId,name,passive,level,characterId) VALUES(?,?,?,?,?)')
        .run(skill.selfId, skill.name || '', skill.passive ? 1 : 0, skill.level, m.characterId);
    seed.prepare(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,spotId,locX,locY,locZ,hp,maxHp,mp,maxMp,inventorySummary,statsJson,updatedAt)
        VALUES(?,'bot_pop_economic',?,50,'cold','hunting','ordinary:economic-fixture',83400,148600,-3400,1000,1000,1000,1000,?,?,1)`)
        .run(m.characterId, `Economic${m.characterId}`, JSON.stringify(m.inventory), JSON.stringify(m.stats));
    seed.prepare("INSERT INTO bot_personas(characterId,seed,primaryDrive,archetype,traitsJson) VALUES(?,'fixture','power','fighter',?)")
        .run(m.characterId, JSON.stringify({ commitment: 1 }));
}
seed.prepare("INSERT INTO character_recipes(characterId,recipeId,type) VALUES(?,?,'dwarven')").run(crafterId, recipe.recipeId);
seed.prepare("INSERT INTO character_recipes(characterId,recipeId,type) VALUES(?,?,'dwarven')").run(secondCrafter, recipe.recipeId);
seed.close();
const q = (sql, args = []) => DB.execute([sql, args]);
const original = { published: Shops.publishedStationRecipes, publishedIndex: Shops.publishedRecipeIndex, share: Config.maxBotMemberShare,
    reload: invoke('GameServer/Clan/ClanService').reload, buyers: Population.staticBuyersDisabled,
    plan: Runtime.plan, query: Life.clanOperationCandidates };
const calls = [], pages = [], rpc = [], endedJobs = [];
const originalExternalRange = [base + 100, base + 200];
const nativeSend = Runtime.ClanPlanningCoordinator.prototype.send;
const proofCalls = () => Object.fromEntries(['plan', 'prepare_raids', 'end_planning_job']
    .map(type => [type, rpc.filter(value => value === type).length]));
const SourceCatalog = require('../src/GameServer/Knowledge/SourceCatalog');
const excluded = Data.items.filter(row => Number(row.etc?.slot) > 0 && row.selfId !== recipe.productId).map(row => row.selfId);
const runOptions = () => ({ spots: [], occupancy: {}, excludedTargetIds: excluded, planningDeadline: Date.now() + 45000 });
let clanId;
const projection = () => Goals.clanProjectionById(clanId);

function pureCases() {
    const options = { craftRecipes: [], allowedRecipeIds: [], craftProviders: {}, spoilCapable: false };
    const req = [{ kind: 'craft', recipeId: recipe.recipeId }];
    assert.deepEqual(Demand.discoveryOptions({ ...options, economicCraftAllowed: false }).craftRecipes, [], 'native disabled clan-craft gate admits no new provider recipe');
    assert(Demand.economicCapable(external, req[0]));
    assert(!Demand.economicCapable({ ...external, stats: { classId: 57 } }, req[0]), 'class-only real actor cannot prove learned craft');
    assert(Capabilities.contextualCapability({ classId: 57, level: 50, stats: { dwarvenCraftLevel: 2 } }, 'craft', { recipe: { level: 2 } }), 'legacy explicit capability remains');
    const conditional = Demand.conditionalOptions(options, req, [external], []);
    assert.equal(conditional.craftRecipes[0], recipe, 'canonical recipe is not altered for learning');
    assert(Sources.allowsRecipe(recipe));
    const altered = { ...recipe, materials: [...recipe.materials, { selfId: 57, amount: 1 }] };
    assert(!Sources.allowsRecipe(altered), 'origin admission still rejects altered canonical material signatures');
    const learning = Crafting.recipeForProvider(recipe, conditional.craftProviders[recipe.recipeId]);
    assert.equal(learning.materials.find(row => row.selfId === recipe.recipeItemId).amount, 1);
    assert.equal(recipe.materials.some(row => row.selfId === recipe.recipeItemId), false);
    assert.equal(Crafting.recipeForProvider(recipe, { known: true }), recipe);
    const used = Demand.recipeIds({ recipeId: recipe.recipeId, componentRecipes: { 1890: 30, 1888: 31 } }, owns[0]);
    assert.deepEqual(used, [recipe.recipeId], 'owned intermediates need no extra component crafter');
    const nativeOptions = { ...options, excludedTargetIds: excluded, clanShare: 0 };
    const clan = { id: 1, level: 0, members: owns, physicalMemberCount: 3, state: { mode: 'autonomous' } };
    const job = { clan, prospects: [external], prepared: { teams: {} } };
    const discovered = Demand.economicPlan(Planner.planForMember, job, owns[0], [], [], { ...nativeOptions, economicMode: 'discovery' });
    assert.equal(discovered.strategy, 'craft', JSON.stringify(discovered));
    assert.deepEqual(discovered.economicRequirements, req);
    const known = Demand.economicPlan(Planner.planForMember, job, owns[0], [], [],
        { ...nativeOptions, economicMode: 'conditional', economicRequirements: req, recipeKnowledge: [[crafterId, recipe.recipeId]] });
    assert.equal(known.strategy, 'craft'); assert.deepEqual(known.economicTeam.prospectiveIds, [crafterId]);
    assert.equal(known.economicTeam.rows.length, 1); assert(!known.economicTeam.memberIds.length);
    const unknown = Demand.economicPlan(Planner.planForMember, job, owns[0], [], [],
        { ...nativeOptions, economicMode: 'conditional', economicRequirements: req, recipeKnowledge: [] });
    assert.equal(unknown.strategy, 'craft', JSON.stringify(unknown));
    assert(unknown.materials.some(row => row.selfId === recipe.recipeItemId && row.amount === 1), 'native unknown recipe keeps learning scroll requirement');
    const unstocked = { ...owns[0], inventory: {} };
    const foreignFunded = Demand.economicPlan(Planner.planForMember, job, unstocked, [], [],
        { ...nativeOptions, economicMode: 'conditional', economicRequirements: req, recipeKnowledge: [] });
    assert.notEqual(foreignFunded.status, 'ready_to_craft', 'prospective money and inventory are never pooled');
    assert.equal(Demand.economicTeam({ ...clan, physicalMemberCount: 10 }, known, req, [external], []), null);
    const Market = invoke('GameServer/Bot/Economy/MarketOpportunity'), previous = Market.bestOffer;
    try {
        Market.bestOffer = () => ({ selfId: recipe.productId, price: 100, count: 1, sourceType: 'npc', town: 'Giran', available: true });
        // Its wallet covers the outing's survival reserve (the table's shots and potions) and the price.
        const paid = { ...unstocked, adena: 100000, inventory: { 57: { selfId: 57, amount: 100000 } } };
        const cheaper = Demand.economicPlan(Planner.planForMember, job, paid, [], [],
            { ...nativeOptions, economicMode: 'conditional', economicRequirements: req, recipeKnowledge: [] });
        assert.equal(cheaper.strategy, 'market'); assert(!cheaper.economicTeam, 'native alternative wins without recruitment privilege');
    } finally { Market.bestOffer = previous; }
}

function learningReaderCases() {
    const Cold = invoke('GameServer/Bot/Economy/ColdCraftingService');
    const input = { inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId, { selfId: row.selfId, amount: row.amount }])),
        stats: { equipmentPlan: { craftProviders: { [recipe.recipeId]: { known: true } } } } };
    assert(Cold.hasMaterials(input, recipe));
    input.stats.equipmentPlan.craftProviders[recipe.recipeId].known = false;
    assert(!Cold.hasMaterials(input, recipe), 'actual cold unknown recipe needs the shared scroll projection');
    input.inventory[recipe.recipeItemId] = { selfId: recipe.recipeItemId, amount: 1 };
    assert(Cold.hasMaterials(input, recipe), 'one canonical scroll is sufficient');
    delete input.inventory[recipe.recipeItemId]; input.stats.equipmentPlan.craftProviders[recipe.recipeId].workshop = true;
    assert(Cold.hasMaterials(input, recipe), 'physical workshop guard keeps its existing learning protocol');
    assert.equal(Cold.hasMaterials(input, null), true, 'null recipe retains the existing empty native requirements');
}

async function criticCases() {
    // Separate physical actors/clan/stock from the default native consumer cases.
    const base = 848000, owns = [member(base, 4, [], stock), member(base + 1, 15), member(base + 2, 17)];
    calls.length = pages.length = rpc.length = endedJobs.length = 0;
    const frame = 1891, mold = 1877, component = Recipes.resolveByProductId(frame);
    const partialCrafter = base + 462, badSpoiler = base + 500, goodSpoiler = base + 501;
    // This selector's old external fixture rows are unavailable, not deleted.
    await q("UPDATE bot_life_state SET phase='hot' WHERE characterId BETWEEN ? AND ?", originalExternalRange);
    const partialStock = { ...stock }; delete partialStock[frame];
    const frameAmount = recipe.materials.find(row => row.selfId === frame).amount;
    for (const row of component.materials) if (row.selfId !== mold) partialStock[row.selfId] = {
        selfId: row.selfId, amount: row.amount * frameAmount
    };
    for (const candidate of [...owns, ...Array.from({ length: 63 }, (_, i) => member(base + 400 + i, 57,
        i === 62 ? [{ selfId: 172, level: 6 }] : [])), member(badSpoiler, 54, [{ selfId: 254, level: 1 }]),
        member(goodSpoiler, 55, [{ selfId: 254, level: 1 }, { selfId: 42, level: 1 }])]) {
        await q(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES(?,'bot_pop_economic',?,?,0,50,1000,1000,0,0,0,0,83400,148600,-3400)`, [candidate.characterId, `Partial${candidate.characterId}`, candidate.classId]);
        await q(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,spotId,locX,locY,locZ,hp,maxHp,mp,maxMp,inventorySummary,statsJson,updatedAt)
            VALUES(?,'bot_pop_economic',?,50,'cold','hunting','ordinary:partial',83400,148600,-3400,1000,1000,1000,1000,?,?,1)`,
        [candidate.characterId, `Partial${candidate.characterId}`, JSON.stringify(candidate.inventory), JSON.stringify(candidate.stats)]);
        await q("INSERT INTO bot_personas(characterId,seed,primaryDrive,archetype,traitsJson) VALUES(?,'fixture','power','fighter',?)",
            [candidate.characterId, JSON.stringify({ commitment: 1 })]);
    }
    await q('UPDATE bot_life_state SET inventorySummary=? WHERE characterId=?', [JSON.stringify(partialStock), base]);
    await DB.setCharacterRecipe(partialCrafter, recipe.recipeId, 'dwarven');
    const reward = Data.npcRewards.find(row => Gear.isBotEligibleSourceNpcId(row.selfId)
        && Gear.itemDropYield(row, mold, 'spoil').chance > 0
        && Data.npcs.some(npc => npc.selfId === row.selfId && npc.template.level >= 45 && npc.template.level <= 50));
    assert(reward, 'authored usable mold spoil source');
    const npc = Data.npcs.find(row => row.selfId === reward.selfId);
    const spot = { id: `ordinary:partial:${reward.selfId}`, avgLevel: npc.template.level, capacity: 10, density: 10,
        npcEntries: [{ selfId: reward.selfId, count: 10 }], center: owns[0].loc };
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles'), oldProfiles = Profiles.ensure(), oldPublished = Shops.publishedStationRecipes;
    Profiles.cache = [...oldProfiles, spot];
    // One object until the fixture changes, as the owner publishes it
    // (ClanPlanningCoordinator.context compares the recipes by identity).
    const published = { recipes: Object.freeze([component]), ids: new Set([component.recipeId]), stationByRecipeId: new Map() };
    Shops.publishedStationRecipes = () => published;
    try {
        learningReaderCases();
        const created = await DB.createAutonomousClan({ name: 'PartialEconomic', leaderId: base, memberIds: owns.map(row => row.characterId),
            founderQuorum: 3, maxBotMemberShare: 1, stateJson: { goal: { type: 'level', status: 'preparing', goalKey: 'cash-owner', target: { level: 1 } } } });
        assert(created.ok); clanId = created.clanId;
        let clan = await projection();
        const opts = () => ({ spots: [spot], occupancy: {}, excludedTargetIds: excluded, planningDeadline: Date.now() + 45000 });
        const first = await Equipment.planningForClan(clan, null, opts());
        const firstCalls = proofCalls();
        assert.deepEqual(pages.map(row => row.count), [63,1], JSON.stringify({ pages: pages.map(row => [row.classIds,row.count]),
            requirements: first.recruitment.scan.requirements, calls, plans: [...first.plans].map(([id,plan]) => [id,plan]) }));
        assert(!first.selection?.plan?.economicTeam && first.recruitment.continuation);
        assert(first.recruitment.scan.prospects.includes(partialCrafter), 'capable PARTIAL crafter survives incomplete mixed team');
        assert(first.recruitment.scan.prospects.length <= 9 && first.recruitment.scan.economic.exhausted.length);
        assert((await DB.updateAutonomousClanGoal({ clanId, ownerSection: 'productionGoal', goal: null,
            recruitmentScan: first.recruitment.scan, eventType: null })).ok);
        clan = await projection();
        const second = await Equipment.planningForClan(clan, null, opts());
        const totalCalls = proofCalls();
        const secondCalls = Object.fromEntries(Object.entries(totalCalls).map(([type, count]) => [type, count - firstCalls[type]]));
        const team = second.selection?.plan?.economicTeam;
        assert(team && team.prospectiveIds.includes(partialCrafter) && team.prospectiveIds.includes(goodSpoiler),
            JSON.stringify({ selected: second.selection, scan: second.recruitment.scan }));
        assert.equal(pages[2].classIds.includes(54), true, 'continuation skips exhausted craft query');
        assert(second.recruitment.remaining >= 0);
        const available = member(base + 800, 55, [{ selfId: 254, level: 1 }, { selfId: 42, level: 1 }]);
        const mixedProspects = await Life.statesByIds([partialCrafter, goodSpoiler]);
        for (const patch of [{ phase: 'hot' }, { partyId: 'foreign' }, { recruitmentReserved: true }]) {
            const view = { ...clan, physicalMemberCount: 4, members: [...clan.members, { ...available, clanId, ...patch }] };
            const result = Demand.economicPlan(Planner.planForMember, { clan: view, prospects: mixedProspects, prepared: { teams: {} } },
                second.selection.member, [spot], [], { craftRecipes: [component], allowedRecipeIds: [component.recipeId], spoilCapable: false,
                    excludedTargetIds: excluded, economicMode: 'conditional', economicRequirements: team.requirements,
                    recipeKnowledge: [[partialCrafter, recipe.recipeId]], ignoreExistingPlan: true });
            assert(result.economicTeam?.prospectiveIds.includes(goodSpoiler), `native selected route: unavailable own helper ${JSON.stringify(patch)} cannot suppress useful intake`);
            assert(!result.economicOwnedRequirements, 'unavailable own capability never becomes own ready proof');
        }
        const ordinary = Profiles.cache, index = SourceCatalog.sourcesByItem(ordinary);
        const nativeIndex = SourceCatalog.sourcesByItem; let indexCalls = 0;
        SourceCatalog.sourcesByItem = (...args) => { indexCalls++; return nativeIndex(...args); };
        let waiting;
        try { waiting = await Equipment.resolveClan(clan, null, { planning: second, ownerSection: 'productionGoal' }); }
        finally { SourceCatalog.sourcesByItem = nativeIndex; }
        assert(waiting.ok && waiting.joined.accepted === partialCrafter, JSON.stringify({ code: waiting.code, joined: waiting.joined }));
        assert.equal(indexCalls, 0, 'economic native save/join never rebuilds or evicts selected-source view');
        assert.equal(SourceCatalog.sourcesByItem(ordinary), index, 'ordinary planner retains exact index identity across economic CAS/join');
        assert.deepEqual((await projection()).state.productionGoal.assignedMemberIds, []);
        assert.equal(totalCalls.end_planning_job, 2, 'both admitted jobs acknowledged native release');
        assert.deepEqual(endedJobs, [0, 0], 'both native end acknowledgements leave no pending RPC');
        console.log('Economic critic fixes passed: partial63+1 continuation, unavailable owned helper, non-evicting native source CAS/join, shared cold learning');
        console.log('Native RPC by admitted pass:', JSON.stringify([firstCalls, secondCalls]), 'candidate page counts:', pages.map(row => row.count).join(','));
    } finally { Profiles.cache = oldProfiles; Shops.publishedStationRecipes = oldPublished; }
}

async function recipeEvents(clan, demand) {
    Events.syncRecruitment({ ...clan, state: { ...clan.state, productionGoal: { goalKey: demand.goalKey }, recruitmentDemand: demand } });
    await Events.drain();
    await q('BEGIN IMMEDIATE'); await q('DELETE FROM character_recipes WHERE characterId=? AND recipeId=?', [crafterId, recipe.recipeId]);
    assert.deepEqual(await Events.drain(), [], 'recipe changes are quiet before native COMMIT');
    await q('ROLLBACK'); assert.deepEqual(await Events.drain(), [], 'recipe rollback clears pending watch input');
    await q('DELETE FROM character_recipes WHERE characterId=? AND recipeId=?', [crafterId, recipe.recipeId]);
    assert((await Events.drain()).some(row => row.clanId === clanId && row.causes.includes('recruitment_input')));
    await DB.setCharacterRecipe(crafterId, recipe.recipeId, 'dwarven');
    assert((await Events.drain()).some(row => row.clanId === clanId));
    await DB.setCharacterRecipe(crafterId, recipe.recipeId, 'dwarven');
    assert.deepEqual(await Events.drain(), [], 'idempotent recipe replay is quiet');
    await DB.setCharacterRecipe(crafterId, 1, 'dwarven');
    assert.deepEqual(await Events.drain(), [], 'irrelevant learned recipe is quiet');
}

async function sourceCases(clan) {
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    // Offline native World has no spawned NPC actors. Supply one selected
    // profile leaf; NPC, rewards, selected-source index and consumers are real.
    const reward = Data.npcRewards.find(row => Gear.isBotEligibleSourceNpcId(row.selfId) && row.spoils?.some(group => group.items?.length));
    const npc = Data.npcs.find(row => row.selfId === reward.selfId);
    const spot = { id: `ordinary:economic-spoil:${reward.selfId}`, avgLevel: npc.template.level, minLevel: npc.template.level,
        maxLevel: npc.template.level, capacity: 10, npcEntries: [{ selfId: reward.selfId, count: 10 }] };
    const oldProfiles = Profiles.ensure(); Profiles.cache = [...oldProfiles, spot];
    const itemId = reward.spoils.find(group => group.items?.length).items[0].selfId;
    const requirement = { kind: 'spoil', itemId, npcId: reward.selfId, spotId: spot.id };
    const spoiler = member(base + 200, 55, [{ selfId: 254, level: 1 }, { selfId: 42, level: 1 }]); spoiler.level = 80;
    assert(Demand.economicCapable(spoiler, requirement));
    assert(!Demand.economicCapable({ ...spoiler, stats: { ...spoiler.stats, coldCombat: { ...spoiler.stats.coldCombat,
        skills: Combat.skillSnapshotsFromRecords([{ selfId: 254, level: 1 }]) } } }, requirement), 'Spoil without Sweep is not economic proof');
    assert(!Demand.economicCapable(spoiler, { ...requirement, itemId: 99999999 }), 'no useful item yield means no spoiler proof');
    const p = { strategy: 'direct_drop', next: { kind: 'spoil', itemId, npcId: reward.selfId, spotId: spot.id } };
    const team = Demand.economicTeam(clan, p, [requirement], [spoiler], []);
    assert(team && Demand.economicSourceCurrent(team.source));
    const old = reward.spoils; reward.spoils = [];
    assert(!Demand.economicSourceCurrent(team.source), 'changed useful yield invalidates exact canonical source'); reward.spoils = old;
    const blocked = { ...spoiler, stats: { ...spoiler.stats, clanHuntBackoffs: [{ spotId: spot.id, untilStep: 60 }] } };
    assert(!Demand.economicCapable(blocked, requirement), 'native source safety applies to prospective helper');
    Events.watchRecruitment(clan.id, { classIds: [55], minLevel: 1, maxLevel: 100, requirements: [requirement] }); await Events.drain();
    const Policy = require('../src/GameServer/Bot/Population/ClanEquipmentPartyPolicy');
    const physical = await Life.findByCharacterId(clan.members[0].characterId);
    const before = { ...physical, stats: { ...physical.stats, clanId: clan.id } };
    const result = Policy.recordOutcome(before, { debug: { fights: 8, wins: 0, spotId: spot.id }, patch: { deathCount: 3 } },
        { clanId: clan.id, clanOperation: 'equipment', spotId: spot.id }, Date.now());
    assert(result.patch.stats.clanHuntBackoffs.length, 'native outcome creates a source backoff');
    const after = { ...before, stats: { ...before.stats, ...result.patch.stats } };
    const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const coordinator = new ColdSimulationCoordinator();
    coordinator.step = async (name, _id, work) => name === 'clanEvents' ? work() : undefined;
    const proposal = { characterId: before.characterId, token: before.simulation || {}, nextState: after, result: {} };
    await coordinator.prepareProposal(proposal);
    assert.deepEqual(await Events.drain(), [], 'source preparation/rejected cold result has no event');
    assert(await Life.upsertState(after, 'test_native_source_outcome'));
    await coordinator.afterCommit({ proposal, nextState: after });
    assert((await Events.drain()).some(row => row.clanId === clan.id && row.causes.includes('recruitment_input')),
        'accepted useful-source backoff reaches existing native after-commit consumer');
    assert(await Life.upsertState(before, 'test_native_source_restored')); await Events.drain();
    Profiles.cache = oldProfiles;
    assert(!Demand.economicSourceCurrent(team.source), 'unavailable selected native source cannot keep demand current');
}

async function selectedSpoil() {
    let clan = await projection();
    const customer = await Life.findByCharacterId(base);
    const Index = require('../src/GameServer/Item/ItemTemplateIndex');
    const entries = Data.npcRewards.flatMap(reward => {
        const npc = Index.findStrict(Data.npcs, reward.selfId);
        if (!Gear.isBotEligibleSourceNpcId(reward.selfId) || !(npc?.template?.level >= 35 && npc.template.level <= 50)) return [];
        return (reward.spoils || []).flatMap(group => (group.items || []).flatMap(row => {
            const item = Index.findStrict(Data.items, row.selfId);
            return item?.etc?.rank === 'c' && ![7,14].includes(Number(item.etc.slot)) && Gear.suitable(item, customer, Gear.roleFor(customer), 'c')
                && Gear.itemDropYield(reward, row.selfId, 'spoil').chance >= 0.01 ? [{ item, reward, npc }] : [];
        }));
    });
    assert(entries.length, 'native usable C equipment spoil source exists');
    const { item, reward, npc } = entries[0];
    const spot = { id: `ordinary:selected-spoil:${reward.selfId}`, avgLevel: npc.template.level, minLevel: npc.template.level,
        maxLevel: npc.template.level, capacity: 10, density: 10, center: customer.loc,
        npcEntries: [{ selfId: reward.selfId, count: 10 }] };
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles'), previous = Profiles.cache, oldBuyers = Population.staticBuyersDisabled;
    Profiles.cache = [...(previous || []), spot];
    Population.staticBuyersDisabled = true;
    try {
        const opts = { spots: [spot], occupancy: {}, excludedTargetIds: Data.items.filter(row => Number(row.etc?.slot) > 0 && row.selfId !== item.selfId).map(row => row.selfId),
            planningDeadline: Date.now() + 45000 };
        let planned = await Equipment.planningForClan(clan, clan.state.productionGoal, opts);
        if (!planned.selection?.plan?.economicTeam && planned.recruitment.continuation) {
            assert((await DB.updateAutonomousClanGoal({ clanId, goal: clan.state.productionGoal, ownerSection: 'productionGoal',
                recruitmentScan: planned.recruitment.scan, eventType: null })).ok);
            clan = await projection();
            planned = await Equipment.planningForClan(clan, clan.state.productionGoal, { ...opts, planningDeadline: Date.now() + 45000 });
        }
        assert.equal(planned.selection?.plan?.next?.kind, 'spoil', JSON.stringify({ item: item.selfId, plans: [...planned.plans].map(([id,p]) => [id,p.status,p.strategy,p.reason]) }));
        assert(planned.selection.plan.economicTeam?.requirements.some(row => row.kind === 'spoil' && row.itemId === item.selfId));
        const team = planned.selection.plan.economicTeam;
        assert.deepEqual(team.prospectiveIds, [base + 200]);
        // Datapack rows are frozen: race the level on a swapped-in copy, then put the row back.
        const npcAt = Data.npcs.indexOf(npc);
        Data.npcs[npcAt] = { ...npc, template: { ...npc.template, level: npc.template.level + 1 } }; Index.invalidate(Data.npcs);
        assert(!Demand.economicSourceCurrent(team.source), 'canonical source level race invalidates selected spoil proof');
        Data.npcs[npcAt] = npc; Index.invalidate(Data.npcs);
        const waiting = await Equipment.resolveClan(clan, clan.state.productionGoal, { planning: planned, ownerSection: 'productionGoal' });
        assert(waiting.ok && waiting.joined.accepted === base + 200, JSON.stringify({ code: waiting.code, joined: waiting.joined }));
        clan = await projection();
        assert.equal(clan.state.goal.goalKey, 'cash-owner'); assert.deepEqual(clan.state.productionGoal.assignedMemberIds, []);
        const ownPlan = await Equipment.planningForClan(clan, clan.state.productionGoal, { ...opts, planningDeadline: Date.now() + 45000 });
        assert(!ownPlan.selection.plan.economicTeam);
        const assigned = await Equipment.resolveClan(clan, clan.state.productionGoal, { planning: ownPlan, ownerSection: 'productionGoal' });
        assert(assigned.ok && assigned.goal.assignedMemberIds.includes(base + 200));
        const ownSpoiler = await Life.findByCharacterId(base + 200);
        assert.equal(ownSpoiler.stats.clanPartyObjective.itemId, item.selfId);
        assert.equal(ownSpoiler.stats.clanPartyObjective.npcId, reward.selfId);
        assert(!ownSpoiler.stats.clanPartyObjective.fullRoster, 'economic spoil uses existing ordinary task, outside mandatory raid9');
        assert(Demand.ownedSpoilCapability({ ...clan, state: { ...clan.state, recruitmentDemand: null,
            productionGoal: assigned.goal } }, ownSpoiler, ownPlan.selection.plan), 'actual learned Warsmith spoil capability survives demand cleanup in the same selected owner');
        const ready = Demand.economicPlan(Planner.planForMember, { clan, prospects: [], prepared: { teams: {} } },
            planned.selection.member, [spot], [], { craftRecipes: [], allowedRecipeIds: [], spoilCapable: false,
                ignoreExistingPlan: true, excludedTargetIds: opts.excludedTargetIds, economicMode: 'conditional', economicRequirements: team.requirements });
        assert.equal(ready.next?.kind, 'spoil'); assert(ready.economicOwnedRequirements && !ready.economicTeam,
            'strict native replan uses already-owned learned capability without another newcomer or phantom readiness');
    } finally { Profiles.cache = previous; Population.staticBuyersDisabled = oldBuyers; }
}

async function main() {
    DB.init(); await Life.init(); await invoke('GameServer/Bot/Population/BackgroundPartyState').init();
    // One object for the whole run, as the owner publishes it until its
    // catalogue changes (ClanPlanningCoordinator.context compares by identity).
    const published = { recipes: Object.freeze([]), ids: new Set(), stationByRecipeId: new Map() };
    Shops.publishedStationRecipes = () => published;
    // Main-thread options and the worker context must see the same fixture
    // public services, including the component service used by criticCases.
    Shops.publishedRecipeIndex = () => new Map(Shops.publishedStationRecipes().recipes.map(row => [Number(row.recipeId), row]));
    Config.maxBotMemberShare = 1; Population.staticBuyersDisabled = false;
    invoke('GameServer/Clan/ClanService').reload = async () => {};
    Runtime.start();
    Runtime.ClanPlanningCoordinator.prototype.send = function(type, payload) {
        rpc.push(type);
        return nativeSend.call(this, type, payload).then(result => {
            if (type === 'end_planning_job') endedJobs.push(this.pending.size);
            return result;
        });
    };
    Runtime.plan = async payload => { calls.push(payload.options.economicMode || 'base'); return original.plan(payload); };
    Life.clanOperationCandidates = async opts => { const page = await original.query.call(Life, opts); pages.push({ ...opts, count: page.length }); return page; };
    try {
        if (process.argv.includes('--critic-fixes')) { await criticCases(); return; }
        pureCases();
        const created = await DB.createAutonomousClan({ name: 'EconomicIntake', leaderId: base, memberIds: owns.map(row => row.characterId),
            founderQuorum: 3, maxBotMemberShare: 1, stateJson: { goal: { type: 'level', status: 'preparing', goalKey: 'cash-owner', target: { level: 1 } } } });
        assert(created.ok); clanId = created.clanId;
        let clan = await projection();
        const first = await Equipment.planningForClan(clan, null, runOptions());
        assert.equal(pages.length, 1, JSON.stringify({ calls, scan: first.recruitment.scan,
            plans: [...first.plans].map(([id, plan]) => [id, plan]) })); assert.equal(pages[0].count, 64);
        assert(pages[0].classIds.includes(57) && pages[0].classIds.every(classId =>
            invoke('GameServer/Bot/Economy/CraftEligibility').canCraft({ classId, level: 80 }, recipe)), 'query uses native capable craft families before LIMIT');
        assert(first.recruitment.continuation && !first.selection?.plan?.economicTeam, 'first64 wrong learned skills create no demand or phantom readiness');
        assert.equal(first.recruitment.scan.economic.cursor.characterId, base + 163);
        assert((await DB.updateAutonomousClanGoal({ clanId, goal: null, ownerSection: 'productionGoal', recruitmentScan: first.recruitment.scan, eventType: null })).ok);
        clan = await projection();
        const beginCalls = calls.length, beginPages = pages.length;
        const next = await Equipment.planningForClan(clan, null, runOptions());
        assert.equal(pages.length, beginPages + 1); assert.equal(pages.at(-1).count, 3);
        assert.equal(next.selection?.plan?.strategy, 'craft', JSON.stringify(next.selection));
        const team = next.selection.plan.economicTeam;
        assert.deepEqual(team.prospectiveIds, [crafterId]); assert(!team.actualReady);
        assert.deepEqual(calls.slice(beginCalls, beginCalls + 3), ['base', 'discovery', 'conditional'], 'real RPC native comparisons share the admitted job');
        const goal = invoke('GameServer/Clan/ClanEquipmentPolicy').buildGoal(clan, next.selection); goal.assignedMemberIds = [];
        const demand = Demand.buildDemand(clan, goal, team, 'productionGoal');
        const revised = structuredClone(team); revised.rows.forEach(row => row[1]++);
        assert.equal(Demand.buildDemand(clan, goal, revised, 'productionGoal').generation, demand.generation,
            'external SP-only life revision does not create a new recruitment generation');
        const apply = extra => DB.updateAutonomousClanGoal({ clanId, goal, ownerSection: 'productionGoal', expectedUpdatedAt: clan.state.updatedAt,
            recruitmentDemand: demand, recruitmentScan: next.recruitment.scan, rosterProof: { ...demand.proof, source: team.source,
                ownerSection: 'productionGoal', ownerGoal: Demand.goalFingerprint(clan.state.productionGoal) }, ...extra });
        await q('UPDATE characters SET classId=56 WHERE id=?', [crafterId]); assert.equal((await apply()).code, 'recruitment_snapshot_changed');
        await q('UPDATE characters SET classId=57 WHERE id=?', [crafterId]);
        await q('DELETE FROM character_recipes WHERE characterId=? AND recipeId=?', [crafterId, recipe.recipeId]);
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'canonical recipe knowledge fenced before demand CAS');
        await DB.setCharacterRecipe(crafterId, recipe.recipeId, 'dwarven');
        const amount = recipe.materials[0].amount; recipe.materials[0].amount++;
        assert.equal((await apply()).code, 'recruitment_snapshot_changed', 'canonical recipe material revision fenced'); recipe.materials[0].amount = amount;
        assert.equal((await apply({ expectedUpdatedAt: clan.state.updatedAt - 1 })).code, 'ownership_conflict');
        await recipeEvents(clan, demand);
        await q('UPDATE characters SET clanJoinExpiryTime=? WHERE id=?', [Date.now() + 60000, crafterId]);
        const waiting = await Equipment.resolveClan(clan, null, { ownerSection: 'productionGoal', planning: next });
        assert(waiting.ok && waiting.joined.refused.includes(crafterId));
        let current = await projection();
        await q('UPDATE characters SET classId=5 WHERE id=?', [base]);
        const raced = await DB.joinAutonomousClan({ clanId, characterId: crafterId, memberLimit: 10, maxBotMemberShare: 1,
            expectedDemandGeneration: demand.generation, candidateFingerprint: demand.proof.rows[0][4] });
        assert.equal(raced.code, 'recruitment_snapshot_changed', 'canonical owned class race fenced at actual join');
        await q('UPDATE characters SET classId=4 WHERE id=?', [base]);
        assert.equal(current.state.goal.goalKey, 'cash-owner'); assert.deepEqual(current.state.productionGoal.assignedMemberIds, []);
        assert(!(await Life.findByCharacterId(crafterId)).stats.equipmentPlan, 'unjoined provider has no actual assignment');
        assert(Buffer.byteLength(JSON.stringify({ recruitmentDemand: current.state.recruitmentDemand, recruitmentScan: current.state.recruitmentScan,
            economicRequirements: [current.state.goal?.plan?.economicRequirements, current.state.productionGoal?.plan?.economicRequirements] })) <= 2048);
        // A relevant native committed input restarts exhausted/refused discovery;
        // scalar cash/SP noise alone keeps the logical key and generation.
        const noise = structuredClone(clan); noise.state.updatedAt++; noise.members[0].adena = 99; noise.members[0].sp = 99;
        assert.equal(Demand.ownFingerprint(noise), Demand.ownFingerprint(clan));
        const refreshed = await Equipment.planningForClan(current, current.state.productionGoal, runOptions());
        assert.deepEqual(refreshed.selection.plan.economicTeam.prospectiveIds, [secondCrafter], 'refusal uses next bounded retained candidate without rerolling first64');
        const accepted = await Equipment.resolveClan(current, current.state.productionGoal, { ownerSection: 'productionGoal', planning: refreshed });
        assert.equal(accepted.joined.accepted, secondCrafter, JSON.stringify(accepted));
        current = await projection(); assert(current.members.some(row => row.characterId === secondCrafter));
        const actualPlanning = await Equipment.planningForClan(current, current.state.productionGoal, runOptions());
        assert(!actualPlanning.selection.plan.economicTeam, 'actual membership returns to own native provider planning');
        const actual = await Equipment.resolveClan(current, current.state.productionGoal, { ownerSection: 'productionGoal', planning: actualPlanning });
        assert(actual.ok && actual.assignment.ok); assert(!actual.goal.fullRoster, 'economic helper is not a required combat-nine marker');
        let customer = await Life.findByCharacterId(base);
        assert.equal(customer.stats.equipmentPlan.craftProviders[recipe.recipeId].characterId, secondCrafter);
        const Cold = invoke('GameServer/Bot/Economy/ColdCraftingService');
        // Saved discovery stock is not a physical item row. Execution remains
        // native and refuses it until the customer's own real materials exist.
        let traveled = Cold.beginTravel(customer); assert(traveled);
        customer = await Life.upsertState({ ...traveled, loc: traveled.stats.travel.to, activity: 'crafting', stats: { ...traveled.stats, travel: null } }, 'test_craft_arrival');
        const rejected = await Cold.craft(customer, () => 0); assert(!rejected.crafted, 'native physical materials gate remains');
        for (const row of recipe.materials) await DB.setItem(base, { selfId: row.selfId, name: `Input${row.selfId}`, amount: row.amount, stackable: true, slot: 0 });
        customer = await Life.findByCharacterId(base);
        const crafted = await Cold.craft(customer, () => 0); assert(crafted.crafted, `${crafted.reason}: ${crafted.error || ''}`);
        assert.equal((await q('SELECT COUNT(*) AS n FROM items WHERE characterId=? AND selfId=?', [base, recipe.productId]))[0].n, 1);
        await sourceCases(await projection());
        await selectedSpoil();
        Events.stop(); assert.equal(Events.recruitmentCount(), 0);
        console.log('Native planning calls:', JSON.stringify(calls), 'candidate page counts:', pages.map(row => row.count).join(','));
        await criticCases();
        console.log('Clan economic intake checks passed: native discovery/conditional RPC, shared64 continuation, selected CAS/join/own craft, canonical recipe/source and committed watches; all four critic regressions');
    } finally {
        Runtime.plan = original.plan; Life.clanOperationCandidates = original.query; Shops.publishedStationRecipes = original.published;
        Shops.publishedRecipeIndex = original.publishedIndex;
        Config.maxBotMemberShare = original.share; Population.staticBuyersDisabled = original.buyers;
        invoke('GameServer/Clan/ClanService').reload = original.reload;
        Events.stop(); await Runtime.shutdown(); await DB.close();
        Runtime.ClanPlanningCoordinator.prototype.send = nativeSend;
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
