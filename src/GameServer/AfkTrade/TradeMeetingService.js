'use strict';
const { randomUUID } = require('node:crypto');
const { MAX_COMMITMENTS } = require('./TradeMeeting');
const staged = new Map();
const enrolled = new Map(); // At most eight numeric references per actor; no custody/terms.
function enroll(actor, id) {
    let rows = enrolled.get(actor);
    if (!rows) enrolled.set(actor, rows = new Set());
    rows.add(id);
}
function unenroll(actor, id) {
    const rows = enrolled.get(actor); rows?.delete(id);
    if (!rows?.size) enrolled.delete(actor);
}
const queue = new Set();
let pages = 0, transportPages = 0, transportBytes = 0, draining = false, unsubscribeLife, unsubscribeMarketLife, unsubscribePlayer, unsubscribeBoard;
const coordinator = () => invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const db = () => invoke('Database');
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const world = () => invoke('GameServer/World/World');
const afk = () => invoke('GameServer/AfkTrade/AfkTradeService');
const sessionFor = id => world().registeredActorById(Number(id))?.session || null;
function acceptRows(result) {
    for (const row of Object.values(result?.coldLifeRows || {})) {
        const previous = life().cachedState(row.characterId);
        const state = life().acceptLifecycleRow(row);
        // Native reserve/leg/arrival writes are authoritative publications.
        // Cache adoption alone does not update the worker's lifecycle queue.
        if (state?.phase === 'cold' && (state.simulation?.revision !== previous?.simulation?.revision
            || state.phase !== previous?.phase || state.updatedAt !== previous?.updatedAt)) {
            coordinator()?.notifyState?.(state, { reason: 'trade_meeting_native', critical: true });
        }
    }
}
async function syncActors(row) {
    for (const id of [row.actorA, row.actorB]) {
        const session = sessionFor(id);
        if (!session) continue;
        const anchor = await db().fetchTradeMeetingForOwner?.(id) || (row.state === 'accepted' ? row : null);
        session.tradeMeetingPresence = anchor ? { id: anchor.id,
            locX: anchor.locX, locY: anchor.locY, locZ: anchor.locZ, present: null } : undefined;
        if (!anchor || session.meetingTravel?.id === row.id && row.state !== 'accepted') session.meetingTravel = undefined;
        await afk().syncOnlineInventory(id, await db().fetchItems(id));
        if (!life().cachedState(id) && row.state !== 'accepted') {
            try { require('./PlayerBoardWindow').meetingResult(session, row); }
            catch (error) { utils.infoWarn('AfkTrade', 'meeting status presentation: %s', error.message); }
        }
    }
}
function stage(request) {
    const codec = require('./TradeMeetingCodec'), frames = codec.pages(request);
    const count = frames.length;
    const existing = staged.get(request.token);
    if (existing) {
        if (JSON.stringify(existing.frames) !== JSON.stringify(frames)) throw Error('trade_meeting_consent_changed');
        return request.token;
    }
    if (count > 4 || pages + transportPages + count > 64) throw Error('trade_meeting_backpressure');
    for (const entry of staged.values()) if ([request.actorA, request.actorB].some(id => entry.actors.includes(id))) throw Error('trade_meeting_preparation_busy');
    const id = request.token;
    staged.set(id, { frames, revisions: request.parties.map(party => party.revision),
        bytes: frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0), pages: count, actors: [request.actorA, request.actorB] });
    pages += count;
    return id;
}
// Preparations already hold the bounded participant set; callers use it to
// avoid changing their own consent while bilateral worker checks are pending.
function hasPreparation(characterId) {
    const id = Number(characterId);
    for (const entry of staged.values()) if (entry.actors.includes(id)) return true;
    return false;
}
function discard(id) {
    const entry = staged.get(id);
    if (entry) {
        pages -= entry.pages; staged.delete(id);
        entry.cancelled = true;
        if (entry.ready) coordinator()?.cancelMeetingPreparation?.(id);
    }
}
function adjustTransportPages(delta, byteDelta = 0) {
    const count = transportPages + delta, bytes = transportBytes + byteDelta;
    if (!Number.isSafeInteger(count) || count < 0 || bytes < 0
        || pages + count > 64 || bytes + [...staged.values()].reduce((total, entry) => total + entry.bytes, 0) > 48 * 1024) throw Error('trade_meeting_backpressure');
    transportPages = count; transportBytes = bytes;
}
function validatePrepared(entry, request) {
    if (staged.get(request.token) !== entry || entry.cancelled) throw Error('trade_meeting_preparation_changed');
    for (const proof of entry.proofs || []) {
        if (!proof.approved || !coordinator().meetingPreparationCurrent(proof, request)) throw Error('trade_meeting_authority_changed');
    }
    return true;
}
async function prepareActors(token) {
    const entry = staged.get(token), request = require('./TradeMeetingCodec').fromPages(entry.frames);
    const bots = entry.actors.filter((_, side) => request.parties[side].phase !== 'player');
    if (!bots.length) return;
    if (!coordinator()?.requestMeetingPreparation) throw Error('trade_meeting_preparation_pending');
    const proofs = await Promise.all(bots.map(id => coordinator().requestMeetingPreparation(id, request)));
    if (staged.get(token) !== entry) throw Error('trade_meeting_preparation_changed');
    entry.proofs = proofs;
    validatePrepared(entry, request);
    for (const proof of proofs) {
        const side = entry.actors.indexOf(Number(proof.characterId));
        if (side < 0 || proof.token !== token || proof.sequence !== request.parties[side].sequence) throw Error('trade_meeting_consent_changed');
        request.parties[side].route = proof.route;
        request.lines.forEach((line, index) => {
            if (line.payer === side) {
                const certificate = proof.certificates?.[index];
                if (!certificate) throw Error('trade_meeting_need_changed');
                line.certificate = certificate;
            }
        });
    }
    delete request.incoming; // Only the two active graph preparations needed the expanded native projection.
    const frames = require('./TradeMeetingCodec').pages(request);
    if (pages + transportPages - entry.pages + frames.length > 64) throw Error('trade_meeting_backpressure');
    pages += frames.length - entry.pages;
    entry.frames = frames; entry.pages = frames.length;
    entry.bytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0);
    if (entry.bytes + transportBytes + [...staged.values()].reduce((sum, other) => sum + (other === entry ? 0 : other.bytes), 0) > 48 * 1024) throw Error('trade_meeting_backpressure');
}

async function accept(id, characterId = null) {
    const entry = staged.get(id);
    if (!entry) {
        const row = await db().fetchTradeMeetingByToken?.(id);
        if (!row) {
            const saved = characterId && await db().fetchTradeMeetingReceipt?.(id, characterId);
            if (saved) return saved;
            throw Error('trade_meeting_preparation_missing');
        }
        if (characterId && ![row.actorA, row.actorB].includes(Number(characterId))) throw Error('trade_meeting_preparation_missing');
        return accepted({ meeting: row, pending: row.state === 'accepted' });
    }
    if (characterId && !entry.actors.includes(Number(characterId))) throw Error('trade_meeting_preparation_missing');
    try {
        // DB persists the original token/sequences, so retry never invents
        // fresh consent after an acknowledgement or ordinary bot commit.
        if (entry.ready) await entry.ready;
        const request = require('./TradeMeetingCodec').fromPages(entry.frames);
        const result = await db().acceptTradeMeeting(request, entry.proofs ? {
            validatePreparation: () => validatePrepared(entry, request), freshPreparation: true
        } : undefined);
        return accepted(result);
    } finally { discard(id); }
}
async function accepted(result) {
    acceptRows(result);
    const row = result.meeting;
    enroll(row.actorA, row.id); enroll(row.actorB, row.id);
    await syncActors(row).catch(error => utils.infoWarn('AfkTrade', 'meeting inventory presentation: %s', error.message));
    wake(row.actorA); wake(row.actorB);
    return { pending: result.pending, meetingId: row.id, revision: row.revision,
        outcome: row.state, token: row.token, preparationId: row.token,
        purchased: false, sold: false, state: life().cachedState(row.actorA) };
}
async function receipt(token, characterId) {
    const pending = staged.get(token);
    if (pending?.actors.includes(Number(characterId))) return { pending: true, token, preparationId: token, outcome: 'preparing' };
    const row = await db().fetchTradeMeetingByToken(token);
    if (!row) return db().fetchTradeMeetingReceipt?.(token, characterId) || null;
    if (![row.actorA, row.actorB].includes(Number(characterId))) return null;
    return accepted({ meeting: row, pending: row.state === 'accepted' });
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
    const anchors = sides.filter(side => side.meetingId).map(side => side.anchor);
    if (anchors.some(anchor => !anchor || anchor.town !== record.town)
        || anchors.some(anchor => ['locX', 'locY', 'locZ'].some(k => anchor[k] !== anchors[0][k]))) throw Error('trade_meeting_point_changed');
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
    const sources = []; let remainder = amount;
    for (const source of sides[sellerSide].inventory) {
        if (source.selfId !== itemId || source.equipped || Number(source.enchant || 0) !== Number(line.enchant || 0)
            || options.objectId && source.id !== options.objectId || !(source.amount > 0)) continue;
        const count = Math.min(remainder, source.amount);
        sources.push({ source, count }); remainder -= count;
        if (!remainder || sources.length === 5) break;
    }
    if (remainder) {
        if (record.storeType === 1 && db().reconcileConditionalSellAds) {
            for (const ad of await db().reconcileConditionalSellAds(record.ownerId)) afk().refreshRecord(ad);
        }
        throw Error('trade_meeting_stock_changed');
    }
    const destination = anchors[0] || record;
    const point = { locX: destination.locX, locY: destination.locY, locZ: destination.locZ };
    if (options.expectedPoint && ['locX', 'locY', 'locZ'].some(key => options.expectedPoint[key] !== point[key]))
        throw Error('trade_meeting_point_changed');
    const parties = sides.map((side, index) => {
        const actor = actors[index], state = life().cachedState(actor);
        let route;
        if (state) {
            // Worker supplies the chosen route together with its fresh consent.
            route = { fee: 0, scroll: false, method: 'walk', durationMs: 0 };
        } else {
            const position = side.position;
            if (!position || Math.hypot(position.locX - point.locX, position.locY - point.locY, position.locZ - point.locZ) > 200) throw Error('trade_meeting_player_at_point');
            route = { fee: 0, scroll: false, method: 'walk', durationMs: 0 };
        }
        if (side.meetingId) route = { fee: 0, scroll: false, method: `meeting:${side.meetingId}`, durationMs: 0 };
        return { ...side, route, needRevision: side.revision };
    });
    const token = options.token || randomUUID(), total = amount * line.price;
    if (!Number.isSafeInteger(total) || total <= 0) throw Error('trade_meeting_integer');
    const quote = { preparationId: token, token, town: record.town, point, amount, price: line.price, total };
    // A human may read the quantity form for minutes while the bot keeps
    // progressing. Only explicit agreement owns a fresh worker preparation.
    if (options.preview === true) return quote;
    const request = { token, actorA: actors[0], actorB: actors[1], seqA: sides[0].sequence, seqB: sides[1].sequence,
        town: record.town, point, parties, incoming: sides.map(side => side.acceptedIncoming || {}), lines: sources.map(({ source, count }) => ({ payer: buyerSide, itemId: source.id, selfId: itemId,
            enchant: line.enchant || 0, count, price: line.price, needAdId: 0, needAdRevision: 0, adId: record.id, adRevision: record.revision, certificate: null })) };
    stage(request);
    const entry = staged.get(token);
    entry.ready = prepareActors(token).catch(error => { discard(token); throw error; });
    entry.ready.catch(() => {}); // UI confirmation or the bot continuation owns the outcome.
    return quote;
}
async function cancel(characterId) {
    const rows = db().fetchTradeMeetingsForOwner ? await db().fetchTradeMeetingsForOwner(Number(characterId))
        : [await db().fetchTradeMeetingForOwner(Number(characterId))].filter(Boolean);
    for (const row of rows) {
        const result = await db().cancelTradeMeeting(row.id, 'explicit_cancel');
        acceptRows(result); wake(row.actorA); wake(row.actorB);
    }
    return { ok: true, cancelled: rows.length > 0 };
}
async function trade(characterId, store, itemId, amount, options) {
    const prepared = await prepareTrade(characterId, store, itemId, amount, options);
    if (!prepared.preparationId) return prepared;
    // A lifecycle command may be waiting for this return on commandTail.
    // Release it before either independent worker preparation replies.
    const token = prepared.preparationId, entry = staged.get(token);
    entry.ready.then(() => accept(token, characterId)).catch(error => {
        utils.infoWarn('AfkTrade', 'meeting preparation %s: %s', token, error.message);
    });
    return { pending: true, preparationId: token, token, outcome: 'preparing', purchased: false, sold: false, state: life().cachedState(characterId) };
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
    unsubscribeLife?.(); unsubscribeMarketLife?.(); unsubscribePlayer?.(); unsubscribeBoard?.();
    unsubscribeLife = unsubscribeMarketLife = unsubscribePlayer = unsubscribeBoard = undefined;
    for (const token of [...staged.keys()]) discard(token);
    staged.clear(); pages = 0; transportPages = 0; transportBytes = 0; enrolled.clear(); queue.clear();
}
function wake(id) {
    if (!enrolled.has(Number(id))) return;
    queue.add(Number(id));
    if (!draining) { draining = true; setImmediate(drain); }
}
async function processOwner(id) {
    for (const meetingId of [...(enrolled.get(id) || [])].slice(0, MAX_COMMITMENTS)) await processMeeting(id, meetingId);
}
async function processMeeting(id, meetingId) {
    const row = await db().fetchTradeMeeting(meetingId);
    if (!enrolled.has(id)) return;
    if (!row) { unenroll(id, meetingId); return; }
    if (row.state !== 'accepted') {
        await syncActors(row);
        await afk().settleOwners([row.actorA, row.actorB]);
        for (const actor of [row.actorA, row.actorB]) await db().acknowledgeTradeMeeting(row.id, actor);
        unenroll(row.actorA, row.id); unenroll(row.actorB, row.id);
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
    const anchorId = state?.stats?.tradeMeeting?.[0] || await db().fetchTradeMeetingForOwner?.(id).then(anchor => anchor?.id);
    if (anchorId && anchorId !== row.id) return;
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
    const route = JSON.parse(row[`route${suffix}`]);
    if (route.method === 'walk' || String(route.method).startsWith('meeting:')) {
        const legId = `walk:${point.locX}:${point.locY}:${point.locZ}`;
        acceptRows(await db().payTradeMeetingLeg(row.id, side, row[`nextLeg${suffix}`], legId, 0, false));
        return;
    }
    const native = Routes.between(state.loc, point);
    if (!native.route) { acceptRows(await db().cancelTradeMeeting(row.id, 'route_unavailable')); wake(state.characterId); return; }
    let kind = 'walk', destination = point, fee = 0, scroll = false;
    if (route.scroll && row[`nextLeg${suffix}`] === 1) {
        kind = 'soe'; destination = native.start; scroll = true;
    } else if (native.route.steps?.length && native.route.fee <= row[`routeReserve${suffix}`]) {
        const step = native.route.steps[0];
        const keeper = require('../World/NpcObjectIndex').nearTemplate(world(), step.npcId,
            native.start.locX, native.start.locY, 1200);
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
    unsubscribeLife?.(); unsubscribeMarketLife?.(); unsubscribePlayer?.(); unsubscribeBoard?.(); enrolled.clear(); queue.clear();
    unsubscribeLife = life().subscribeChanges(change => {
        const id = Number(typeof change === 'number' ? change : change.characterId);
        // Only bounded unaccepted preparations are replaceable. The durable
        // accepted meeting survives ordinary economic revisions and ad edits.
        for (const [key, entry] of staged) if (entry.actors.includes(id)) {
            const side = entry.actors.indexOf(id), state = life().cachedState(id);
            if (!state || require('../Bot/Economy/EconomyCommit').authority(state).revision !== entry.revisions[side]) discard(key);
        }
        wake(id);
    });
    // Cold commit/reflection publishes authority changes without republishing
    // general life snapshots. Continue the enrolled meeting on that event too;
    // the existing Set coalesces both sources and native presence decides arrival.
    unsubscribeMarketLife = life().subscribeMarketReviewChanges(wake);
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
        for (const row of rows) {
            for (const actor of [row.actorA, row.actorB]) {
                const state = await db().fetchTradeMeetingOwnerState?.(actor);
                if (state) life().acceptLifecycleRow(state);
                enroll(actor, row.id); wake(actor);
            }
        }
        cursor = rows.at(-1).id;
        await new Promise(resolve => setImmediate(resolve));
    }
}
module.exports = { stage, discard, hasPreparation, accept, cancel, receipt, prepareTrade, trade, wake, init, reset, presenceChanged,
    adjustTransportPages,
    counters: () => ({ preparations: staged.size, pages: pages + transportPages, bytes: transportBytes + [...staged.values()].reduce((total, row) => total + row.bytes, 0), queued: queue.size, participants: enrolled.size }) };
