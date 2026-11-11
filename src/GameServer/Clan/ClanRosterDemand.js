'use strict';
const { createHash } = require('node:crypto');
const Raid = require('./ClanRaidPolicy');
const Capabilities = require('./ClanCandidateCapabilities');
const Rules = require('./ClanRules');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Data = invoke('GameServer/DataCache');
const RecipeItems = require('../Item/ItemTemplateIndex');
const id = member => Number(member?.characterId ?? member?.id);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function memberFingerprint(member = {}) {
    const combat = member.stats?.coldCombat || {};
    const objective = member.stats?.clanPartyObjective;
    return hash([id(member), Number(member.classId ?? member.stats?.classId ?? 0), Number(member.level), Number(member.clanId ?? member.stats?.clanId ?? 0),
        member.phase, member.partyId || member.party?.partyId || null,
        member.activity, member.spotId, !!(member.recruitmentReserved || member.stats?.tradeMeeting),
        !!member.stats?.playerPartyTakeover, member.stats?.clanHuntBackoffs || [],
        objective ? [objective.reason, objective.sourceKind, objective.raidBoss, objective.controlledBy, objective.clanId] : null,
        Object.values(member.inventory || {}).filter(item => item.equipped).map(item => [item.selfId, item.slot, item.enchant || 0,
            item.equippedCount || 1, item.equippedSlots || [], (item.instances || []).filter(row => row.equipped).map(row => [row.slot, row.enchant || 0])]).sort(),
        combat.classId, combat.base || null, combat.henna || null, combat.equipment || null, member.stats?.hennas || [],
        combat.effects || [],
        ['tree', 'unresolved'].includes(combat.skillSource) ? [] : (combat.skills || []).map(skill => [skill.selfId, skill.level, !!skill.passive, skill.power]).sort()]);
}
function ownFingerprint(clan) {
    return hash([clan.id, clan.level, clan.state?.mode, clan.physicalMemberCount ?? clan.members.length,
        clan.members.map(member => [id(member), memberFingerprint(member)]).sort((a, b) => a[0] - b[0])]);
}
function ownJoinFingerprint(clan) {
    // Waiting cleanup legitimately releases the owner's unstarted group and
    // removes its objective. It cannot change membership or learned equipment
    // capability between the selected CAS and the native join.
    return hash([clan.id, clan.level, clan.physicalMemberCount ?? clan.members.length,
        clan.members.map(member => [id(member), memberFingerprint({ ...member,
            partyId: Number(member.stats?.clanPartyObjective?.clanId) === Number(clan.id) ? null : member.partyId,
            party: Number(member.stats?.clanPartyObjective?.clanId) === Number(clan.id) ? null : member.party,
            activity: ['dead', 'respawning'].includes(member.activity) ? member.activity : null,
            stats: { ...member.stats, clanPartyObjective: null } })]).sort((a, b) => a[0] - b[0])]);
}
function ownerSection(clan, requested) {
    if (requested === 'productionGoal') return requested;
    const goal = clan.state?.goal;
    return goal && goal.type !== 'equipment' && goal.status !== 'completed' ? 'productionGoal' : 'goal';
}
function sourceFingerprint(spot) {
    return hash([spot.id, spot.avgLevel, spot.raidBossTemplateId, spot.raidInstanceId || null,
        spot.raidAuthorityRevision || 0, spot.raidWorldAvailable !== false]);
}
function goalFingerprint(goal) {
    return hash(goal ? [goal.goalKey, goal.type, goal.status, goal.controlledBy || null, goal.target,
        goal.plan?.kind, goal.plan?.sourceId, goal.plan?.economicRequirements || null, goal.assignedMemberIds || []] : null);
}
function scanKey(clan, spots, previousGoal, section) {
    return scanKeyForSources(clan, scanSources(spots), previousGoal, section);
}
function scanSources(spots) {
    // Discovery follows the level/class query, not a particular boss life or
    // damage revision. Admission still checks the full sourceFingerprint.
    return hash(spots.map(spot => [spot.id, spot.avgLevel, spot.raidBossTemplateId])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}
function scanKeyForSources(clan, sources, previousGoal, section) {
    // Farming, temporary availability, buffs, gear and levels are reassessed
    // on every pass. They must not keep discovery on its first page. The
    // selected roster retains the complete ownFingerprint and proof rows.
    return hash([clan.id, clan.level, clan.state?.mode, clan.physicalMemberCount ?? clan.members.length,
        clan.members.map(member => [id(member), Number(member.classId ?? member.stats?.classId ?? 0)])
            .sort((left, right) => left[0] - right[0]),
        section, previousGoal?.target?.memberId || null, previousGoal?.target?.itemId || null, sources]);
}
function neededKinds(assessment) {
    const deficits = assessment.deficits || {};
    const kinds = [];
    if (deficits.healing?.healers || deficits.healing?.healingBuffers) kinds.push('healer', 'healingBuffer');
    if (deficits.mainBuffers) kinds.push('mainBuffer');
    if (deficits.tanks || assessment.reason === 'raid_tank_power_low') kinds.push('tank');
    if (['raid_tank_survival', 'raid_tank_body', 'raid_tank_shield'].includes(assessment.reason)) kinds.push('tank');
    if (['raid_healing_mana', 'raid_preparation_mana'].includes(assessment.reason)) kinds.push('healer', 'healingBuffer');
    if (!kinds.length && (deficits.members || deficits.damage || deficits.coreMembers || deficits.power)) kinds.push('damage');
    return kinds;
}
function proofRow(member) {
    return [id(member), Number(member.simulationRevision ?? member.simulation?.revision ?? 0),
        Number(member.classId ?? member.stats?.classId ?? 0), Number(member.level), memberFingerprint(member)];
}
function recipeIds(plan, member, warehouseRows = []) {
    if (!plan?.recipeId) return [];
    const Crafting = require('./ClanCraftingPolicy');
    const used = new Set();
    Crafting.requirements(Crafting.resolveRecipe(plan.recipeId), Crafting.craftStock(member?.inventory, warehouseRows),
        null, 1, plan.craftProviders, plan.componentRecipes, used);
    return [...used];
}
function economicRequirements(plan, options = {}, member, warehouseRows = []) {
    const requirements = [];
    if (plan?.strategy === 'craft') for (const recipeId of recipeIds(plan, member, warehouseRows)) {
        if (Recipes.resolveByRecipeId(recipeId)?.type === 'dwarven' && !(options.allowedRecipeIds || []).includes(recipeId)) requirements.push({ kind: 'craft', recipeId });
    }
    if (plan?.next?.kind === 'spoil' && !options.spoilCapable) requirements.push({ kind: 'spoil',
        itemId: Number(plan.next.itemId), npcId: Number(plan.next.npcId), spotId: String(plan.next.spotId), spotLevel: Number(plan.next.spotLevel) });
    return requirements;
}
function capabilityContext(requirement) {
    return requirement.kind === 'craft' ? { learned: true, recipe: Recipes.resolveByRecipeId(requirement.recipeId) }
        : { itemId: requirement.itemId, reward: RecipeItems.findStrict(Data.npcRewards, requirement.npcId) };
}
function economicCapable(member, requirement) {
    if (requirement.kind === 'spoil' && !require('../Bot/Population/ClanEquipmentPartyPolicy').allowed(member,
        { ...requirement, clanOperation: 'equipment', clanId: 1 })) return false;
    return Capabilities.contextualCapability(member, requirement, capabilityContext(requirement));
}
function economicRequest(requirement) {
    let classIds = Capabilities.classIdsForRequirements([requirement]);
    let minLevel = 1, maxLevel = 100;
    if (requirement.kind === 'craft') {
        const recipe = Recipes.resolveByRecipeId(requirement.recipeId);
        const Craft = invoke('GameServer/Bot/Economy/CraftEligibility');
        classIds = classIds.filter(classId => Craft.canCraft({ classId, level: 80 }, recipe));
        const starts = classIds.map(classId => {
            for (let level = 1; level <= 80; level++) if (Craft.canCraft({ classId, level }, recipe)) return level;
            return 100;
        });
        minLevel = Math.min(100, ...starts);
    } else {
        const npc = RecipeItems.findStrict(Data.npcs, requirement.npcId);
        minLevel = Math.max(1, Number(npc?.template?.level || 1) - require('./ClanSimulationConfig').operationMaxTargetLevelGap);
    }
    return { ...requirement, classIds, minLevel, maxLevel, key: hash(requirement) };
}
// Discovery exposes native routes only to find concrete requirements. Its
// result never grants ownership/readiness and is never assigned or persisted.
function discoveryOptions(options) {
    const recipes = options.economicCraftAllowed === false ? options.craftRecipes || []
        : require('../Knowledge/RecipeCatalog').currentDwarvenScrollRows(Recipes);
    return { ...options, craftRecipes: recipes, allowedRecipeIds: recipes.map(recipe => recipe.recipeId),
        craftProviders: options.craftProviders, spoilCapable: true, spoilProviders: undefined, ignoreExistingPlan: true };
}
function ownedSpoilCapability(clan, member, plan = null) {
    if (!member || member.phase !== 'cold' || member.recruitmentReserved || member.stats?.tradeMeeting || member.stats?.playerPartyTakeover) return false;
    const demand = clan.state?.recruitmentDemand;
    const owner = demand?.ownerSection ? clan.state?.[demand.ownerSection] : null;
    const active = goal => goal?.type === 'equipment' && goal.status !== 'completed' && goal.controlledBy !== 'player';
    const requirements = plan?.economicOwnedRequirements || (demand?.source?.kind === 'economic' && active(owner) && owner?.goalKey === demand.goalKey
        ? demand.requirements : [clan.state?.productionGoal, clan.state?.goal].find(active)?.plan?.economicRequirements);
    return (requirements || []).some(row => row.kind === 'spoil' && (!plan || Number(plan.next?.npcId) === row.npcId
        && Number(plan.next?.itemId) === row.itemId && String(plan.next?.spotId) === row.spotId) && economicCapable(member, row));
}
function conditionalOptions(options, requirements, prospects, knowledge = []) {
    const providers = { ...options.craftProviders }, recipes = new Map((options.craftRecipes || []).map(recipe => [recipe.recipeId, recipe]));
    const known = new Set(knowledge.map(row => `${row[0]}:${row[1]}`));
    for (const requirement of requirements.filter(row => row.kind === 'craft')) {
        const recipe = Recipes.resolveByRecipeId(requirement.recipeId);
        const eligible = prospects.filter(member => economicCapable(member, requirement));
        const crafter = eligible.find(member => known.has(`${id(member)}:${recipe.recipeId}`)) || eligible[0];
        if (!crafter) continue;
        const learned = known.has(`${id(crafter)}:${recipe.recipeId}`);
        providers[recipe.recipeId] = { characterId: id(crafter), known: learned, recipeItemId: recipe.recipeItemId, loc: crafter.loc };
        recipes.set(recipe.recipeId, recipe);
    }
    return { ...options, craftRecipes: [...recipes.values()], allowedRecipeIds: [...recipes.keys()], craftProviders: providers,
        spoilCapable: options.spoilCapable || requirements.some(row => row.kind === 'spoil' && prospects.some(member => economicCapable(member, row))) };
}
function economicSource(plan, requirements, knowledge, member, warehouseRows) {
    const recipes = recipeIds(plan, member, warehouseRows);
    const selected = requirements.filter(row => row.kind === 'craft' ? recipes.includes(row.recipeId)
        : plan.next?.kind === 'spoil' && plan.next.itemId === row.itemId && plan.next.npcId === row.npcId && plan.next.spotId === row.spotId);
    const recipeProviders = recipes.flatMap(recipe => plan.craftProviders?.[recipe]?.characterId
        ? [[Number(plan.craftProviders[recipe].characterId), recipe]] : []);
    return { kind: 'economic', id: plan.next?.spotId || `recipe:${plan.recipeId}`, npcId: Number(plan.next?.npcId || 0),
        requirements: selected, recipes, recipeProviders,
        knowledge: hash(recipeProviders.map(([provider, recipe]) => [provider, recipe,
            plan.craftProviders[recipe].known === true])),
        fingerprint: economicFingerprint(selected, recipes) };
}
function economicFingerprint(requirements, recipes) {
    return hash([recipes.map(recipe => Recipes.resolveByRecipeId(recipe)), requirements.filter(row => row.kind === 'spoil').map(row => {
        const reward = RecipeItems.findStrict(Data.npcRewards, row.npcId);
        const npc = RecipeItems.findStrict(Data.npcs, row.npcId);
        return [row.spotId, row.spotLevel, row.npcId, npc?.template?.level, row.itemId, reward?.spoils || null];
    })]);
}
function economicSourceCurrent(source) {
    return source.fingerprint === economicFingerprint(source.requirements, source.recipes)
        && source.requirements.every(row => row.kind === 'craft' ? !!Recipes.resolveByRecipeId(row.recipeId)
            : (!Number.isFinite(row.spotLevel) || Number(invoke('GameServer/Bot/Population/SpotProfiles').findById(row.spotId)?.avgLevel) === row.spotLevel)
                && require('../Knowledge/SourceCatalog').rewardSelectedAtSpot(invoke('GameServer/Bot/Population/SpotProfiles').findById(row.spotId),
                    RecipeItems.findStrict(Data.npcRewards, row.npcId))
                && Gear.itemDropYield(RecipeItems.findStrict(Data.npcRewards, row.npcId), row.itemId, 'spoil').chance > 0);
}
function economicTeam(clan, plan, requirements, prospects, knowledge, raidTeam = null, member, warehouseRows = []) {
    const own = new Set(clan.members.map(id)), source = economicSource(plan, requirements, knowledge, member, warehouseRows);
    if (raidTeam) source.raid = raidTeam.source;
    const prospectiveIds = source.recipeProviders.map(row => row[0]).filter(value => !own.has(value));
    const spoil = source.requirements.find(row => row.kind === 'spoil');
    if (spoil && !ownAvailable(clan).some(member => economicCapable(member, spoil))) {
        const candidate = prospects.find(member => economicCapable(member, spoil));
        if (!candidate) return null;
        prospectiveIds.push(id(candidate));
    }
    const needed = [...new Set([...(raidTeam?.prospectiveIds || []), ...prospectiveIds])];
    if (!needed.length || needed.length > 9 || needed.length > Rules.memberLimit(clan.level) - Number(clan.physicalMemberCount ?? clan.members.length)) return null;
    const rows = [...(raidTeam?.rows || []).filter(row => !own.has(row[0])), ...prospects.filter(member => needed.includes(id(member))).map(proofRow)];
    return { ...raidTeam, source, economic: true, memberIds: raidTeam?.memberIds || [], prospectiveIds: needed,
        retainedProspects: [...new Set([...needed, ...prospects.filter(value => source.requirements.some(row => economicCapable(value, row))).map(id)])].slice(0, 9),
        rows: [...new Map(rows.map(row => [row[0], row])).values()], ownFingerprint: ownFingerprint(clan), actualReady: false,
        ownJoinFingerprint: ownJoinFingerprint(clan),
        requirements: source.requirements, deficits: { economic: needed.length },
        neededKinds: [...new Set([...(raidTeam?.neededKinds || []), ...source.requirements.map(row => row.kind)])], reason: 'economic_capability_missing' };
}
function ownAvailable(clan) {
    return clan.members.filter(value => value.phase === 'cold' && !value.recruitmentReserved
        && !value.stats?.tradeMeeting && !value.stats?.playerPartyTakeover && (!value.partyId || Number(value.stats?.clanPartyObjective?.clanId) === Number(clan.id)));
}
function retainedEconomicProspects(prospects, requirements = [], raidIds = []) {
    const retained = new Set(raidIds);
    // Keep coverage before alternatives: one capable actor can satisfy several
    // recipes. Rehydrate these IDs next pass; never persist candidate frames.
    for (const requirement of Array.isArray(requirements) ? requirements : []) {
        if ([...retained].some(value => prospects.some(member => id(member) === value && economicCapable(member, requirement)))) continue;
        const candidate = prospects.find(member => economicCapable(member, requirement));
        if (candidate && retained.size < 9) retained.add(id(candidate));
    }
    return [...retained].slice(0, 9);
}

// Both discovery and the strict comparison run in the admitted native worker.
// Only the strict result with a physically possible real team can be selected.
function economicPlan(planner, job, member, spots, warehouseRows, options) {
    const base = { ...options }; delete base.economicMode; delete base.economicRequirements; delete base.recipeKnowledge;
    if (options.economicMode === 'discovery') {
        const plan = planner(member, spots, warehouseRows, discoveryOptions(base));
        return { ...plan, economicRequirements: economicRequirements(plan, base, member, warehouseRows) };
    }
    const requirements = options.economicRequirements || [];
    const conditional = conditionalOptions(base, requirements, job.prospects, options.recipeKnowledge);
    const owned = ownAvailable(job.clan);
    conditional.spoilProviders = require('../Bot/Population/ClanEquipmentPartyPolicy').spoilProvidersFor([...owned, ...job.prospects]);
    conditional.spoilCapable ||= requirements.some(row => row.kind === 'spoil' && owned.some(value => economicCapable(value, row)));
    const plan = planner(member, spots, warehouseRows, conditional);
    const relevant = economicRequirements(plan, base, member, warehouseRows);
    if (!relevant.length) return plan;
    if (relevant.every(row => row.kind === 'spoil' && owned.some(value => economicCapable(value, row))))
        return { ...plan, economicOwnedRequirements: relevant };
    const team = economicTeam(job.clan, plan, relevant, job.prospects, options.recipeKnowledge,
        job.prepared?.teams?.[plan.next?.spotId], member, warehouseRows);
    return team ? { ...plan, economicTeam: team }
        : planner(member, spots, warehouseRows, base);
}

// A raid a full nine can take: its source row with the roster size and the
// estimate. The worker returns only the decoration (raidDecoration); main
// puts it back on its own source row (decoratedRaid).
function decoratedRaid(spot, { raidRosterSize, raidEstimate }) {
    return { ...spot, raidRosterSize, raidEstimate };
}
function raidDecoration({ id, raidRosterSize, raidEstimate }) {
    return { id, raidRosterSize, raidEstimate };
}

// Called in the existing planning worker. RaidPolicy owns every composition,
// gear and power decision; the second assessment enforces physical free slots.
// actualCache: the own roster's assessment per spot id, for one clan, spot list
// and previous goal (the planning job's; prospects do not change it).
function prepare(clan, spots, prospects = [], previousGoal = null, readinessCache = new Map(), actualCache = null, raidOptions = {}) {
    if (clan.members.length > 40) return { raids: [], teams: {}, requests: [], retainedProspects: [] };
    const ownIds = new Set(clan.members.map(id));
    const free = Math.max(0, Rules.memberLimit(clan.level) - Number(clan.physicalMemberCount ?? clan.members.length));
    const pool = [...new Map(prospects.slice(0, 64).filter(member => !Number(member.clanId ?? member.stats?.clanId)
        && ['tank', 'damage', 'healer', 'mainBuffer', 'healingBuffer'].some(kind => Capabilities.contextualCapability(member, kind)))
        .map(member => [id(member), member])).values()];
    const teams = {}, raids = [], requests = new Map();
    const availableClan = { ...clan, members: clan.members.filter(member => !member.recruitmentReserved
        && !member.stats?.tradeMeeting && !member.stats?.playerPartyTakeover) };
    let retained = [], bestSize = -1;
    for (const spot of spots) {
        if (!spot.raidBoss || spot.raidWorldAvailable === false) continue;
        const options = { ...raidOptions, desiredMembers: 9, readinessCache, preferredMemberIds: [...ownIds] };
        let actual = actualCache?.get(spot.id);
        if (!actual) {
            actual = Raid.assessment(availableClan, spot, previousGoal, options);
            actualCache?.set(spot.id, actual);
        }
        if (actual.ready && actual.eligible.length >= 9) {
            raids.push(decoratedRaid(spot, { raidRosterSize: actual.eligible.length, raidEstimate: actual.raidEstimate }));
            teams[spot.id] = { source: { id: spot.id, npcId: Number(spot.raidBossTemplateId), avgLevel: Number(spot.avgLevel),
                raidInstanceId: spot.raidInstanceId || null, fingerprint: sourceFingerprint(spot) }, memberIds: actual.eligible.map(id),
                rows: actual.eligible.map(proofRow), prospectiveIds: [], ownFingerprint: ownFingerprint(clan), actualReady: true,
                deficits: actual.deficits, requirements: actual.requirements, neededKinds: [], reason: 'raid_ready',
                ...(actual.coreMemberIds ? { coreMemberIds: actual.coreMemberIds, unchargedHelperIds: actual.unchargedHelperIds } : {}),
                supplies: actual.raidAssessment?.supplies || [], shotPlans: actual.raidAssessment?.shotPlans || [] };
            continue;
        }
        let future = free ? Raid.assessment({ ...clan, members: [...availableClan.members, ...pool] }, spot, previousGoal, options) : actual;
        const selectedProspects = future.eligible.filter(member => !ownIds.has(id(member))).slice(0, free);
        if (selectedProspects.length || future.eligible.some(member => !ownIds.has(id(member)))) {
            future = Raid.assessment({ ...clan, members: [...availableClan.members, ...selectedProspects] }, spot, previousGoal, options);
        }
        const prospectiveIds = future.eligible.filter(member => !ownIds.has(id(member))).map(id);
        if (future.eligible.length > bestSize) { retained = prospectiveIds; bestSize = future.eligible.length; }
        if (future.ready && future.eligible.length >= 9) {
            raids.push(decoratedRaid(spot, { raidRosterSize: future.eligible.length, raidEstimate: future.raidEstimate }));
            teams[spot.id] = { source: { id: spot.id, npcId: Number(spot.raidBossTemplateId), avgLevel: Number(spot.avgLevel),
                raidInstanceId: spot.raidInstanceId || null, fingerprint: sourceFingerprint(spot) },
                memberIds: future.eligible.map(id), rows: future.eligible.map(proofRow), prospectiveIds,
                ownFingerprint: ownFingerprint(clan), actualReady: actual.ready && actual.eligible.length >= 9,
                deficits: actual.deficits, requirements: actual.requirements, neededKinds: neededKinds(actual),
                reason: actual.ready ? 'raid_ready' : actual.reason,
                ...(future.coreMemberIds ? { coreMemberIds: future.coreMemberIds, unchargedHelperIds: future.unchargedHelperIds } : {}),
                supplies: future.raidAssessment?.supplies || [], shotPlans: future.raidAssessment?.shotPlans || [] };
        }
        if (free > 0) {
            // A prospective nine only exposes a conditional equipment route.
            // Until the clan chooses it and recruits, keep discovering better
            // alternatives for its missing roles within the same finite sweep.
            const kinds = neededKinds(future.ready ? actual : future);
            const kind = kinds.includes('healer') ? 'healing' : kinds.includes('mainBuffer') ? 'mainBuffer' : kinds.includes('tank') ? 'tank' : 'damage';
            const entry = requests.get(kind) || { kind, kinds, minLevel: Infinity, maxLevel: 0 };
            entry.minLevel = Math.min(entry.minLevel, Math.max(1, spot.avgLevel - Raid.MAX_LEVEL_BELOW_BOSS));
            entry.maxLevel = Math.max(entry.maxLevel, spot.avgLevel + Raid.MAX_LEVEL_ABOVE_BOSS);
            requests.set(kind, entry);
        }
    }
    return { raids, teams, retainedProspects: retained.slice(0, 9),
        requests: ['healing', 'mainBuffer', 'tank', 'damage'].flatMap(kind => requests.has(kind) ? [requests.get(kind)] : []) };
}

function buildDemand(clan, goal, team, section) {
    if (team.economic) return { clanId: clan.id, ownerSection: section, goalKey: goal.goalKey,
        generation: hash([clan.id, section, goal.goalKey, team.source, team.rows.map(row => [row[0], row[2], row[3], row[4]])]), source: team.source,
        minLevel: Math.min(...team.rows.map(row => row[3]), ...team.requirements.map(row => economicRequest(row).minLevel)), maxLevel: 100,
        neededKinds: team.neededKinds, classIds: [...new Set([...team.rows.map(row => row[2]),
            ...team.requirements.flatMap(row => economicRequest(row).classIds)])], requirements: team.requirements,
        newMemberIds: team.prospectiveIds, proof: { ownFingerprint: team.ownFingerprint, ownJoinFingerprint: team.ownJoinFingerprint, rows: team.rows }, reason: team.reason, status: 'waiting' };
    const kinds = [...new Set([...team.neededKinds, ...team.rows.filter(row => team.prospectiveIds.includes(row[0]))
        .map(row => Raid.raidRole({ classId: row[2], level: row[3] }) === 'buffer' ? 'mainBuffer' : Raid.raidRole({ classId: row[2], level: row[3] }))])];
    const generation = hash([clan.id, section, goal.goalKey, team.source.fingerprint,
        team.rows.map(row => [row[0], row[2], row[3], row[4]]).sort((a, b) => a[0] - b[0]), team.requirements,
        team.coreMemberIds || null, team.unchargedHelperIds || null]);
    return { clanId: clan.id, ownerSection: section, goalKey: goal.goalKey, generation, desiredMembers: 9,
        source: team.source, minLevel: Math.max(1, team.source.avgLevel - Raid.MAX_LEVEL_BELOW_BOSS),
        maxLevel: team.source.avgLevel + Raid.MAX_LEVEL_ABOVE_BOSS, neededKinds: kinds,
        classIds: Capabilities.classIdsForRequirements(kinds), requirements: team.requirements, deficits: team.deficits,
        newMemberIds: team.prospectiveIds, proof: { ownFingerprint: team.ownFingerprint, rows: team.rows },
        reason: team.reason, status: 'waiting' };
}
function fullRoster(clan, goal, team, section) {
    const demand = buildDemand(clan, goal, team, section);
    return { clanId: clan.id, ownerSection: section, goalKey: goal.goalKey, generation: demand.generation,
        memberIds: team.memberIds, sourceId: team.source.id, npcId: team.source.npcId,
        raidInstanceId: team.source.raidInstanceId, sourceFingerprint: team.source.fingerprint,
        ...(team.coreMemberIds ? { coreMemberIds: team.coreMemberIds, unchargedHelperIds: team.unchargedHelperIds || [] } : {}),
        minPartySize: team.memberIds.length, maxPartySize: team.memberIds.length };
}
function activeDemand(clan) {
    const demand = clan.state?.recruitmentDemand;
    const goal = clan.state?.[demand?.ownerSection];
    return demand && goal && goal.goalKey === demand.goalKey && goal.status !== 'completed'
        && goal.controlledBy !== 'player' ? demand : null;
}
function intakeContext(candidate, clan) {
    if (clan.state?.mode !== 'autonomous') return null;
    const demand = activeDemand(clan);
    if (!demand) {
        const strategy = require('./ClanStrategyPolicy').active(clan);
        const roles = strategy?.objective === 'recruit' && strategy.status === 'active' ? strategy.target.roles || [] : [];
        const capability = roles.some(role => {
            const kind = role === 'buffer' ? 'mainBuffer' : role;
            return !clan.members.some(member => Capabilities.contextualCapability(member, kind, { beneficiaries: clan.members }))
                && Capabilities.contextualCapability(candidate, kind, { beneficiaries: clan.members });
        });
        return { contextualAllowed: Number(clan.physicalMemberCount ?? clan.members.length) < Rules.memberLimit(clan.level),
            targetMemberCount: Rules.memberLimit(clan.level), ...(capability ? { roleNeed: true } : {}) };
    }
    const ownIds = new Set(clan.members.map(id));
    const remaining = [...new Set(demand.newMemberIds)].filter(value => !ownIds.has(value));
    if (!remaining.includes(id(candidate))) {
        // Ordinary growth continues alongside equipment work, keeping room
        // for the specialists already selected by the native task planner.
        return { contextualAllowed: Rules.memberLimit(clan.level)
            - Number(clan.physicalMemberCount ?? clan.members.length) > remaining.length };
    }
    const allowed = candidate.level >= demand.minLevel && candidate.level <= demand.maxLevel
        && (demand.source?.kind === 'economic' ? demand.requirements.some(requirement => economicCapable(candidate, requirement))
            || demand.neededKinds.some(kind => Capabilities.contextualCapability(candidate, kind))
            : demand.neededKinds.some(kind => Capabilities.contextualCapability(candidate, kind)));
    return { contextualAllowed: allowed, roleNeed: allowed, growthNeed: allowed && remaining.length > 0,
        targetMemberCount: Math.min(Rules.memberLimit(clan.level), clan.members.length + remaining.length) };
}

module.exports = { memberFingerprint, ownFingerprint, ownJoinFingerprint, ownerSection, sourceFingerprint, goalFingerprint, scanKey, scanSources, scanKeyForSources, hash, neededKinds, proofRow, activeDemand,
    prepare, decoratedRaid, raidDecoration, buildDemand, fullRoster, intakeContext, recipeIds, economicRequirements, economicRequest, discoveryOptions,
    conditionalOptions, economicTeam, economicCapable, economicSourceCurrent, economicPlan, ownedSpoilCapability, retainedEconomicProspects };
