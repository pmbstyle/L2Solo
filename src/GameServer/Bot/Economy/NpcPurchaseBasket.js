'use strict';

const Commit = require('./EconomyCommit');
const MAX_LINES = 12;

function sellerFor(selfId, town, unitPrice) {
    const offer = invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffers(Number(selfId), town)
        .find(row => Number(row.price) === Number(unitPrice));
    return offer ? { town: offer.town, sourceId: Number(offer.sourceId),
        locX: Number(offer.locX), locY: Number(offer.locY), locZ: Number(offer.locZ) } : null;
}

function observe(lines, state, replayed) {
    if (replayed) return;
    const Telemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
    for (const line of lines) {
        try { Telemetry.purchase({ sourceType: 'npc', selfId: line.selfId, price: line.unitPrice }, line.amount,
            { buyerCharacterId: state.characterId, buyerName: state.name, town: state.currentRegion }); }
        catch (error) { utils.infoWarn('BotMarket', 'committed NPC telemetry deferred: %s', error.message); }
    }
}

function acceptResult(state, result, previousGoal) {
    const Goals = invoke('GameServer/Bot/Goals/GoalState');
    let current = state;
    try {
        if (result.coldLifeRow) current = Commit.acceptRow(result.coldLifeRow);
        if (result.goalRow && Goals.snapshot(state.characterId) === previousGoal) Goals.prime(state.characterId,
            result.goalRow.goalJson, result.goalRow.updatedAt);
    } catch (error) {
        const row = result.coldLifeRow;
        if (row) current = { ...current, phase: row.phase, adena: Number(row.adena),
            inventory: JSON.parse(row.inventorySummary || '{}'), stats: JSON.parse(row.statsJson || '{}'),
            simulation: { ...current.simulation, revision: Number(row.simulationRevision),
                ownerId: row.simulationOwner, leaseId: row.simulationLeaseId || null }, updatedAt: Number(row.updatedAt) };
        utils.infoWarn('BotMarket', 'committed NPC state delivery deferred: %s', error.message);
    }
    return current;
}

async function purchase(state, options = {}) {
    if (!options.seller || !Array.isArray(options.lines) || options.lines.length > MAX_LINES
        || !options.lines.length && !options.original) throw Error('invalid npc basket');
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Goals = invoke('GameServer/Bot/Goals/GoalState'), previousGoal = Goals.snapshot(state.characterId);
    const admitted = await Commit.admit(state, Commit.KINDS.npcBuy, options.original || null);
    let result;
    try { result = await Database.purchaseNpcInventoryBasket(state.characterId,
        { ...options, coldState: admitted.state, economyCommand: admitted.command }); }
    finally { Commit.finish(state.characterId, admitted.command); }
    // A committed physical transaction cannot become a retryable unpaid action
    // because a cache, telemetry or actor delivery failed afterwards.
    const current = acceptResult(admitted.state, result, previousGoal);
    const lines = result.lines || [];
    observe(lines, current, result.replayed);
    return { ...result, state: current, purchased: !!result.ok && Number(result.units) > 0,
        lines, economyCommand: admitted.command, hot: !!Life.hotRow(state.characterId) };
}

async function purchaseForActor(actor, options = {}) {
    const session = actor?.session;
    if (!session || session.actor !== actor || !actor.backpack) throw Error('npc_actor_changed');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    let state = options.state || Life.cachedState(actor.fetchId()) || session.coldLifeState;
    if (options.statsPacket) {
        session.coldLifeState = { ...state, stats: { ...state?.stats, ...options.statsPacket } };
        state = await Life.markHot(session, 'npc_purchase_review');
    }
    if (!state || state.phase !== 'hot' || session.actor !== actor) throw Error('npc_actor_changed');
    const result = await purchase(state, options);
    if (!result.ok) return result;
    try {
        const rows = await invoke('Database').fetchItems(actor.fetchId());
        if (session.actor !== actor || !Life.hotRow(actor.fetchId())) return result;
        actor.backpack.items = [];
        for (const row of rows) actor.backpack.insertItem(Number(row.id), Number(row.selfId), { ...row });
        session.coldLifeState = { ...result.state, adena: Number(rows.filter(row => Number(row.selfId) === 57)
            .reduce((sum, row) => sum + Number(row.amount), 0)), inventory: Life.inventorySummaryFromItems(rows) };
        result.state = session.coldLifeState;
        invoke('GameServer/World/PartyMembershipPublication')([session], invoke);
    } catch (error) { utils.infoWarn('BotMarket', 'committed NPC actor delivery deferred: %s', error.message); }
    return result;
}

module.exports = { MAX_LINES, sellerFor, acceptResult, purchase, purchaseForActor };
