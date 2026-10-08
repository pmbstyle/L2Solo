'use strict';

const Commit = require('./EconomyCommit');
const Diagnostics = require('./EconomyDiagnostics');
const MAX_LINES = 12;

// No result history: bounded observations use the admission and returned receipt.
function diagnostic(state, command, phase, reason, fields) {
    if (!Diagnostics.active()) return;
    Diagnostics.count('npc_basket', phase, reason);
    if (!Diagnostics.enabled(state.characterId)) return;
    Diagnostics.push({ ...fields, owner: Number(state.characterId), phase, reason, caller: 'NpcPurchaseBasket',
        commandId: command?.[0], sequence: command?.[2], revision: Number(state.simulation?.revision),
        decisionSeq: Number(state.stats?.decisionSeq), activityLeaf: Number(state.stats?.activityLeaf) });
}
function refusalReason(error) {
    switch (error?.message) {
        case 'economy_funding_changed': case 'economy_funding_missing': case 'economy_owner_changed':
        case 'economy_intent_changed': case 'economy_sequence_changed': case 'economy_operation_in_flight':
        case 'economy_admission_pressure': case 'npc_seller_changed': case 'npc_quote_changed':
        case 'npc_item_template_changed': case 'invalid npc basket': case 'invalid npc purchase':
            return error.message;
        default: return 'native_error';
    }
}
function resultFields(result, seller) {
    return result.replayed ? { actual: 0, spent: 0, receiptUnits: Number(result.units), receiptSpent: Number(result.spent),
        nativeId: Number(result.nativeId) } : { actual: Number(result.units || 0), spent: Number(result.spent || 0),
        npcId: Number(seller.sourceId), town: seller.town };
}

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

async function purchase(state, options = {}) {
    if (!options.seller || !Array.isArray(options.lines) || options.lines.length > MAX_LINES
        || !options.lines.length && !options.original) throw Error('invalid npc basket');
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Goals = invoke('GameServer/Bot/Goals/GoalState'), previousGoal = Goals.snapshot(state.characterId);
    const started = Diagnostics.active() ? performance.now() : 0;
    let admitted, result;
    try {
        admitted = await Commit.admit(state, Commit.KINDS.npcBuy, options.original || null);
        if (Diagnostics.active()) {
            let fields;
            if (!options.original) {
                let units = 0;
                for (const line of options.lines) units += Number(line.amount);
                fields = { requested: units, planned: units, npcId: Number(options.seller.sourceId), town: options.seller.town,
                    wallet: Number(admitted.state.adena) };
            }
            diagnostic(admitted.state, admitted.command, 'npc_admission', options.original ? 'original_command' : 'admitted', fields);
        }
        result = await Database.purchaseNpcInventoryBasket(state.characterId,
            { ...options, coldState: admitted.state, economyCommand: admitted.command });
        if (Diagnostics.active()) diagnostic(admitted.state, admitted.command, 'npc_result',
            result.replayed ? 'saved_receipt' : result.ok ? 'completed' : 'insufficient_adena', resultFields(result, options.seller));
    } catch (error) {
        if (Diagnostics.active()) diagnostic(admitted?.state || state, admitted?.command || options.original,
            'npc_refusal', refusalReason(error), { actual: 0, spent: 0 });
        throw error;
    } finally {
        if (admitted) Commit.finish(state.characterId, admitted.command);
        // This awaits the native queue and transaction; it is latency, not planning CPU.
        if (Diagnostics.active()) Diagnostics.duration('npc_basket', performance.now() - started);
    }
    // A committed physical transaction cannot become a retryable unpaid action
    // because a cache, telemetry or actor delivery failed afterwards.
    let current = admitted.state;
    try {
        if (result.coldLifeRow) current = Commit.acceptRow(result.coldLifeRow);
        if (result.goalRow && Goals.snapshot(state.characterId) === previousGoal) Goals.prime(state.characterId,
            result.goalRow.goalJson, result.goalRow.updatedAt);
        if (Diagnostics.active()) diagnostic(current, admitted.command, 'npc_delivery', 'state_accepted', resultFields(result, options.seller));
    } catch (error) {
        const row = result.coldLifeRow;
        if (row) current = { ...current, phase: row.phase, adena: Number(row.adena),
            inventory: JSON.parse(row.inventorySummary || '{}'), stats: JSON.parse(row.statsJson || '{}'),
            simulation: { ...current.simulation, revision: Number(row.simulationRevision),
                ownerId: row.simulationOwner, leaseId: row.simulationLeaseId || null }, updatedAt: Number(row.updatedAt) };
        if (Diagnostics.active()) diagnostic(current, admitted.command, 'npc_delivery', 'state_deferred', resultFields(result, options.seller));
        utils.infoWarn('BotMarket', 'committed NPC state delivery deferred: %s', error.message);
    }
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
        if (session.actor !== actor || !Life.hotRow(actor.fetchId())) {
            if (Diagnostics.active()) diagnostic(result.state, result.economyCommand, 'npc_delivery', 'actor_changed', resultFields(result, options.seller));
            return result;
        }
        actor.backpack.items = [];
        for (const row of rows) actor.backpack.insertItem(Number(row.id), Number(row.selfId), { ...row });
        session.coldLifeState = { ...result.state, adena: Number(rows.filter(row => Number(row.selfId) === 57)
            .reduce((sum, row) => sum + Number(row.amount), 0)), inventory: Life.inventorySummaryFromItems(rows) };
        result.state = session.coldLifeState;
        invoke('GameServer/World/PartyMembershipPublication')([session], invoke);
        if (Diagnostics.active()) diagnostic(result.state, result.economyCommand, 'npc_delivery', 'actor_accepted', resultFields(result, options.seller));
    } catch (error) {
        if (Diagnostics.active()) diagnostic(result.state, result.economyCommand, 'npc_delivery', 'actor_deferred', resultFields(result, options.seller));
        utils.infoWarn('BotMarket', 'committed NPC actor delivery deferred: %s', error.message);
    }
    return result;
}

module.exports = { MAX_LINES, sellerFor, purchase, purchaseForActor };
