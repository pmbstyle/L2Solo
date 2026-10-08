'use strict';
const { randomUUID } = require('node:crypto');
const Intent = require('../Bot/Economy/TradeIntent');
const staged = new Map();
const enrolled = new Map(); // Numeric participant reference, never custody/terms.
const queue = new Set();
let pages = 0, draining = false, unsubscribeLife, unsubscribePlayer, unsubscribeBoard;
const db = () => invoke('Database');
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const world = () => invoke('GameServer/World/World');
const afk = () => invoke('GameServer/AfkTrade/AfkTradeService');
const sessionFor = id => world().registeredActorById(Number(id))?.session || null;
function acceptRows(result) {
    for (const row of Object.values(result?.coldLifeRows || {})) life().acceptLifecycleRow(row);
}
async function syncActors(row) {
    for (const id of [row.actorA, row.actorB]) {
        const session = sessionFor(id);
        if (!session) continue;
        session.tradeMeetingPresence = row.state === 'accepted' ? { id: row.id,
            locX: row.locX, locY: row.locY, locZ: row.locZ, present: null } : undefined;
        if (row.state !== 'accepted') session.meetingTravel = undefined;
        await afk().syncOnlineInventory(id, await db().fetchItems(id));
    }
}
function stage(request) {
    const codec = require('./TradeMeetingCodec'), wire = codec.encode(request);
    const encoded = JSON.stringify(wire);
    const count = Math.ceil(Buffer.byteLength(encoded) / 768);
    if (count > 4 || pages + count > 64) throw Error('trade_meeting_backpressure');
    for (const entry of staged.values()) if ([request.actorA, request.actorB].some(id => entry.actors.includes(id))) throw Error('trade_meeting_preparation_busy');
    const id = randomUUID();
    staged.set(id, { request: codec.decode(wire), bytes: Buffer.byteLength(encoded), pages: count, actors: [request.actorA, request.actorB] });
    pages += count;
    return id;
}
function discard(id) { const entry = staged.get(id); if (entry) { pages -= entry.pages; staged.delete(id); } }
async function accept(id) {
    const entry = staged.get(id);
    if (!entry) throw Error('trade_meeting_preparation_missing');
    try {
        // DB persists the original token/sequences, so retry never invents
        // fresh consent after an acknowledgement or ordinary bot commit.
        const result = await db().acceptTradeMeeting(entry.request);
        acceptRows(result);
        const row = result.meeting;
        enrolled.set(row.actorA, row.id); enrolled.set(row.actorB, row.id);
        await syncActors(row).catch(error => utils.infoWarn('AfkTrade', 'meeting inventory presentation: %s', error.message));
        wake(row.actorA); wake(row.actorB);
        return { pending: result.pending, meetingId: row.id, revision: row.revision,
            purchased: false, sold: false, state: life().cachedState(row.actorA) };
    } finally { discard(id); }
}
async function prepareTrade(characterId, store, itemId, amount, options = {}) {
    const record = await db().fetchAfkTradeShop(store.shopId);
    if (!record || record.custodyPolicy !== 1) throw Error('trade_meeting_quote_changed');
    const line = record.lines.find(row => row.selfId === itemId && (!options.lineId || row.id === options.lineId));
    if (!line || !Number.isSafeInteger(amount) || amount <= 0 || amount > line.count
        || options.expectedPrice !== undefined && line.price !== options.expectedPrice
        || options.expectedRevision !== undefined && record.revision !== options.expectedRevision) throw Error('trade_meeting_quote_changed');
    const buyer = record.storeType === 1 ? characterId : record.ownerId, seller = record.storeType === 1 ? record.ownerId : characterId;
    const actors = [buyer, seller].sort((a, b) => a - b), sides = await Promise.all(actors.map(id => db().prepareTradeParticipant(id)));
    if (sides.some(side => side.meetingId)) throw Error('trade_meeting_participant_busy');
    // Preserve the caller's decision authority across asynchronous native reads.
    // Freshly reading a participant must not turn a stale decision into consent.
    const sourceState = options.coldState || life().cachedState(characterId);
    const callerAuthority = options.economyCommand?.authority || (sourceState
        ? require('../Bot/Economy/EconomyCommit').authority(sourceState) : null);
    if (callerAuthority) {
        const own = sides[actors.indexOf(characterId)];
        if (own.phase !== callerAuthority.phase || own.revision !== callerAuthority.revision
            || own.ownerId !== callerAuthority.ownerId || own.leaseId !== callerAuthority.leaseId
            || own.hotAt !== callerAuthority.hotAt) throw Error('trade_meeting_authority_changed');
    }
    const buyerSide = actors.indexOf(buyer), sellerSide = 1 - buyerSide;
    const source = sides[sellerSide].inventory.find(row => row.selfId === itemId && !row.equipped
        && row.enchant === Number(line.enchant || 0) && row.amount >= amount && (!options.objectId || row.id === options.objectId));
    if (!source) throw Error('trade_meeting_stock_changed');
    let certificate = record.storeType === 3 && line.intentJson ? JSON.parse(line.intentJson) : null;
    let needAd;
    const buyerState = life().cachedState(buyer);
    if (buyerState && !certificate) {
        const own = (await db().fetchAfkTradeShops(buyer)).find(ad => ad.kind === 'buy_ad' && ad.lines[0]?.selfId === itemId && ad.lines[0]?.intentJson);
        if (!own) throw Error('trade_meeting_preparation_pending');
        needAd = own;
        const intent = Intent.decode(JSON.parse(own.lines[0].intentJson));
        if (own.lines[0].intentRevision !== sides[buyerSide].revision || intent.amount < amount || intent.price < line.price) throw Error('trade_meeting_preparation_pending');
        certificate = Intent.encode({ ...intent, amount, price: line.price });
    }
    const point = { locX: record.locX, locY: record.locY, locZ: record.locZ };
    const parties = sides.map((side, index) => {
        const actor = actors[index], state = life().cachedState(actor);
        let route;
        if (state) {
            const plan = require('../Bot/Population/ColdTrip').townPlan(state, point);
            if (!plan) throw Error('trade_meeting_route');
            route = { fee: plan.route.fee, scroll: !!plan.scroll, method: plan.method, durationMs: plan.durationMs };
        } else {
            const position = side.position;
            if (!position || Math.hypot(position.locX - point.locX, position.locY - point.locY, position.locZ - point.locZ) > 200) throw Error('trade_meeting_player_at_point');
            route = { fee: 0, scroll: false, method: 'walk', durationMs: 0 };
        }
        return { ...side, route, needRevision: certificate && actor === buyer && record.storeType === 3 ? line.intentRevision : side.revision };
    });
    const request = { token: randomUUID(), actorA: actors[0], actorB: actors[1], seqA: sides[0].sequence, seqB: sides[1].sequence,
        town: record.town, point, parties, lines: [{ payer: buyerSide, itemId: source.id, selfId: itemId,
            enchant: line.enchant || 0, count: amount, price: line.price, needAdId: needAd?.id || 0, needAdRevision: needAd?.revision || 0, adId: record.id, adRevision: record.revision, certificate }] };
    return { preparationId: stage(request), town: record.town, point, amount, price: line.price, total: amount * line.price };
}
async function trade(characterId, store, itemId, amount, options) {
    const prepared = await prepareTrade(characterId, store, itemId, amount, options);
    if (!prepared.preparationId) return prepared;
    const result = await accept(prepared.preparationId);
    return { ...result, state: life().cachedState(characterId) };
}
function presenceChanged(session) {
    const marker = session.tradeMeetingPresence, actor = session.actor;
    if (!marker || !actor) return;
    const present = !actor.isDead() && actor.fetchHp() > 0
        && Math.hypot(actor.fetchLocX() - marker.locX, actor.fetchLocY() - marker.locY, actor.fetchLocZ() - marker.locZ) <= 200;
    const atWaypoint = marker.waypoint ? Math.hypot(actor.fetchLocX() - marker.waypoint.locX,
        actor.fetchLocY() - marker.waypoint.locY, actor.fetchLocZ() - marker.waypoint.locZ) <= 200 : null;
    if (present === marker.present && atWaypoint === marker.atWaypoint) return;
    marker.present = present; marker.atWaypoint = atWaypoint; wake(actor.fetchId());
}
function reset() {
    unsubscribeLife?.(); unsubscribePlayer?.(); unsubscribeBoard?.();
    unsubscribeLife = unsubscribePlayer = unsubscribeBoard = undefined;
    staged.clear(); pages = 0; enrolled.clear(); queue.clear();
}
function wake(id) {
    if (!enrolled.has(Number(id))) return;
    queue.add(Number(id));
    if (!draining) { draining = true; setImmediate(drain); }
}
async function processOwner(id) {
    const row = await db().fetchTradeMeeting(enrolled.get(id));
    if (!enrolled.has(id)) return;
    if (!row) { enrolled.delete(id); return; }
    if (row.state !== 'accepted') {
        await syncActors(row);
        await afk().settleOwners([row.actorA, row.actorB]);
        for (const actor of [row.actorA, row.actorB]) await db().acknowledgeTradeMeeting(row.id, actor);
        enrolled.delete(row.actorA); enrolled.delete(row.actorB);
        return;
    }
    const state = life().cachedState(id), session = sessionFor(id);
    if (state?.activity === 'dead' || state?.vitals?.hp <= 0 || !state && !session) {
        const cancelled = await db().cancelTradeMeeting(row.id, 'unavailable'); acceptRows(cancelled); wake(id); return;
    }
    if (!state && session) {
        const actor = session.actor;
        if (actor.isDead() || Math.hypot(actor.fetchLocX() - row.locX, actor.fetchLocY() - row.locY, actor.fetchLocZ() - row.locZ) > 200) {
            const cancelled = await db().cancelTradeMeeting(row.id, 'player_left'); acceptRows(cancelled); wake(id); return;
        }
    }
    const arrived = await db().arriveTradeMeeting(row.id); acceptRows(arrived);
    if (arrived?.meeting.state !== 'accepted') { await syncActors(arrived.meeting);
        for (const actor of [row.actorA, row.actorB]) for (const ad of await db().fetchAfkTradeShops(actor)) afk().refreshRecord(ad);
        wake(id); return; }
    const side = row.actorA === id ? 0 : 1;
    if (arrived.meeting.arrivalMask & 1 << side) return;
    if (state?.phase === 'cold' && !state.stats?.travel && !['fighting', 'resting'].includes(state.activity)) {
        await continueColdTravel(row, side, state);
    } else if (session && state?.phase === 'hot') {
        await require('../Bot/AI/BotTownTravel').requestMeeting(session, session.actor, row, side);
    }
}
// One physical leg uses the same native destinations as the visible adapter.
// Only the existing participant event queue calls this; no travel polling.
async function continueColdTravel(row, side, state) {
    const suffix = side ? 'B' : 'A', point = { locX: row.locX, locY: row.locY, locZ: row.locZ };
    const saved = JSON.parse(row[`leg${suffix}`] || 'null');
    if (saved) {
        const [kind, ...values] = saved.legId.split(':'), coords = values.map(Number);
        const destination = coords.length === 3 && coords.every(Number.isFinite)
            ? { locX: coords[0], locY: coords[1], locZ: coords[2] } : point;
        const reached = Math.hypot(state.loc.locX - destination.locX,
            state.loc.locY - destination.locY, state.loc.locZ - destination.locZ) <= 200;
        // Interrupted recall has consumed its scroll. Like hot travel, resume
        // on foot, never restart the cast with a consumed physical item.
        if (reached || kind === 'soe') {
            await db().acknowledgeTradeMeetingLeg(row.id, side, saved.sequence);
            row = await db().fetchTradeMeeting(row.id);
        } else {
            const resumed = await db().payTradeMeetingLeg(row.id, side, saved.sequence,
                saved.legId, saved.fee, saved.scroll);
            acceptRows(resumed); return;
        }
    }
    const Routes = require('../Bot/Travel/TravelRoutes');
    const route = JSON.parse(row[`route${suffix}`]), native = Routes.between(state.loc, point);
    if (!native.route) { acceptRows(await db().cancelTradeMeeting(row.id, 'route_unavailable')); wake(state.characterId); return; }
    let kind = 'walk', destination = point, fee = 0, scroll = false;
    if (route.scroll && row[`nextLeg${suffix}`] === 1) {
        kind = 'soe'; destination = native.start; scroll = true;
    } else if (native.route.steps?.length) {
        const step = native.route.steps[0];
        const keeper = world().fetchNpcsInRadius(native.start.locX, native.start.locY, 1200)
            .find(npc => Number(npc.fetchSelfId()) === step.npcId);
        if (!keeper) { acceptRows(await db().cancelTradeMeeting(row.id, 'gatekeeper_unavailable')); wake(state.characterId); return; }
        const gate = { locX: keeper.fetchLocX(), locY: keeper.fetchLocY(), locZ: keeper.fetchLocZ() };
        if (Math.hypot(state.loc.locX - gate.locX, state.loc.locY - gate.locY) <= 200) {
            kind = 'gk'; destination = step; fee = step.fee;
        } else destination = gate;
    }
    // A changed physical route may cost more than the held future fare. Walk
    // to the agreed point instead; spent legs remain spent, custody is intact.
    if (fee > row[`routeReserve${suffix}`]) { kind = 'walk'; destination = point; fee = 0; }
    const legId = `${kind}:${destination.locX}:${destination.locY}:${destination.locZ}`;
    acceptRows(await db().payTradeMeetingLeg(row.id, side, row[`nextLeg${suffix}`], legId, fee, scroll));
}
async function drain() {
    const started = performance.now(); let count = 0;
    try {
        while (queue.size && count++ < 32 && performance.now() - started < 4) {
            const id = queue.values().next().value; queue.delete(id);
            try { await processOwner(id); } catch (error) { utils.infoWarn('AfkTrade', 'meeting owner %d: %s', id, error.message); }
        }
    } finally { draining = false; if (queue.size) { draining = true; setImmediate(drain); } }
}
async function init() {
    unsubscribeLife?.(); unsubscribePlayer?.(); unsubscribeBoard?.(); enrolled.clear(); queue.clear();
    unsubscribeLife = life().subscribeChanges(change => {
        const id = Number(typeof change === 'number' ? change : change.characterId);
        // Only bounded unaccepted preparations are replaceable. The durable
        // accepted meeting survives ordinary economic revisions and ad edits.
        for (const [key, entry] of staged) if (entry.actors.includes(id)) {
            const side = entry.actors.indexOf(id), state = life().cachedState(id);
            const party = entry.request.parties[side];
            if (!state || require('../Bot/Economy/EconomyCommit').authority(state).revision !== party.revision) discard(key);
        }
        wake(id);
    });
    unsubscribeBoard = afk().subscribeBoardChanges(change => {
        const owners = new Set((change.ownerIds || []).map(Number));
        for (const [key, entry] of staged) if (change.reset || entry.actors.some(id => owners.has(id))) discard(key);
    });
    unsubscribePlayer = world().subscribeUserChanges(id => {
        if (!sessionFor(id)) for (const [key, entry] of staged) if (entry.actors.includes(Number(id))) discard(key);
        wake(id);
    });
    let cursor = 0;
    for (;;) {
        const rows = await db().recoverTradeMeetings(cursor);
        if (!rows.length) break;
        for (const row of rows) { enrolled.set(row.actorA, row.id); enrolled.set(row.actorB, row.id); wake(row.actorA); wake(row.actorB); }
        cursor = rows.at(-1).id;
        await new Promise(resolve => setImmediate(resolve));
    }
}
module.exports = { stage, discard, accept, prepareTrade, trade, wake, init, reset, presenceChanged,
    counters: () => ({ preparations: staged.size, pages, bytes: [...staged.values()].reduce((total, row) => total + row.bytes, 0), queued: queue.size, participants: enrolled.size }) };
