'use strict';
const DiagnosticConfig = require('../Population/PopulationConfig');
const Policy = require('./BotImprovementPolicy');
const BotCrystal = require('./BotSoulCrystal');
const Funding = require('./PurchaseFunding');
const Packet = require('./StatsPacket');
const DecisionEvents = require('../AI/DecisionEvents');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
// lazy: the town catalogue reads main's NPC data; the worker loads this module too.
const catalog = () => invoke('GameServer/Bot/Economy/TownServiceCatalog');
// The town NPC each improvement kind is done at (the catalogue's improvement roles).
const ROLE_OF = Object.freeze({ sa: 'SMITH', crystal_quest: 'SOUL_CRYSTAL', henna: 'SYMBOL_MAKER' });
const roleOf = kind => ROLE_OF[kind] ? catalog().IMPROVEMENT_ROLES[ROLE_OF[kind]] : null;
const pendingCold = new Map(), pendingHot = new WeakMap();
let improvementDeferred = 0, improvementRetired = 0;
const INPUT_REJECTIONS = new Set(['improvement_source_changed', 'improvement_missing_materials', 'improvement_missing_template',
    'invalid_bot_enchant', 'invalid_bot_henna', 'invalid_bot_crystal_quest', 'invalid_bot_luxury_exchange', 'soul_crystal_resonance']);
const rejectedInput = error => INPUT_REJECTIONS.has(error?.message);
// A committed improvement is its held step done: one goal_done:goal raised where the bot
// is, as a purchase that landed, hot and cold: a far row's bits (DecisionEvents.raiseOn),
// a near body's bag at once (raiseDecision), which holds its next run until the answer
// (reviewHot). The leaf check reads an enchant or a conversion done from the bag, but a
// henna or a quest start leaves it nothing to read: held on, the same step ran again on
// the bot's next step and the native writer refused it (the slots full, the dye spent),
// or drew the same symbol twice. Resolves the raised far row's state, null otherwise.
const DONE = 'goal_done:goal';
const stepDone = (characterId, session = null) => session
    ? DecisionEvents.raiseDecision(session, DONE) : DecisionEvents.raiseOn(Number(characterId), DONE);
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

function crystalBasket(state, step, town) {
    if (step.kind !== 'sa') return null;
    const reserved = require('./ItemDisposition').reservedEquipmentAmounts(state);
    for (const cost of BotCrystal.costsFor(step)) {
        const amount = cost.amount - Math.max(0, Number(state.inventory?.[cost.selfId]?.amount || 0) - Number(reserved[cost.selfId] || 0));
        if (amount <= 0) continue;
        // The exact crystal comes from the quest. Only a gemstone is bought here.
        if (![2131, 2132].includes(cost.selfId) || reserved[cost.selfId]) return false;
        const offer = require('./NpcRestockPlan').quoteFor(cost.selfId, town);
        const packet = state.stats?.money;
        if (!offer || !Packet.hasMoney(packet) || amount * offer.price > Funding.budgetFor(packet, state.adena, 0, -Infinity)) return false;
        return { seller: offer, lines: [{ selfId: cost.selfId, amount, unitPrice: offer.price,
            autoEquip: false, funding: { side: Packet.moneyPrice(packet) } }] };
    }
    return null;
}

function crystalRoles(town) {
    return { magister: catalog().improvementTowns(roleOf('crystal_quest')).has(town),
        smith: catalog().improvementTowns(roleOf('sa')).has(town) };
}

const crystalRefusal = error => rejectedInput(error) || [
    'economy_state_changed', 'economy_funding_changed', 'economy_funding_missing',
    'economy_owner_changed', 'economy_intent_changed', 'economy_sequence_changed',
    'economy_admission_pressure', 'economy_operation_in_flight', 'npc_seller_changed', 'npc_quote_changed',
    'npc_actor_changed', 'improvement_actor_retired', 'improvement_hot_source_changed'
].includes(error?.message);

async function reviewColdCrystalVisit(state) {
    if (state.phase !== 'cold' || state.activity !== 'shopping' || state.level < 40
        || state.stats?.townVisit && state.stats.townVisit.completed !== true || !inTown(state)) return state;
    const town = state.currentRegion, roles = crystalRoles(town);
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const visit = state.stats?.townVisit;
    // Restocking can complete the visit on its returned state before the row
    // is saved. A purchase or improvement returns the native row for this visit.
    const completedVisit = current => {
        const saved = current.stats?.townVisit;
        return current.phase === 'cold' && visit?.completed && saved?.town === visit.town
            && saved?.startedAt === visit.startedAt && !saved.completed
            ? { ...current, stats: { ...current.stats, townVisit: visit } } : current;
    };
    try {
        const step = BotCrystal.visitStep(state, roles);
        if (!step) return state;
        const basket = crystalBasket(state, step, town);
        if (basket === false) return state;
        if (basket) {
            const purchase = await require('./NpcPurchaseBasket').purchase(state, basket);
            state = purchase.state || state;
            if (!purchase.ok || purchase.hot || state.phase !== 'cold' || state.currentRegion !== town) return completedVisit(state);
        }
        const result = await invoke('Database').applyBotImprovement(state.characterId, step, { coldState: state });
        const saved = Life.acceptLifecycleRow(result.coldLifeRow, 'soul_crystal_visit');
        invoke('GameServer/Bot/Economy/EconomyContext').forget(state.characterId);
        return completedVisit(saved);
    } catch (error) {
        if (!crystalRefusal(error)) throw error;
        return completedVisit(Life.cachedState(state.characterId) || state);
    }
}

async function reviewHotCrystalVisit(session, current) {
    const actor = session.actor;
    if (!(actor?.fetchLevel?.() >= 40) || session.partyCompanion || session.companionShopping || !current()) return;
    const town = invoke('GameServer/Bot/AI/TownTransitPolicy').townAt(actor);
    if (!town) return;
    const near = invoke('GameServer/World/World').fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), 300);
    const atStation = kind => near.some(npc => stationMatches(npc, { kind })
        && Approach.canInteract(Approach.pointOf(actor), Approach.npcTarget(npc)));
    const roles = { magister: atStation('crystal_quest'), smith: atStation('sa') };
    if (!roles.magister && !roles.smith) return;
    const state = invoke('GameServer/Bot/Economy/EconomyContext').stateForActor(actor, session);
    try {
        const step = BotCrystal.visitStep(state, roles);
        if (!step) return;
        const basket = crystalBasket(state, step, town);
        if (basket === false) return;
        if (basket) {
            const purchase = await require('./NpcPurchaseBasket').purchaseForActor(actor, basket);
            if (!purchase.ok || !purchase.hot || !current()) return;
        }
        await reviewHot(session, { sideStep: step, current });
    } catch (error) {
        if (!crystalRefusal(error)) throw error;
    }
}
// options.decide(): the worker's decision made on exactly this state, or null;
// without one the wish network is built here.
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
        const raised = await DecisionEvents.rejectOnRow(state, state, `improvement:${improvement.kind}:no_station`);
        return { state: raised || state, changed: false, reason: 'no_station' };
    }
    const work = Promise.resolve().then(async () => {
        if (improvement.kind === 'henna') {
            const withdrawal = await invoke('GameServer/Clan/ClanConsumableSupply')
                .forDecision(state, decision.activity, writeOptions.beforeWrite);
            if (withdrawal) state = withdrawal.state;
            const symbol = invoke('GameServer/Henna/HennaRules').symbol(improvement.symbolId);
            if (symbol && Number(state.inventory?.[symbol.dyeSelfId]?.amount || 0) < symbol.dyeAmount) {
                const refreshed = await DecisionEvents.raiseOn(state.characterId, 'goal_failed');
                return { state: refreshed || state, changed: false, reason: 'missing_dye' };
            }
        }
        const original = Life.cachedState(state.characterId);
        const result = await invoke('Database').applyBotImprovement(state.characterId, {
            ...improvement, lossHours: improvement.riskHours * context.riskWeight
        }, { ...writeOptions, coldState: state, validate() {
            if (Life.cachedState(state.characterId) !== original || original && original !== state) throw Error('improvement_source_retired');
        } });
        if (!result.coldLifeRow) throw Error('improvement_missing_native_snapshot');
        const current = Life.acceptLifecycleRow(result.coldLifeRow, 'improvement');
        invoke('GameServer/Bot/Economy/EconomyContext').forget(state.characterId);
        // The step's later writes build on the raised row (its revision and mind).
        return {state:await stepDone(state.characterId) || current,changed:true,result};
    }).catch(async error => {
        const current = Life.cachedState(state.characterId) || state;
        // Another write moved the bot's row between this review and its transaction: the
        // held improvement stands (no failed goal) and the next review takes it on the new
        // row. Counted (developer counters: improvementRetired), not a fault.
        if (error?.message === 'improvement_source_retired') {
            if (DiagnosticConfig.developerDiagnostics) improvementRetired++;
            return { state: current, changed: false, reason: 'source_retired' };
        }
        // These native refusals describe the selected input, never a stale
        // revision, location, MP or uncertain transaction-delivery retry. Counted
        // by the improvement's kind and the reason (DecisionEvents.rejections).
        if (!rejectedInput(error)) throw error;
        if (current.phase !== 'cold') return { state: current, changed: false };
        const raised = await DecisionEvents.rejectOnRow(current, state, `improvement:${improvement.kind}:${error.message}`);
        return { state: raised || current, changed: false, reason: error.message };
    }).finally(() => pendingCold.delete(state.characterId));
    pendingCold.set(state.characterId,work); return work;
}
// The improvement the near body's held decision chose (DecisionEvents.held).
function reviewHot(session, options = {}) {
    const actor = session?.actor;
    if (!actor || actor.isDead?.() || !String(session.accountId || '').startsWith('bot_')) return Promise.resolve(null);
    if (pendingHot.has(actor)) return pendingHot.get(actor);
    // A step done waits for the worker's answer (stepDone): the held card still names it.
    if (!options.sideStep && DecisionEvents.inBag(session, DONE)) return Promise.resolve(null);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const context = DecisionEvents.held(session);
    const improvement = options.sideStep || chosen(context.state,context);
    if (!improvement) return Promise.resolve(null);
    const World = invoke('GameServer/World/World');
    const record = World.registeredActorById(actor.fetchId());
    const current = () => (!options.current || options.current()) && session.actor === actor && World.registeredActorById(actor.fetchId()) === record
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
        // A body gone during the write (cooled, logged off, dead) took its bag along: the
        // committed step still ends once, on the row where the bot is now (raiseOn).
        if (!current()) return options.sideStep ? result : stepDone(actor.fetchId()).then(() => result);
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
        if (options.sideStep) DecisionEvents.replaceStats(session, { ...DecisionEvents.statsFor(session),
            soulCrystalGoal: result.soulCrystalGoal });
        if (result.hennas) { session.hennas = result.hennas; invoke('GameServer/Henna/HennaService').refreshHennaStats(session); }
        if (result.result === 'luxury_exchange') invoke('GameServer/Bot/AI/BotEquipmentUpgrade').applyBestUpgrades(session, { force: true });
        invoke('GameServer/Skills/ToggleSkills').syncEquipment(session,actor);
        invoke(path.actor).calculateStats(session,actor);
        backpack.visibleLook = null; backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
        session.dataSendToMe?.(invoke('GameServer/Network/Response').itemsList(backpack.fetchItems()));
        session.dataSendToMe?.(invoke('GameServer/Network/Response').userInfo(actor));
        Economy.forget(actor.fetchId());
        if (!options.sideStep) stepDone(actor.fetchId(), session);
        return result;
    }).catch(error => {
        if (!options.sideStep && current() && rejectedInput(error)) DecisionEvents.rejectSession(session, accepted, `improvement:${improvement.kind}:${error.message}`);
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
module.exports = { reviewCold, reviewHot, reviewColdCrystalVisit, reviewHotCrystalVisit, chosen, inTown, selfCrystallization, acquisitionTravel, Policy, stationTarget,
    summary: () => DiagnosticConfig.developerDiagnostics ? ({ improvementDeferred, improvementRetired }) : { enabled: false } };
