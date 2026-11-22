'use strict';

const crystals = require('../../../../data/Items/soul_crystals.json');
const SA = require('../../Items/C4WeaponSAExchange');
const items = require('../../Item/ItemTemplateIndex');
const starter = { red: 4629, green: 4640, blue: 4651 };
const broken = new Set([4662, 4663, 4664]);
const recipes = new Map();
const byWeapon = new Map();
for (const recipe of SA.recipes) {
    if (recipe.operation !== 'install' || recipe.station !== 'blacksmith') continue;
    const crystalId = SA.costs(recipe).find(cost => crystals.crystals[cost.selfId])?.selfId;
    const crystal = crystals.crystals[crystalId];
    if (!crystal || crystal.stage < 5 || crystal.stage > 10) continue;
    const entry = { ...recipe, crystalId, crystal, costs: SA.costs(recipe) };
    recipes.set(entry.id, entry);
    if (!byWeapon.has(entry.sourceId)) byWeapon.set(entry.sourceId, []);
    byWeapon.get(entry.sourceId).push(entry);
}

function weaponOf(state, goal) {
    const recipe = recipes.get(goal?.[1]);
    if (!recipe) return null;
    const weapon = state.inventory?.[recipe.sourceId]?.instances?.find(row => row.id === goal[0] && row.equipped);
    return weapon && { ...weapon, selfId: recipe.sourceId };
}

function ownedCrystal(state) {
    let held = null;
    for (const row of Object.values(state.inventory || {})) {
        if (!(row.amount > 0) || !crystals.crystals[row.selfId] && !broken.has(row.selfId)) continue;
        if (held || row.amount !== 1) return false;
        held = row;
    }
    return held;
}

function replacing(plan, slot) {
    return ['active', 'deferred', 'component_ready', 'ready_to_craft'].includes(plan?.status)
        && Number(plan.target?.slot) === Number(slot);
}

function choose(state, held) {
    const data = invoke('GameServer/DataCache');
    let evaluate, best = null;
    for (const row of Object.values(state.inventory || {})) {
        const choices = byWeapon.get(row.selfId);
        if (!choices || !row.equipped) continue;
        const weapon = row.instances?.find(item => item.equipped && item.id > 0);
        const grade = items.find(data.items, row.selfId)?.etc?.rank;
        if (!weapon || !['c', 'b'].includes(grade) || replacing(state.stats?.equipmentPlan, weapon.slot)) continue;
        const metadata = crystals.crystals[held?.selfId];
        for (const recipe of choices) {
            if (metadata && (metadata.color !== recipe.crystal.color || metadata.stage > recipe.crystal.stage)) continue;
            evaluate ||= require('./BotImprovementPolicy').weaponAbilityGain(state);
            const gain = evaluate(weapon, recipe.productId);
            if (!(gain > 0)) continue;
            // Favor a useful ability with fewer expected resets along its path.
            const score = gain / ((.42 / .32) ** (recipe.crystal.stage - (metadata?.stage || 0)));
            if (!best || score > best.score) best = { goal: [weapon.id, recipe.id], score };
        }
    }
    return best?.goal || null;
}

function visitStep(state, { magister, smith }) {
    if (state.level < 40 || !require('../AI/PersonalGearProgression').adventurer(state) || !magister && !smith) return null;
    const held = ownedCrystal(state);
    if (held === false) return null;
    let goal = state.stats?.soulCrystalGoal;
    let weapon = weaponOf(state, goal);
    if (weapon && replacing(state.stats?.equipmentPlan, weapon.slot)) return null;
    if (!weapon) {
        // A new commitment starts with an actual quest visit.
        if (!magister) return null;
        goal = choose(state, held);
        weapon = weaponOf(state, goal);
    }
    if (!weapon) return null;
    const recipe = recipes.get(goal[1]);
    if (smith && held?.selfId === recipe.crystalId && state.stats?.soulCrystalQuest
        && state.stats?.soulCrystalGoal?.[0] === goal[0] && state.stats.soulCrystalGoal[1] === goal[1]) {
        return { kind: 'sa', objectId: weapon.id, itemId: weapon.selfId, from: weapon.enchant || 0,
            recipeId: recipe.id, npcId: 7300, soulCrystalGoal: goal };
    }
    const metadata = crystals.crystals[held?.selfId];
    if (!magister || metadata && metadata.color !== recipe.crystal.color) return null;
    if (metadata && state.stats?.soulCrystalQuest && state.stats.soulCrystalGoal === goal) return null;
    return { kind: 'crystal_quest', starterId: starter[recipe.crystal.color], soulCrystalGoal: goal };
}

function validateStep(state, proposal) {
    const goal = proposal.soulCrystalGoal;
    const recipe = recipes.get(goal?.[1]);
    const weapon = weaponOf(state, goal);
    if (!weapon || replacing(state.stats?.equipmentPlan, weapon.slot)) return false;
    if (proposal.kind === 'crystal_quest') return proposal.starterId === starter[recipe.crystal.color];
    return proposal.kind === 'sa' && state.stats?.soulCrystalQuest && state.stats?.soulCrystalGoal?.[0] === goal[0]
        && state.stats.soulCrystalGoal[1] === goal[1] && proposal.recipeId === recipe.id
        && proposal.objectId === weapon.id && proposal.itemId === weapon.selfId;
}

function allowedStage(goal, selfId) {
    const target = recipes.get(goal?.[1])?.crystal;
    const current = crystals.crystals[selfId];
    return !!target && current?.color === target.color && current.stage < target.stage;
}

function canAdvance(state, goal, selfId) {
    if (!allowedStage(goal, selfId)) return false;
    const weapon = weaponOf(state, goal);
    return !!weapon && !replacing(state.stats?.equipmentPlan, weapon.slot);
}

function canAdvanceActor(actor, goal, selfId, plan) {
    if (!allowedStage(goal, selfId)) return false;
    const weapon = actor.backpack.fetchItemRaw(goal[0]);
    return weapon?.fetchEquipped() && matchesWeapon(goal, weapon.fetchSelfId()) && !replacing(plan, weapon.fetchSlot());
}

const matchesWeapon = (goal, selfId) => recipes.get(goal?.[1])?.sourceId === selfId;

const spotStages = new WeakMap();
function spotStage(spot) {
    let stage = spotStages.get(spot);
    if (stage !== undefined) return stage;
    stage = 0;
    for (const npc of spot.npcEntries || []) {
        const cap = crystals.npcs[npc.selfId]?.maxStage;
        if (cap <= 10 && cap > stage) stage = cap;
    }
    spotStages.set(spot, stage);
    return stage;
}

function spotPreference(state) {
    const stats = state.stats, goal = stats?.soulCrystalGoal;
    if (!goal || !stats.soulCrystalQuest || state.party?.partyId || state.partyId
        || stats.clanPartyObjective?.status === 'open' || stats.equipmentPlan?.status === 'active' && stats.equipmentPlan.next?.spotId
        || stats.huntingRecovery?.levelPenalty > 0) return null;
    const held = ownedCrystal(state);
    if (!held || !canAdvance(state, goal, held.selfId)) return null;
    const stage = crystals.crystals[held.selfId].stage;
    return spot => spotStage(spot) > stage;
}

module.exports = { visitStep, validateStep, allowedStage, canAdvance, canAdvanceActor, matchesWeapon, spotPreference,
    costsFor: step => recipes.get(step.recipeId)?.costs || [] };
