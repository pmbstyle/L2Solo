'use strict';
const { randomUUID } = require('node:crypto');
const { MAX_COMMITMENTS } = require('./TradeMeeting');
const { partyTradeAllowed } = require('../Bot/Population/PartyAdmission');
const EconomyCommit = require('../Bot/Economy/EconomyCommit');
const TableChannel = require('../Bot/Population/ColdTableChannel').shared;
const staged = new Map();
const preparedActors = new Map(); // actor -> staged token; one preparation per actor.
const enrolled = new Map(); // At most eight numeric references per actor; no custody/terms.
const playerWaiters = new Map(); // Derived numeric references, retired with native commitments.
const travelNotices = new Map(); // One private acknowledgement per enrolled bot/player commitment.
// The 'meetings' table: one row per bot the player waits for at a meeting point.
// The cold worker reschedules the bot when its row comes or goes.
TableChannel.register('meetings', { key: row => row.characterId,
    allRows: () => [...playerWaiters.keys()].map(characterId => ({ characterId })), eventDriven: true });
function publishWaiting(actor) {
    TableChannel.changed('meetings', playerWaiters.get(actor)?.size
        ? { characterId: actor } : { key: actor, removed: true });
}
function clearWaiters() {
    for (const actor of playerWaiters.keys()) TableChannel.changed('meetings', { key: actor, removed: true });
    playerWaiters.clear();
}
function notifyPlayerTravel(row) {
    if (row.state !== 'accepted') return;
    for (const [id, other, suffix] of [[row.actorA, row.actorB, 'A'], [row.actorB, row.actorA, 'B']]) {
        const state = life().cachedState(id), player = !life().cachedState(other) && sessionFor(other);
        if (!state || !player?.actor || !player.dataSendToMe || travelNotices.get(id)?.has(row.id)) continue;
        try {
            const atPoint = loc => loc && Math.hypot(loc.locX - row.locX, loc.locY - row.locY, loc.locZ - row.locZ) <= 200;
            const merchant = sessionFor(id)?.actor;
            const loc = merchant ? { locX: merchant.fetchLocX(), locY: merchant.fetchLocY(), locZ: merchant.fetchLocZ() } : state.loc;
            if (atPoint(loc) || !atPoint({ locX: player.actor.fetchLocX(), locY: player.actor.fetchLocY(), locZ: player.actor.fetchLocZ() })
                || player.actor.isDead() || player.actor.fetchHp() <= 0) continue;
            const travel = state.stats?.travel, route = JSON.parse(row[`route${suffix}`] || '{}'), timestamp = Date.now();
            const finishingTrip = state.activity === 'traveling' && travel && travel.meetingId !== row.id && !atPoint(travel.to);
            const remaining = travel && atPoint(travel.to) ? Math.max(0, travel.arrivalAt - timestamp)
                : Math.max(0, Number(route.durationMs) || 0) + Math.max(0, Number(state.stats?.restUntil || 0) - timestamp);
            let text = state.activity === 'resting' ? "All set! I'll recover first, then come to you."
                : state.activity === 'fighting' ? "All set! I'll finish this fight, then come to you."
                    : finishingTrip ? "All set! I'll finish this trip, then come to you."
                    : "All set! I'm on my way to you.";
            text += ' Wait at the meeting point.';
            if (remaining > 0 && state.activity !== 'fighting' && !finishingTrip) text += remaining < 60000
                ? ' About a minute.' : ` About ${Math.ceil(remaining / 60000)} min.`;
            player.dataSendToMe(invoke('GameServer/Network/Response').speak({
                fetchId: () => id, fetchName: () => state.name
            }, { kind: 2, text }));
            let notices = travelNotices.get(id);
            if (!notices) travelNotices.set(id, notices = new Set());
            notices.add(row.id);
        } catch (error) { utils.infoWarn('AfkTrade', 'meeting travel message: %s', error.message); }
    }
}
function trackPlayerWaiting(row) {
    if (!row) return;
    for (const [actor, other] of [[row.actorA, row.actorB], [row.actorB, row.actorA]]) {
        const player = !life().cachedState(other) && sessionFor(other)?.actor;
        const waiting = row.state === 'accepted' && life().cachedState(actor) && player
            && !player.isDead() && player.fetchHp() > 0
            && Math.hypot(player.fetchLocX() - row.locX, player.fetchLocY() - row.locY, player.fetchLocZ() - row.locZ) <= 200;
        let refs = playerWaiters.get(actor);
        const previous = !!refs?.size;
        if (waiting) {
            if (!refs) playerWaiters.set(actor, refs = new Set());
            refs.add(row.id);
        } else {
            refs?.delete(row.id);
            if (!refs?.size) playerWaiters.delete(actor);
        }
        if (previous !== !!playerWaiters.get(actor)?.size) publishWaiting(actor);
    }
}
function enroll(actor, id) {
    let rows = enrolled.get(actor);
    if (!rows) enrolled.set(actor, rows = new Set());
    rows.add(id);
}
function unenroll(actor, id) {
    const rows = enrolled.get(actor); rows?.delete(id);
    if (!rows?.size) enrolled.delete(actor);
    const notices = travelNotices.get(actor); notices?.delete(id);
    if (!notices?.size) travelNotices.delete(actor);
    const waiting = playerWaiters.get(actor);
    if (waiting?.delete(id) && !waiting.size) {
        playerWaiters.delete(actor);
        publishWaiting(actor);
    }
}
const queue = new Set();
const resultListeners = new Map();
let pages = 0, transportPages = 0, transportBytes = 0, draining = false, unsubscribeLife, unsubscribeMarketLife, unsubscribePlayer, unsubscribeBoard;
const coordinator = () => invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const db = () => invoke('Database');
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const world = () => invoke('GameServer/World/World');
const afk = () => invoke('GameServer/AfkTrade/AfkTradeService');
const sessionFor = id => world().registeredActorById(Number(id))?.session || null;
function notifyResult(token, actors, result) {
    const listeners = resultListeners.get(token);
    if (!listeners) return;
    for (const listener of [...listeners]) if (actors.includes(listener.actorId)) listener.finish(result);
}
function waitForResult(token, characterId, { signal } = {}) {
    const actorId = Number(characterId);
    if (!token || signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
        let finished = false, retry;
        const listeners = resultListeners.get(token) || new Set();
        const cleanup = () => {
            listeners.delete(listener);
            if (!listeners.size) resultListeners.delete(token);
            clearTimeout(retry);
            signal?.removeEventListener('abort', abort);
        };
        const listener = { actorId, finish: result => {
            if (finished) return;
            finished = true; cleanup(); resolve(result);
        } };
        const abort = () => listener.finish(null);
        listeners.add(listener); resultListeners.set(token, listeners);
        signal?.addEventListener('abort', abort, { once: true });
        // Register before reading: completion may race the pending reply.
        const read = () => receipt(token, actorId).then(result => {
            if (!result?.pending) listener.finish(result);
        }, error => {
            if (finished) return;
            if (!retry) utils.infoWarn('AfkTrade', 'meeting result %s waits: %s', token, error.message);
            retry = setTimeout(read, 1000);
        });
        read();
    });
}
function acceptRows(result) {
    trackPlayerWaiting(result?.meeting);
    for (const row of Object.values(result?.coldLifeRows || {})) {
        const state = life().acceptLifecycleRow(row);
        // Native reserve/leg/arrival replies owe a worker publication even if
        // another reflection already adopted the same row in the main cache.
        // An older reply republishes only the monotonic accepted current state.
        if (state?.phase === 'cold') {
            coordinator()?.notifyState?.(state, { reason: 'trade_meeting_native', critical: true });
        }
    }
}
async function refreshMeetingRecords(row) {
    if (!db().fetchAfkTradeShops) return;
    for (const actor of [row.actorA, row.actorB]) {
        try {
            for (const record of await db().fetchAfkTradeShops(actor)) afk().refreshRecord(record);
        } catch (error) {
            // Publication must not strand already committed custody before
            // wake can start the paid route or acknowledge a terminal receipt.
            utils.infoWarn('AfkTrade', 'meeting records for %d: %s', actor, error.message);
        }
    }
}
function setPresenceMarker(session, id, anchor) {
    session.tradeMeetingPresence = anchor ? { id: anchor.id, actorId: Number(id),
        locX: anchor.locX, locY: anchor.locY, locZ: anchor.locZ, present: null,
        otherId: Number(anchor.actorA) === Number(id) ? anchor.actorB : anchor.actorA, town: anchor.town,
        route: JSON.parse(Number(anchor.actorA) === Number(id) ? anchor.routeB || '{}' : anchor.routeA || '{}') } : undefined;
}
async function syncActors(row) {
    for (const id of [row.actorA, row.actorB]) {
        const session = sessionFor(id), actor = session?.actor;
        if (!session || Number(actor?.fetchId?.()) !== Number(id)) continue;
        const anchor = await db().fetchTradeMeetingForOwner?.(id) || (row.state === 'accepted' ? row : null);
        // The connection may hold another character after the wait: its marker,
        // travel and window stay untouched; the inventory sync is bound to the ID.
        if (session.actor === actor) {
            // A cold meeting may finish after materialization, without a hot
            // shopping continuation. Retire its inherited blocker from the
            // native lifecycle cache, preserving the rest of the hot snapshot.
            const current = life().cachedState(id);
            if (current && session.coldLifeState) {
                const stats = { ...session.coldLifeState.stats };
                if (current.stats?.tradeMeeting) stats.tradeMeeting = current.stats.tradeMeeting;
                else delete stats.tradeMeeting;
                session.coldLifeState = { ...session.coldLifeState, stats };
            }
            setPresenceMarker(session, id, anchor);
            if (!anchor || session.meetingTravel?.id === row.id && row.state !== 'accepted') session.meetingTravel = undefined;
        }
        await afk().syncOnlineInventory(id, await db().fetchItems(id, 'trade_meeting_sync'));
        if (session.actor !== actor) continue;
        if (!life().cachedState(id)) {
            try { require('./PlayerMeetingNotifications').notify(session, row); }
            catch (error) { utils.infoWarn('AfkTrade', 'meeting chat presentation: %s', error.message); }
            try { if (row.state !== 'accepted') require('./PlayerBoardWindow').meetingResult(session, row); }
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
    if ([request.actorA, request.actorB].some(id => !partyTradeAllowed('trade', life().cachedState(id), sessionFor(id)))) throw Error('trade_meeting_party_busy');
    if (count > 4 || pages + transportPages + count > 64) throw Error('trade_meeting_backpressure');
    if ([request.actorA, request.actorB].some(id => preparedActors.has(Number(id)))) throw Error('trade_meeting_preparation_busy');
    const id = request.token;
    staged.set(id, { frames, revisions: request.parties.map(party => party.revision),
        bytes: frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0), pages: count, actors: [request.actorA, request.actorB] });
    for (const actor of [request.actorA, request.actorB]) preparedActors.set(Number(actor), id);
    pages += count;
    return id;
}
// Preparations already hold the bounded participant set; callers use it to
// avoid changing their own consent while bilateral worker checks are pending.
function hasPreparation(characterId) {
    return preparedActors.has(Number(characterId));
}
// The preparation token this actor is in, or null.
function preparationOf(characterId) {
    return preparedActors.get(Number(characterId)) || null;
}
function canJoinParty(characterId, state = life().cachedState(characterId), session = sessionFor(characterId)) {
    const current = life()?.cachedState?.(characterId) || state;
    return partyTradeAllowed('party', current, session, hasPreparation(characterId), !!enrolled.get(Number(characterId))?.size);
}
function discard(id, notify = true) {
    const entry = staged.get(id);
    if (entry) {
        pages -= entry.pages; staged.delete(id);
        for (const actor of entry.actors) if (preparedActors.get(Number(actor)) === id) preparedActors.delete(Number(actor));
        entry.cancelled = true;
        if (entry.ready) coordinator()?.cancelMeetingPreparation?.(id);
        if (notify && !entry.committed) notifyResult(id, entry.actors, { pending: false, token: id, outcome: 'cancelled' });
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
        request.parties[side].survivalCost = proof.survivalCost ?? 0;
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
    let committed = false;
    try {
        // DB persists the original token/sequences, so retry never invents
        // fresh consent after an acknowledgement or ordinary bot commit.
        if (entry.ready) await entry.ready;
        const request = require('./TradeMeetingCodec').fromPages(entry.frames);
        const result = await db().acceptTradeMeeting(request, entry.proofs ? {
            validatePreparation: () => validatePrepared(entry, request), freshPreparation: true
        } : undefined);
        committed = entry.committed = true;
        return accepted(result);
    } finally { discard(id, !committed); }
}
async function accepted(result) {
    acceptRows(result);
    const row = result.meeting;
    if (row.state === 'accepted') { enroll(row.actorA, row.id); enroll(row.actorB, row.id); }
    else { unenroll(row.actorA, row.id); unenroll(row.actorB, row.id); }
    if (result.coldLifeRows) await refreshMeetingRecords(row);
    await syncActors(row).catch(error => utils.infoWarn('AfkTrade', 'meeting inventory presentation: %s', error.message));
    notifyPlayerTravel(row);
    wake(row.actorA); wake(row.actorB);
    if (row.state !== 'accepted') notifyResult(row.token, [row.actorA, row.actorB], {
        pending: false, token: row.token, meetingId: row.id, outcome: row.state });
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
    if (!line || !Number.isSafeInteger(amount) || amount <= 0 || amount > Number(line.availableCount ?? line.count)
        || options.expectedPrice !== undefined && line.price !== options.expectedPrice
        || options.expectedRevision !== undefined && record.revision !== options.expectedRevision) throw Error('trade_meeting_quote_changed');
    const buyer = record.storeType === 1 ? characterId : record.ownerId, seller = record.storeType === 1 ? record.ownerId : characterId;
    const actors = [buyer, seller].sort((a, b) => a - b), sides = await Promise.all(actors.map(id => db().prepareTradeParticipant(id)));
    if (sides.some((side, index) => !partyTradeAllowed('trade', side, sessionFor(actors[index])))) throw Error('trade_meeting_party_busy');
    const anchors = sides.filter(side => side.meetingId).map(side => side.anchor);
    if (anchors.some(anchor => !anchor || anchor.town !== record.town)
        || anchors.some(anchor => ['locX', 'locY', 'locZ'].some(k => anchor[k] !== anchors[0][k]))) throw Error('trade_meeting_point_changed');
    // Preserve the caller's decision authority across asynchronous native reads.
    // Freshly reading a participant must not turn a stale decision into consent.
    const sourceState = options.coldState || life().cachedState(characterId);
    const Errands = require('../Bot/Population/CombinedErrandPolicy');
    const errand = record.storeType === 1 && Errands.pending(sourceState).find(row =>
        Number(row.selfId) === Number(itemId) && row.town === record.town);
    const goal = record.storeType === 1 && invoke('GameServer/Bot/Goals/GoalState').snapshot(buyer)?.current;
    const purchaseGoal = Number(goal?.target?.itemId) === Number(itemId) ? goal : null;
    const callerAuthority = options.economyCommand?.authority || (sourceState
        ? EconomyCommit.authority(sourceState) : null);
    if (callerAuthority) {
        const own = sides[actors.indexOf(characterId)];
        if (!EconomyCommit.sameAuthority(own, callerAuthority)) throw Error('trade_meeting_authority_changed');
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
    entry.ready = prepareActors(token).catch(async error => {
        discard(token);
        // Only the payer's worker refuses a need; on a buy ad the payer is its
        // owner, so the need behind the ad changed. The refusal alone left the
        // ad on the board for every later seller (E198 (2)).
        if (error.message === 'trade_meeting_need_changed' && record.storeType === 3) await buyAdNeedChanged(record, line);
        else if (error.message === 'trade_meeting_need_changed') await purchaseNeedChanged(buyer, errand, purchaseGoal);
        else if (error.message === 'trade_meeting_purchase_price_changed'
            && life().cachedState(buyer)?.phase === 'cold') {
            rememberPriceRefusal(buyer, request, error.priceEvidence);
            coordinator()?.requestEconomyRefresh?.(buyer);
        }
        throw error;
    });
    entry.ready.catch(() => {}); // UI confirmation or the bot continuation owns the outcome.
    return quote;
}
// Stop advertising the exact quote its payer just refused, then let the
// owner publish its fresh quantities/value. A later revision survives this
// cleanup; sibling shop lines and both physical wallets are preserved.
const refusedAds = new Map();
function rememberPriceRefusal(buyer, request, evidence) {
    const state = life().cachedState(buyer), scopes = evidence?.scopes, purchase = evidence?.purchase;
    if (!state || !purchase || !Array.isArray(scopes) || scopes.length > 40
        || !scopes.every(scope => typeof scope === 'string')
        || evidence.offers === undefined && typeof evidence.source !== 'string'
        || evidence.items !== undefined && (!Array.isArray(evidence.items) || evidence.items.length > 60
            || !evidence.items.every(id => Number.isSafeInteger(id) && id > 0))
        || !EconomyCommit.sameAuthority(EconomyCommit.authority(state), evidence.authority)
        || Number(state.updatedAt || 0) !== evidence.updatedAt) return;
    const board = afk().boardIndex(), counters = invoke('GameServer/Bot/Economy/MarketCounters');
    const workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    const production = invoke('GameServer/Bot/Economy/ProductionPolicy');
    const refusals = invoke('GameServer/Bot/Economy/MeetingPriceRefusals');
    const current = () => (evidence.offers !== undefined
        ? evidence.fundingDominance === true && scopes.length === 0 && refusals.witnessCurrent(board, evidence.offers, purchase)
        : refusals.fingerprint(evidence.items
        ? [evidence.items.map(id => [id, board.itemFingerprint(id)]),
            scopes.map(scope => [scope, counters.meetingRevisionOf(scope), workshops.publicScopeDigest(scope)])]
        : scopes.map(scope => [scope, board.groupFingerprint(scope),
            counters.meetingRevisionOf(scope), workshops.publicScopeDigest(scope)])) === evidence.source)
        && production.allowsNpcShot(purchase.selfId) === evidence.npcAllowed
        && refusals.admissionFingerprint(board, evidence.admissionScope) === (evidence.admission ?? null);
    if (current()) refusals.remember(state, board, request, purchase, current,
        { minimumFree: evidence.minimumFree, fundingDominance: evidence.fundingDominance === true });
}
async function purchaseNeedChanged(ownerId, errand, goal) {
    try {
        await db().withMutationAdmission(() => {
            if (life().cachedState(ownerId)?.phase !== 'cold') throw Error('stale_market_review');
        }, async () => {
            const saved = errand && await life().retireMarketErrand(ownerId, errand);
            await invoke('GameServer/Bot/Goals/GoalState').abandonAccepted(ownerId, goal);
            if (saved && errand.purpose === 'clan') await invoke('GameServer/Clan/ClanPurchaseCredit')
                .returnUnspent(ownerId, errand, 0);
        });
    } catch (error) { utils.infoWarn('AfkTrade', 'refused purchase of %d refresh: %s', ownerId, error.message); }
    coordinator()?.requestEconomyRefresh?.(ownerId);
}

async function buyAdNeedChanged(record, line) {
    const key = `${record.id}:${line.id}`;
    if (refusedAds.get(key) === record.revision) return;
    refusedAds.delete(key); refusedAds.set(key, record.revision);
    if (refusedAds.size > 1024) refusedAds.delete(refusedAds.keys().next().value);
    try {
        // This is the payer's later refusal, not a continuation of the
        // initiating seller's command. Its async admission may have expired.
        // Admit only this unchanged conditional BUY quote; SQL repeats the
        // owner, revision and pricing checks at the write boundary.
        await db().withMutationAdmission(() => {
            const quote = afk().boardIndex().records.get(Number(record.id))?.find(row => row.lineId === line.id);
            if (!quote || quote.ownerId !== record.ownerId || quote.revision !== record.revision
                || quote.custodyPolicy !== 1 || quote.storeType !== 3) throw Error('afk_trade_shop_changed');
        }, () => afk().repriceBotLines(record.ownerId, [], { withdrawals: [{ recordId: record.id,
            lineId: line.id, expectedRevision: record.revision, previousPricing: line.pricing || null }] }));
    } catch (error) {
        utils.infoWarn('AfkTrade', 'refused buy quote %d refresh: %s', record.id, error.message);
    }
    const phase = life().cachedState(record.ownerId)?.phase;
    let asked = true;
    if (phase === 'cold') asked = coordinator()?.requestEconomyRefresh?.(record.ownerId) === true;
    else if (phase === 'hot') {
        asked = coordinator()?.requestEconomyLook?.(record.ownerId) === true;
        invoke('GameServer/Bot/Economy/HotBoardReviewService').ownerChanged(record.ownerId, 'line');
    }
    // A request the worker dropped (not ready yet) is asked again on the next refusal.
    if (!asked) refusedAds.delete(key);
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
// A player invitation replaces personal trading. Retire both an unaccepted
// preparation and accepted custody through the native refund/receipt path
// before party ownership changes; autonomous formation still waits for trades.
async function prepareForPlayerParty(characterId) {
    const preparation = preparationOf(characterId);
    if (preparation) discard(preparation);
    const rows = await db().fetchTradeMeetingsForOwner(Number(characterId));
    for (const row of rows) {
        const result = await db().cancelTradeMeeting(row.id, 'player_party_invite');
        acceptRows(result);
        await finishMeeting(result.meeting);
    }
    // A terminal receipt can still be enrolled while its event queue waits.
    await processOwner(Number(characterId));
    return canJoinParty(characterId);
}
async function trade(characterId, store, itemId, amount, options) {
    const prepared = await prepareTrade(characterId, store, itemId, amount, options);
    if (!prepared.preparationId) return prepared;
    // A lifecycle command may be waiting for this return on commandTail.
    // Release it before either independent worker preparation replies.
    const token = prepared.preparationId, entry = staged.get(token);
    // Preparation outlives the initiating command. Its acceptance has its
    // own bilateral proof and native transaction checks; the old command's
    // async-local write guard must not survive into that independent action.
    entry.ready.then(() => db().withoutMutationAdmission(() => accept(token, characterId))).catch(error => {
        utils.infoWarn('AfkTrade', 'meeting preparation %s: %s (actor=%d record=%d item=%d count=%d)',
            token, error.message, characterId, store.shopId, itemId, amount);
    });
    return { pending: true, preparationId: token, token, outcome: 'preparing', purchased: false, sold: false, state: life().cachedState(characterId) };
}
function presenceChanged(session) {
    const marker = session.tradeMeetingPresence, actor = session.actor;
    // A marker made for the previous character on this connection is not this one's.
    if (!marker || !actor || marker.actorId !== Number(actor.fetchId())) return;
    const present = !actor.isDead() && actor.fetchHp() > 0
        && Math.hypot(actor.fetchLocX() - marker.locX, actor.fetchLocY() - marker.locY, actor.fetchLocZ() - marker.locZ) <= 200;
    const atWaypoint = marker.waypoint ? Math.hypot(actor.fetchLocX() - marker.waypoint.locX,
        actor.fetchLocY() - marker.waypoint.locY, actor.fetchLocZ() - marker.waypoint.locZ) <= 200 : null;
    if (present === marker.present && atWaypoint === marker.atWaypoint) return;
    marker.present = present; marker.atWaypoint = atWaypoint; wake(actor.fetchId());
}
function reset() {
    invoke('GameServer/Bot/Economy/MeetingPriceRefusals').clear();
    unsubscribeLife?.(); unsubscribeMarketLife?.(); unsubscribePlayer?.(); unsubscribeBoard?.();
    unsubscribeLife = unsubscribeMarketLife = unsubscribePlayer = unsubscribeBoard = undefined;
    for (const token of [...staged.keys()]) discard(token);
    for (const [token, listeners] of [...resultListeners])
        notifyResult(token, [...listeners].map(listener => listener.actorId), null);
    staged.clear(); preparedActors.clear(); refusedAds.clear(); pages = 0; transportPages = 0; transportBytes = 0; enrolled.clear(); clearWaiters(); travelNotices.clear(); queue.clear();
}
function wake(id) {
    if (!enrolled.has(Number(id))) return;
    queue.add(Number(id));
    if (!draining) { draining = true; setImmediate(drain); }
}
async function processOwner(id) {
    for (const meetingId of [...(enrolled.get(id) || [])].slice(0, MAX_COMMITMENTS)) await processMeeting(id, meetingId);
}
async function finishMeeting(row) {
    await syncActors(row);
    await afk().settleOwners([row.actorA, row.actorB]);
    await refreshMeetingRecords(row);
    for (const actor of [row.actorA, row.actorB]) await db().acknowledgeTradeMeeting(row.id, actor);
    notifyResult(row.token, [row.actorA, row.actorB], {
        pending: false, token: row.token, meetingId: row.id, outcome: row.state });
    unenroll(row.actorA, row.id); unenroll(row.actorB, row.id);
}
async function processMeeting(id, meetingId) {
    const row = await db().fetchTradeMeeting(meetingId);
    if (!enrolled.has(id)) return;
    if (!row) { unenroll(id, meetingId); return; }
    trackPlayerWaiting(row);
    if (row.state !== 'accepted') {
        await finishMeeting(row);
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
    const marker = session?.tradeMeetingPresence;
    // Cold acceptance has no session to mark. Restore the anchor when its
    // actor materializes, before starting a walk that must publish arrival.
    // Retain a current marker: its waypoint/presence transitions wake this
    // queue, while ordinary held AI ticks deliberately do not poll it.
    if (state?.phase === 'hot' && state.stats?.tradeMeeting?.[0] === row.id && Number(session?.actor?.fetchId?.()) === id
        && (marker?.id !== row.id || marker.actorId !== id)) setPresenceMarker(session, id, row);
    const arrived = await db().arriveTradeMeeting(row.id); acceptRows(arrived);
    if (arrived?.meeting.state !== 'accepted') { await syncActors(arrived.meeting);
        for (const ad of arrived.closed || []) afk().refreshRecord(ad);
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
    unsubscribeLife?.(); unsubscribeMarketLife?.(); unsubscribePlayer?.(); unsubscribeBoard?.(); enrolled.clear(); clearWaiters(); travelNotices.clear(); queue.clear();
    unsubscribeLife = life().subscribeChanges(change => {
        const id = Number(typeof change === 'number' ? change : change.characterId);
        // Only bounded unaccepted preparations are replaceable. The durable
        // accepted meeting survives ordinary economic revisions and ad edits.
        for (const [key, entry] of staged) if (entry.actors.includes(id)) {
            const side = entry.actors.indexOf(id), state = life().cachedState(id);
            if (!state || EconomyCommit.authority(state).revision !== entry.revisions[side]) discard(key);
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
            trackPlayerWaiting(row);
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
module.exports = { stage, discard, hasPreparation, preparationOf, canJoinParty, prepareForPlayerParty, accept, cancel, receipt, waitForResult, prepareTrade, trade, wake, init, reset, presenceChanged,
    adjustTransportPages,
    counters: () => ({ preparations: staged.size, pages: pages + transportPages, bytes: transportBytes + [...staged.values()].reduce((total, row) => total + row.bytes, 0), queued: queue.size, participants: enrolled.size }) };
