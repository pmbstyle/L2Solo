'use strict';
const DiagnosticConfig = require('../Population/PopulationConfig');
const Policy = require('./BotImprovementPolicy');
const DecisionEvents = require('../AI/DecisionEvents');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
// lazy: the town catalogue reads main's NPC data; the worker loads this module too.
const catalog = () => invoke('GameServer/Bot/Economy/TownServiceCatalog');
// The town NPC each improvement kind is done at (the catalogue's improvement roles).
const ROLE_OF = Object.freeze({ sa: 'SMITH', crystal_quest: 'SOUL_CRYSTAL', henna: 'SYMBOL_MAKER' });
const roleOf = kind => ROLE_OF[kind] ? catalog().IMPROVEMENT_ROLES[ROLE_OF[kind]] : null;
const pendingCold = new Map(), pendingHot = new WeakMap();
let improvementDeferred = 0;
const INPUT_REJECTIONS = new Set(['improvement_source_changed', 'improvement_missing_materials', 'improvement_missing_template',
    'invalid_bot_enchant', 'invalid_bot_henna', 'invalid_bot_crystal_quest', 'invalid_bot_luxury_exchange', 'soul_crystal_resonance']);
const rejectedInput = error => INPUT_REJECTIONS.has(error?.message);
function chosen(state, context) {
    const leaf = context.network.activity;
    return leaf?.activity === 'improving' ? { ...leaf.improvement } : null;
}
function inTown(state) {
    const town = invoke('GameServer/World/TownRespawn').getClosestTown(state.loc?.locX || 0, state.loc?.locY || 0, state.loc?.locZ || 0);
    return town.name === state.currentRegion && Math.hypot(state.loc?.locX - town.locX, state.loc?.locY - town.locY) <= 7500;
}
function selfCrystallization(improvement) {
    return improvement?.kind === 'crystallize' && improvement.mode === 'self';
}
function acquisitionTravel(state, leaf, timestamp = Date.now()) {
    if (leaf?.activity !== 'improving' || !['crystallize', 'luxury_exchange'].includes(leaf.improvement?.kind)
        || selfCrystallization(leaf.improvement)
        || !invoke('GameServer/Bot/AI/PersonalGearProgression').allowsCGradeAcquisition(state)
        || state.party?.partyId || state.partyId || state.stats?.pveEncounter || state.stats?.pvpEncounter
        || !['hunting', 'resting', 'party_wait', 'shopping'].includes(state.activity)
        || state.activity === 'shopping' && state.stats?.townVisit && state.stats.townVisit.completed !== true
        || state.currentRegion === 'Giran' && inTown(state)) return null;
    const travel = invoke('GameServer/Bot/Goals/GoalExecutor').beginMarketTravel(
        state.activity === 'shopping' ? { ...state, activity: 'hunting' } : state, {
        type: 'improving', target: { improvement: leaf.improvement },
        plan: { marketTown: 'Giran', expectedBenefit: 'improvement' }
    }, timestamp);
    if (travel && state.stats?.marketReturn) travel.stats.marketReturn = state.stats.marketReturn;
    return travel;
}
// options.decide(): the worker's decision made on exactly this state, or null
// (L25); without one the wish network is built here.
async function reviewCold(state, options = {}) {
    if (!state?.characterId || state.phase !== 'cold' || ['dead','traveling'].includes(state.activity)) return Promise.resolve({state,changed:false});
    if (pendingCold.has(state.characterId)) return pendingCold.get(state.characterId);
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const { decide, ...writeOptions } = options;
    const decision = typeof decide === 'function' ? decide()
        : invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided(state);
    if (!decision) { if (DiagnosticConfig.developerDiagnostics) improvementDeferred++; return { state, changed: false }; }
    const context = decision
        ? { network: { activity: decision.activity }, riskWeight: decision.riskWeight }
        : null;
    const improvement = chosen(state, context);
    if (!improvement || improvement.kind !== 'enchant' && !selfCrystallization(improvement) && !inTown(state)) return Promise.resolve({state,changed:false});
    if (['luxury_exchange', 'crystallize'].includes(improvement.kind)
        && !selfCrystallization(improvement) && state.currentRegion !== 'Giran') return { state, changed: false };
    // A smith's special ability, the soul crystal quest and a henna only in a town where
    // such an NPC stands (C4 spawns, where a near body finds one: stationTarget). An enchant
    // scroll is read from the bag anywhere (C4: no NPC). A town without one refuses the held
    // step for good: counted, goal_failed {impossible} drops it from the next build.
    const role = roleOf(improvement.kind);
    if (role && !catalog().improvementTowns(role).has(String(state.currentRegion))) {
        const raised = await DecisionEvents.rejectOnRow(state, state, 'improvement:no_station');
        return { state: raised || state, changed: false, reason: 'no_station' };
    }
    const original = Life.cachedState(state.characterId);
    const work = invoke('Database').applyBotImprovement(state.characterId, {
        ...improvement, lossHours: improvement.riskHours * context.riskWeight
    }, { ...writeOptions, coldState: state, validate() {
        if (Life.cachedState(state.characterId) !== original || original && original !== state) throw Error('improvement_source_retired');
    } }).then(result => {
        if (!result.coldLifeRow) throw Error('improvement_missing_native_snapshot');
        const current = Life.acceptLifecycleRow(result.coldLifeRow, 'improvement');
        invoke('GameServer/Bot/Economy/EconomyContext').forget(state.characterId);
        return {state:current,changed:true,result};
    }).catch(async error => {
        // These native refusals describe the selected input, never a stale
        // revision, location, MP or uncertain transaction-delivery retry.
        if (!rejectedInput(error)) throw error;
        const current = Life.cachedState(state.characterId) || state;
        if (current.phase !== 'cold') return { state: current, changed: false };
        const raised = await DecisionEvents.rejectOnRow(current, state, `improvement:${error.message}`);
        return { state: raised || current, changed: false, reason: error.message };
    }).finally(() => pendingCold.delete(state.characterId));
    pendingCold.set(state.characterId,work); return work;
}
// The improvement the near body's held decision chose (DecisionEvents.held).
function reviewHot(session) {
    const actor = session?.actor;
    if (!actor || actor.isDead?.() || !String(session.accountId || '').startsWith('bot_')) return Promise.resolve(null);
    if (pendingHot.has(actor)) return pendingHot.get(actor);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const context = DecisionEvents.held(session);
    const improvement = chosen(context.state,context);
    if (!improvement) return Promise.resolve(null);
    const World = invoke('GameServer/World/World');
    const record = World.registeredActorById(actor.fetchId());
    const current = () => session.actor === actor && World.registeredActorById(actor.fetchId()) === record
        && record?.session === session && record.retired !== true && actor.fetchIsOnline?.() !== false && !actor.isDead?.();
    if (!current()) return Promise.resolve(null);
    const packet = context.statsPacket || context.state?.stats || {};
    const accepted = { characterId: Number(actor.fetchId()), stats: { decisionSeq: packet.decisionSeq,
        activityLeaf: packet.activityLeaf, wishFocus: packet.wishFocus, wishSections: packet.wishSections } };
    // Smiths and symbol makers use the actual town interaction, never a
    // remote synthetic NPC grant. Enchant itself has no NPC requirement.
    if (improvement.kind !== 'enchant' && !selfCrystallization(improvement)) {
        const candidates = World.fetchNpcsInRadius(actor.fetchLocX(),actor.fetchLocY(),300);
        const target = candidates.find(npc => stationMatches(npc, improvement));
        if (!target || !Approach.canInteract(Approach.pointOf(actor), Approach.npcTarget(target))) return Promise.resolve(null);
        if (improvement.kind === 'sa') improvement.npcId = target.fetchSelfId();
    }
    const work = invoke('Database').applyBotImprovement(actor.fetchId(),improvement,{beforeWrite() {
        if (!current()) throw Error('improvement_actor_retired');
    }}).then(result => {
        if (!current()) return result;
        const backpack = actor.backpack, before = new Map(backpack.fetchItems().map(item => [item.fetchId(),item]));
        const ids = new Set(result.changedIds || []);
        const after = new Map(result.items.map(item => [item.id,item]));
        for (const [id,item] of before) {
            if (!ids.has(item.fetchSelfId())) continue;
            const row = after.get(id);
            if (!row || row.selfId !== item.fetchSelfId()) {
                backpack.items = backpack.fetchItems().filter(candidate => candidate !== item);
                if (item.fetchEquipped()) backpack.unequipPaperdoll(item.fetchSlot());
                if (row) { backpack.insertItem(row.id,row.selfId,row); if (row.equipped) backpack.equipPaperdoll(row.slot,row.id,row.selfId); }
            } else { item.setAmount(row.amount); item.setEnchantLevel(row.enchant); }
        }
        for (const row of result.items) if (ids.has(row.selfId) && !before.has(row.id)) backpack.insertItem(row.id,row.selfId,row);
        if (result.questStarted) {
            const quest = invoke('GameServer/Quest/QuestService').stateFor(session, invoke('GameServer/Quest/quests/Q350_EnhanceYourWeapon'));
            quest.state = 'started'; quest.variables = {cond:'1'};
        }
        if (result.hennas) { session.hennas = result.hennas; invoke('GameServer/Henna/HennaService').refreshHennaStats(session); }
        if (result.result === 'luxury_exchange') invoke('GameServer/Bot/AI/BotEquipmentUpgrade').applyBestUpgrades(session, { force: true });
        invoke('GameServer/Skills/ToggleSkills').syncEquipment(session,actor);
        invoke(path.actor).calculateStats(session,actor);
        backpack.visibleLook = null; backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
        session.dataSendToMe?.(invoke('GameServer/Network/Response').itemsList(backpack.fetchItems()));
        session.dataSendToMe?.(invoke('GameServer/Network/Response').userInfo(actor));
        Economy.forget(actor.fetchId()); return result;
    }).catch(error => {
        if (current() && rejectedInput(error)) DecisionEvents.rejectSession(session, accepted);
        throw error;
    }).finally(() => pendingHot.delete(actor));
    pendingHot.set(actor,work); return work;
}
function stationMatches(npc, improvement) {
    if (['luxury_exchange', 'crystallize'].includes(improvement.kind)) return Number(npc.fetchSelfId()) === Number(improvement.npcId);
    return catalog().improvementRoles(Number(npc.fetchSelfId()), String(npc.fetchTitle?.() || ''))
        .includes(roleOf(improvement.kind));
}
function stationTarget(actor, improvement) {
    const town = invoke('GameServer/World/TownRespawn').getClosestTown(actor.fetchLocX(),actor.fetchLocY(),actor.fetchLocZ());
    const npcs = invoke('GameServer/World/World').fetchNpcsInRadius(town.locX,town.locY,7500).filter(npc => stationMatches(npc,improvement));
    const npc = npcs.sort((a,b) => Math.hypot(actor.fetchLocX()-a.fetchLocX(),actor.fetchLocY()-a.fetchLocY())
        - Math.hypot(actor.fetchLocX()-b.fetchLocX(),actor.fetchLocY()-b.fetchLocY()))[0];
    return npc ? { npcId:npc.fetchId(), npcSelfId:npc.fetchSelfId(), name:npc.fetchName(), town:town.name,
        locX:npc.fetchLocX(),locY:npc.fetchLocY(),locZ:npc.fetchLocZ(),head:npc.fetchHead?.() } : null;
}
module.exports = { reviewCold, reviewHot, chosen, inTown, selfCrystallization, acquisitionTravel, Policy, stationTarget,
    summary: () => DiagnosticConfig.developerDiagnostics ? ({ improvementDeferred }) : { enabled: false } };
