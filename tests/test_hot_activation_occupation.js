'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Activation = invoke('GameServer/Bot/Population/HotActivation');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Decision = invoke('GameServer/Bot/AI/BotDecisionService');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Manager = invoke('GameServer/Bot/BotManager');
const spot = { id: '15_3', name: 'Chosen field', center: { locX: 91000, locY: 21000, locZ: -3567 } };
let nextId = 77100, spawned;
const SavedStats = require('../src/GameServer/Bot/SavedStats');
function accept(state) {
    return Life.acceptLifecycleRow({ ...state, characterName: state.name, ...state.loc, ...state.vitals,
        ...SavedStats.statsColumns(state.stats), inventorySummary: JSON.stringify(state.inventory || {}),
        simulationRevision: state.simulation?.revision || 0 });
}
function row(id, stats = {}) {
    return { characterId: id, accountName: `bot_continuity_${id}`, name: `Continuity${id}`, level: 50,
        phase: 'cold', activity: 'hunting', adena: 1000, spotId: spot.id, loc: { ...spot.center },
        stats: { classId: 0, decisionSeq: 4, activityLeaf: 81, money: [1000, .001, 0, 0], ...stats },
        inventory: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        simulation: { revision: 1 }, updatedAt: Date.now() };
}
function card(state, leaf) {
    return Decisions.capture({ network: { activity: leaf, decisionSeq: state.stats.decisionSeq,
        activityLeaf: state.stats.activityLeaf, focus: state.stats.wishFocus } }, state);
}
function body(state, advice) {
    const actor = { fetchId: () => state.characterId, fetchLevel: () => 50, fetchClassId: () => 0, fetchRace: () => 0,
        fetchLocX: () => spot.center.locX, fetchLocY: () => spot.center.locY, fetchLocZ: () => spot.center.locZ,
        fetchKarma: () => 0, fetchMaxLoad: () => 1000,
        backpack: { fetchItems: () => [], fetchTotalLoad: () => 0, fetchTotalAdena: () => 1000, fetchItemFromSelfId: () => null } };
    const session = { actor, currentSpot: spot, coldLifeState: state, activationEconomyDecision: advice };
    actor.session = session;
    return session;
}
const status = { available: true, mode: 'hunting', blockers: ['no_targets_nearby'],
    nearby: { attackableNpcs: 0, eligibleAttackableNpcs: 0 }, loc: spot.center };
const originalFence = Coordinator.fenceBot;
invoke('GameServer/Bot/Population/ActivationPlacement').resolve = state => ({ loc: state.loc, spot });
invoke('GameServer/Bot/Population/ColdSimulationOwner').handoffToMain = async () => ({ ok: true, revision: 2 });
Manager.loadAndSpawnBot = async (_account, data) => { spawned = data; return body(data.coldLifeState, data.economyDecision); };
Spots.findById = id => id === spot.id ? spot : id === 'other' ? { ...spot, id, center: { ...spot.center, locX: 180000 } } : null;
Spots.findCurrentSpot = () => spot;
Spots.findBestSpot = () => { throw Error('target_search_must_not_replan'); };
(async () => {
    for (const leaf of [
        { activity: 'shopping', itemId: 1879, amount: 4, town: 'Aden', rootKey: 'power:91:7' },
        { activity: 'crafting', recipeId: 1795, kind: 'craft', rootKey: 'stock:shots' },
        { activity: 'hunting', spotId: spot.id, npcId: 20555 }
    ]) {
        const id = nextId++, initial = accept(row(id));
        // A native write that was pending before the fence wins over the
        // caller's earlier snapshot and decision, including the mind keys.
        Coordinator.fenceBot = async (ownerId) => {
            const current = accept({ ...initial, updatedAt: initial.updatedAt + 1,
                stats: { ...initial.stats, decisionSeq: 5 } });
            Coordinator.economyDecisions.accept(id, card(current, leaf));
            return originalFence.call(Coordinator, ownerId);
        };
        const result = await Activation.activate(initial, 'near_player');
        assert.equal(result.ok, true);
        assert.equal(spawned.coldLifeState.stats.decisionSeq, 5, 'activation uses the fenced state, not its initial snapshot');
        assert.equal(spawned.economyDecision.activity.activity, leaf.activity, 'the accepted occupation crosses the handoff');
        assert.equal(Coordinator.economyDecisions.byId.has(id), false, 'the old owner no longer keeps the card');
        const session = body(spawned.coldLifeState, spawned.economyDecision);
        const held = Events.held(session);
        assert.equal(held.network.activity.activity, leaf.activity, 'the body starts with the selected occupation');
        assert.equal(held.network.activity.spotId ?? null, leaf.spotId ?? null);
        assert.equal(held.network.activity.town, leaf.town);
        assert.equal(Decision.suggest(status, session).action, leaf.activity === 'hunting' ? 'search_locally' : 'continue_occupation');
        assert.equal(session.activationEconomyDecision, null, 'the card has one session owner');
        // A later worker answer is allowed to change the occupation. The
        // activation advice does not pin it forever or override a new answer.
        Events.receive(session, card(spawned.coldLifeState, { activity: 'hunting', spotId: 'other' }),
            { nearSeq: 1, statsPacket: { ...spawned.coldLifeState.stats, decisionSeq: 6 } });
        assert.equal(Decision.suggest(status, session).spot.id, 'other');
    }

    // Explicit player instructions may interrupt the occupation; ordinary
    // visibility never does. A trip begun during fencing stays a cold trip.
    for (const reason of ['near_player', 'remote_invite']) {
        const initial = accept(row(nextId++));
        Coordinator.fenceBot = async id => {
            Coordinator.economyDecisions.accept(id, card(initial, { activity: 'shopping', itemId: 736, amount: 1 }));
            return originalFence.call(Coordinator, id);
        };
        assert.equal((await Activation.activate(initial, reason, { interruptBackgroundActivity: true })).ok, true);
        assert.equal(spawned.economyDecision, null, 'an explicit interruption does not inherit autonomous work');
    }
    const traveling = accept(row(nextId++));
    Coordinator.fenceBot = async id => {
        accept({ ...traveling, activity: 'traveling', updatedAt: traveling.updatedAt + 1 });
        return originalFence.call(Coordinator, id);
    };
    let restored = 0;
    Coordinator.acceptColdState = async state => { restored++; assert.equal(state.activity, 'traveling'); return { ok: true }; };
    spawned = null;
    assert.equal((await Activation.activate(traveling, 'near_player')).reason, 'in_transit');
    assert.equal(spawned, null, 'a cold trip begun during fencing cannot spawn at the old field');
    assert.equal(restored, 1, 'a refused activation gives the fenced bot back to the worker');

    const moved = accept(row(nextId++));
    Coordinator.fenceBot = async id => {
        const current = accept({ ...moved, loc: { ...moved.loc, locX: moved.loc.locX + 500 }, updatedAt: moved.updatedAt + 1 });
        Coordinator.economyDecisions.accept(id, card(current, { activity: 'hunting', spotId: spot.id }));
        return originalFence.call(Coordinator, id);
    };
    assert.equal((await Activation.activate(moved, 'near_player')).ok, true);
    assert.equal(spawned.locX, moved.loc.locX + 500, 'placement follows the fenced physical state too');

    const empty = body(row(nextId++), null);
    assert.equal(Decision.suggest(status, empty).action, 'search_locally', 'waiting for the first worker answer cannot cause a field trip');
    assert.equal(Decision.suggest({ ...status, blockers: ['low_hp'] }, empty).action, 'rest', 'survival still wins');
    assert.equal(Decision.suggest({ ...status, target: { dead: false } }, empty).action, 'attack_target', 'an existing encounter still wins');

    // Exercise the actual fence's asynchronous path: the last pending
    // commit publishes its row and card while flushCharacter is awaited.
    const coordinator = new ColdSimulationCoordinator(), id = nextId++;
    const initial = accept(row(id));
    coordinator.worker = {}; coordinator.ready = true;
    coordinator.post = () => { queueMicrotask(() => coordinator.waiters.get('fence').resolve({})); return 'fence'; };
    coordinator.economyDecisions.accept(id, card(initial, { activity: 'hunting', spotId: 'other' }));
    coordinator.queue.flushCharacter = async () => {
        const current = accept({ ...initial, updatedAt: initial.updatedAt + 1 });
        coordinator.economyDecisions.accept(id, card(current, { activity: 'shopping', itemId: 736, amount: 1, town: 'Aden' }));
    };
    const fenced = await coordinator.fenceBot(id);
    assert.equal(fenced.ok, true);
    assert.equal(fenced.economyDecision.activity.activity, 'shopping', 'a fence carries the last settled decision');
    assert.equal(coordinator.economyDecisions.byId.has(id), false);

    const staleId = nextId++, stale = accept(row(staleId));
    coordinator.ready = false;
    coordinator.economyDecisions.accept(staleId, card(stale, { activity: 'hunting', spotId: 'other' }));
    accept({ ...stale, updatedAt: stale.updatedAt + 1 });
    assert.equal((await coordinator.fenceBot(staleId)).economyDecision, null, 'a stale card never crosses the handoff');
    console.log('PASS hot activation occupation: fenced choice, purchase, craft, hunt, missing/stale card and newer worker answer');
})().catch(error => { console.error(error); process.exitCode = 1; });
