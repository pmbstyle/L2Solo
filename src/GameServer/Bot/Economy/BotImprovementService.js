'use strict';
const Policy = require('./BotImprovementPolicy');
const pendingCold = new Map(), pendingHot = new WeakMap();
function chosen(state, context) {
    const leaf = context.network.activity;
    return leaf?.activity === 'improving' ? { ...leaf.improvement } : null;
}
function inTown(state) {
    const town = invoke('GameServer/World/TownRespawn').getClosestTown(state.loc?.locX || 0, state.loc?.locY || 0, state.loc?.locZ || 0);
    return town.name === state.currentRegion && Math.hypot(state.loc?.locX - town.locX, state.loc?.locY - town.locY) <= 7500;
}
// options.decision: the worker's decision made on exactly this state (L25);
// without it the wish network is built here.
function reviewCold(state, options = {}) {
    if (!state?.characterId || state.phase !== 'cold' || ['dead','traveling'].includes(state.activity)
        || state.simulation?.ownerId && state.simulation.ownerId !== 'legacy_main') return Promise.resolve({state,changed:false});
    if (pendingCold.has(state.characterId)) return pendingCold.get(state.characterId);
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const { decision, ...writeOptions } = options;
    const context = decision
        ? { network: { activity: decision.activity }, riskWeight: decision.riskWeight }
        : invoke('GameServer/Bot/Economy/EconomyContext').forState(state);
    const improvement = chosen(state, context);
    if (!improvement || improvement.kind !== 'enchant' && !inTown(state)) return Promise.resolve({state,changed:false});
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
    }).finally(() => pendingCold.delete(state.characterId));
    pendingCold.set(state.characterId,work); return work;
}
function reviewHot(session, context = null) {
    const actor = session?.actor;
    if (!actor || actor.isDead?.() || !String(session.accountId || '').startsWith('bot_')) return Promise.resolve(null);
    if (pendingHot.has(actor)) return pendingHot.get(actor);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    context ||= Economy.forActor(actor,session);
    const improvement = chosen(context.state,context);
    if (!improvement) return Promise.resolve(null);
    const World = invoke('GameServer/World/World');
    const record = World.registeredActorById(actor.fetchId());
    const current = () => session.actor === actor && World.registeredActorById(actor.fetchId()) === record
        && record?.session === session && record.retired !== true && actor.fetchIsOnline?.() !== false && !actor.isDead?.();
    if (!current()) return Promise.resolve(null);
    // Smiths and symbol makers use the actual town interaction, never a
    // remote synthetic NPC grant. Enchant itself has no NPC requirement.
    if (improvement.kind !== 'enchant') {
        const candidates = World.fetchNpcsInRadius(actor.fetchLocX(),actor.fetchLocY(),300);
        const target = candidates.find(npc => stationMatches(npc, improvement));
        if (!target || !invoke('GameServer/Bot/AI/TownNpcApproach').hasLineOfSight({locX:actor.fetchLocX(),locY:actor.fetchLocY(),locZ:actor.fetchLocZ()}, {locX:target.fetchLocX(),locY:target.fetchLocY(),locZ:target.fetchLocZ()})) return Promise.resolve(null);
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
        invoke('GameServer/Skills/ToggleSkills').syncEquipment(session,actor);
        invoke(path.actor).calculateStats(session,actor);
        backpack.visibleLook = null; backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
        session.dataSendToMe?.(invoke('GameServer/Network/Response').itemsList(backpack.fetchItems()));
        session.dataSendToMe?.(invoke('GameServer/Network/Response').userInfo(actor));
        Economy.forget(actor.fetchId()); return result;
    }).finally(() => pendingHot.delete(actor));
    pendingHot.set(actor,work); return work;
}
function stationMatches(npc, improvement) {
    if (improvement.kind === 'sa') return [7300,7471,7678,7688,7846,7898,8271,8316].includes(npc.fetchSelfId());
    if (improvement.kind === 'crystal_quest') return [7115,7194,7856].includes(npc.fetchSelfId());
    return /symbol maker/i.test(String(npc.fetchTitle?.() || ''));
}
function stationTarget(actor, improvement) {
    const town = invoke('GameServer/World/TownRespawn').getClosestTown(actor.fetchLocX(),actor.fetchLocY(),actor.fetchLocZ());
    const npcs = invoke('GameServer/World/World').fetchNpcsInRadius(town.locX,town.locY,7500).filter(npc => stationMatches(npc,improvement));
    const npc = npcs.sort((a,b) => Math.hypot(actor.fetchLocX()-a.fetchLocX(),actor.fetchLocY()-a.fetchLocY())
        - Math.hypot(actor.fetchLocX()-b.fetchLocX(),actor.fetchLocY()-b.fetchLocY()))[0];
    return npc ? { npcId:npc.fetchId(), npcSelfId:npc.fetchSelfId(), name:npc.fetchName(), town:town.name,
        locX:npc.fetchLocX(),locY:npc.fetchLocY(),locZ:npc.fetchLocZ(),head:npc.fetchHead?.() } : null;
}
module.exports = { reviewCold, reviewHot, chosen, inTown, Policy, stationTarget };
