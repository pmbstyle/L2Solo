'use strict';
// Native board custody. Every method is called within Database's one write
// transaction, using its existing inventory, settlement and fencing owners.
const Intent = require('../Bot/Economy/TradeIntent');
const safe = (n, positive = false) => Number.isSafeInteger(n) && n >= (positive ? 1 : 0);
function requireSafe(n, positive = false) { if (!safe(n, positive)) throw Error('trade_meeting_integer'); return n; }
function sum(a, b) { return requireSafe(a + b); }
function canonical(request) {
    const { token, actorA, actorB, seqA, seqB, town, point, lines, parties } = request;
    if (typeof token !== 'string' || token.length < 1 || Buffer.byteLength(token) > 80
        || !safe(actorA, true) || !safe(actorB, true) || actorA >= actorB
        || !safe(seqA, true) || !safe(seqB, true) || typeof town !== 'string' || town.length > 48
        || !point || !['locX', 'locY', 'locZ'].every(k => Number.isFinite(point[k]))
        || !Array.isArray(lines) || lines.length < 1 || lines.length > 5 || !Array.isArray(parties) || parties.length !== 2) throw Error('trade_meeting_terms');
    const basket = lines.map(line => {
        if (![0, 1].includes(line.payer)) throw Error('trade_meeting_terms');
        const row = { payer: line.payer, itemId: requireSafe(line.itemId, true),
            selfId: requireSafe(line.selfId, true), enchant: requireSafe(line.enchant || 0),
            count: requireSafe(line.count, true), price: requireSafe(line.price, true),
            adId: requireSafe(line.adId || 0), adRevision: requireSafe(line.adRevision || 0),
            needAdId: requireSafe(line.needAdId || 0), needAdRevision: requireSafe(line.needAdRevision || 0),
            certificate: line.certificate || null };
        if (row.selfId === 57) throw Error('trade_meeting_terms');
        requireSafe(row.count * row.price);
        if (row.certificate) {
            const intent = Intent.decode(row.certificate);
            if (intent.itemId !== row.selfId || intent.amount < row.count || intent.price !== row.price) throw Error('trade_meeting_need_changed');
        }
        return row;
    });
    const sides = parties.map((party, side) => {
        const route = party.route;
        if (!route || !Number.isFinite(route.durationMs) || route.durationMs < 0
            || !safe(route.fee) || ![true, false].includes(route.scroll) || typeof route.method !== 'string'
            || Buffer.byteLength(JSON.stringify(route)) > 256) throw Error('trade_meeting_route');
        if (!safe(party.revision) || !safe(party.sequence, true) || party.sequence !== (side ? seqB : seqA)) throw Error('trade_meeting_authority');
        return { revision: party.revision, sequence: party.sequence,
            phase: party.phase, route: { fee: route.fee, scroll: route.scroll, method: route.method, durationMs: route.durationMs }, needRevision: requireSafe(party.needRevision) };
    });
    return { token, actorA, actorB, seqA, seqB, town, point: { locX: point.locX, locY: point.locY, locZ: point.locZ }, lines: basket, parties: sides };
}
function create(io) {
    const { one, all, write, take, debit, credit, snapshot, protection, funding, now } = io;
    const meeting = id => one('SELECT * FROM board_trade_meetings WHERE id=?', [requireSafe(id, true)]);
    const ids = row => [row.actorA, row.actorB];
    function participant(id) {
        const character = one('SELECT id FROM characters WHERE id=?', [id]);
        if (!character) throw Error('trade_meeting_character_missing');
        write('INSERT OR IGNORE INTO board_trade_participants(characterId) VALUES(?)', [id]);
        return one('SELECT * FROM board_trade_participants WHERE characterId=?', [id]);
    }
    function fence(row, changed) {
        const states = {};
        ids(row).forEach(id => { const next = snapshot(id, changed, { tradeMeeting: row.state === 'accepted' ? [row.id, row.revision] : null }); if (next) states[id] = next; });
        return states;
    }
    function result(row, coldLifeRows = {}) { return { meeting: row, pending: row.state === 'accepted', coldLifeRows }; }
    function accept(input) {
        const request = canonical(input), terms = JSON.stringify(request);
        const replay = one('SELECT * FROM board_trade_meetings WHERE token=?', [request.token]);
        if (replay) {
            if (replay.terms !== terms) throw Error('trade_meeting_consent_changed');
            return result(replay);
        }
        const actors = [request.actorA, request.actorB], sequences = [request.seqA, request.seqB];
        const totals = [0, 0], aggregate = new Map(), protectedTotals = new Map();
        for (const line of request.lines) {
            totals[line.payer] = sum(totals[line.payer], line.count * line.price);
            const seller = 1 - line.payer, key = `${seller}:${line.itemId}`;
            aggregate.set(key, sum(aggregate.get(key) || 0, line.count));
            const protectedKey = `${seller}:${line.selfId}`;
            protectedTotals.set(protectedKey, sum(protectedTotals.get(protectedKey) || 0, line.count));
        }
        actors.forEach((id, side) => {
            const slot = participant(id);
            if (slot.meetingId !== null || slot.nextSequence !== sequences[side]) throw Error('trade_meeting_participant_changed');
            requireSafe(slot.nextSequence + 1, true);
            const party = request.parties[side];
            const life = one('SELECT * FROM bot_life_state WHERE characterId=?', [id]);
            if (life && (Number(life.hp) <= 0 || life.activity === 'dead' || Number(life.simulationRevision) !== party.revision || life.phase !== party.phase)) throw Error('trade_meeting_authority_changed');
            if (!life) {
                const position = io.position(id);
                if (!position?.alive || !position.available || Math.hypot(position.locX - request.point.locX,
                    position.locY - request.point.locY, position.locZ - request.point.locZ) > 200) throw Error('trade_meeting_player_at_point');
            }
            if (one('SELECT 1 FROM board_settlements WHERE ownerId=? LIMIT 1', [id])) throw Error('trade_meeting_delivery_pending');
            if (life) for (const line of request.lines.filter(line => line.payer === side)) {
                const adId = line.needAdId || line.adId;
                const ad = adId && one('SELECT * FROM afk_trade_shops WHERE id=?', [adId]);
                const need = ad && one('SELECT * FROM afk_trade_lines WHERE shopId=? AND selfId=? LIMIT 1', [adId, line.selfId]);
                if (!line.certificate || !ad || ad.ownerId !== id || ad.storeType !== 3 || ad.custodyPolicy !== 1
                    || !need?.intentJson || need.intentRevision !== party.revision || need.count < line.count
                    || (line.needAdId ? ad.revision !== line.needAdRevision : ad.revision !== line.adRevision)) throw Error('trade_meeting_need_changed');
                const original = JSON.parse(need.intentJson), intent = Intent.decode(line.certificate);
                if (JSON.stringify(original.slice(3)) !== JSON.stringify(line.certificate.slice(3))
                    || intent.amount > need.count || intent.price > need.price) throw Error('trade_meeting_need_changed');
            }
            const outgoing = sum(totals[side], party.route.fee);
            if (life) funding(id, { row: life }, outgoing, { r: Math.min(...request.lines.filter(line => line.payer === side)
                .map(line => line.certificate ? Intent.decode(line.certificate).valueRate : Infinity)), free: totals[side] === 0 });
            // A public bid is evidence of the owner's need, not collateral.
            for (const line of request.lines.filter(line => line.payer === side && line.adId)) {
                const ad = one('SELECT * FROM afk_trade_shops WHERE id=?', [line.adId]);
                const adLine = ad && one('SELECT * FROM afk_trade_lines WHERE shopId=? LIMIT 1', [line.adId]);
                if (!ad || ad.ownerId !== (ad.storeType === 3 ? id : actors[1 - side]) || ad.custodyPolicy !== 1 || ad.revision !== line.adRevision
                    || !adLine || adLine.selfId !== line.selfId || adLine.price !== line.price || adLine.count < line.count) throw Error('trade_meeting_quote_changed');
                if (ad.storeType === 3 && (!line.certificate || adLine.intentJson !== JSON.stringify(line.certificate)
                    || adLine.intentRevision !== party.needRevision || party.needRevision !== party.revision)) throw Error('trade_meeting_need_changed');
            }
            debit(id, outgoing);
        });
        // Validate aggregate amounts before taking any stack. Protection also
        // excludes worn and previously committed material reservations.
        for (const [key, count] of aggregate) {
            const [side, itemId] = key.split(':').map(Number), id = actors[side];
            const physical = one('SELECT * FROM items WHERE id=? AND characterId=?', [itemId, id]);
            const terms = request.lines.filter(line => line.itemId === itemId && 1 - line.payer === side);
            if (!physical || physical.equipped || physical.amount < count
                || terms.some(line => line.selfId !== physical.selfId || line.enchant !== Number(physical.enchant || 0))) throw Error('trade_meeting_stock_changed');
        }
        for (const [key, count] of protectedTotals) {
            const [side, selfId] = key.split(':').map(Number), id = actors[side];
            const life = one('SELECT * FROM bot_life_state WHERE characterId=?', [id]);
            if (life) protection(id, { row: life }, selfId, count);
        }
        const id = Number(write(`INSERT INTO board_trade_meetings(token,terms,actorA,actorB,seqA,seqB,
            town,locX,locY,locZ,escrowA,escrowB,routeReserveA,routeReserveB,routeA,routeB)
            VALUES(${Array(16).fill('?').join(',')})`, [request.token, terms, ...actors, ...sequences, request.town,
            request.point.locX, request.point.locY, request.point.locZ, ...totals, request.parties[0].route.fee,
            request.parties[1].route.fee, JSON.stringify(request.parties[0].route), JSON.stringify(request.parties[1].route)]).insertId);
        function hold(ordinal, side, line, count, type) {
            const source = take(actors[side], line.itemId, line.selfId, line.enchant || 0, count);
            const template = require('../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, source.selfId);
            write(`INSERT INTO board_trade_meeting_lines(meetingId,ordinal,payer,selfId,enchant,count,price,heldCount,
                sourceObjectId,name,slot,stackable,petData,sourceAdId,sourceAdRevision,custodyType)
                VALUES(${Array(16).fill('?').join(',')})`, [id, ordinal, 1 - side, source.selfId, source.enchant || 0,
                count, line.price || 0, count, source.id, source.name, source.slot || 0, template?.etc?.stackable ? 1 : 0,
                source.petData || null, line.adId || null, line.adRevision || null, type]);
        }
        request.lines.forEach((line, ordinal) => hold(ordinal, 1 - line.payer, line, line.count, 'trade'));
        request.parties.forEach((party, side) => {
            if (party.route.scroll) {
                const scroll = one('SELECT id FROM items WHERE characterId=? AND selfId=736 AND equipped=0 AND amount>0 ORDER BY id LIMIT 1', [actors[side]]);
                if (!scroll) throw Error('trade_meeting_scroll_missing');
                hold(5 + side, side, { itemId: scroll.id, selfId: 736 }, 1, 'route');
            }
            write('UPDATE board_trade_participants SET nextSequence=nextSequence+1,meetingId=? WHERE characterId=?', [id, actors[side]]);
        });
        const row = meeting(id);
        return result(row, fence(row, [...request.lines.map(line => line.selfId), 736]));
    }
    function leg(id, side, sequence, legId, fee, scroll) {
        const row = meeting(id), suffix = side === 0 ? 'A' : side === 1 ? 'B' : null;
        if (!suffix || !row || row.state !== 'accepted' || typeof legId !== 'string' || legId.length > 48) throw Error('trade_meeting_leg');
        requireSafe(sequence, true); requireSafe(fee);
        const original = JSON.parse(row[`leg${suffix}`] || 'null');
        if (original?.sequence === sequence) {
            if (original.legId !== legId || original.fee !== fee || original.scroll !== scroll) throw Error('trade_meeting_consent_changed');
            return result(row);
        }
        if (original || sequence !== row[`nextLeg${suffix}`]) throw Error('trade_meeting_leg_changed');
        requireSafe(sequence + 1, true);
        if (fee > row[`routeReserve${suffix}`]) throw Error('trade_meeting_route_unfunded');
        if (scroll) {
            const held = one("SELECT * FROM board_trade_meeting_lines WHERE meetingId=? AND ordinal=? AND custodyType='route' AND heldCount=1", [id, 5 + side]);
            if (!held) throw Error('trade_meeting_scroll_missing');
            write('UPDATE board_trade_meeting_lines SET heldCount=0 WHERE meetingId=? AND ordinal=?', [id, 5 + side]);
        }
        const receipt = { sequence, legId, fee, scroll };
        io.startTrip?.(ids(row)[side], row, side, receipt);
        write(`UPDATE board_trade_meetings SET routeReserve${suffix}=routeReserve${suffix}-?,nextLeg${suffix}=?,leg${suffix}=? WHERE id=?`,
            [fee, sequence + 1, JSON.stringify(receipt), id]);
        const next = meeting(id);
        return result(next, fence(next, [57, 736]));
    }
    function terminal(id, completed, reason = '') {
        const row = meeting(id);
        if (!row) throw Error('trade_meeting_missing');
        if (row.state !== 'accepted') return result(row);
        const actors = ids(row), changed = [];
        const lines = all('SELECT * FROM board_trade_meeting_lines WHERE meetingId=? ORDER BY ordinal', [id]);
        for (const line of lines) {
            if (!line.heldCount) continue;
            const owner = completed && line.custodyType === 'trade' ? line.payer : 1 - line.payer;
            credit(actors[owner], line, line.heldCount, now()); changed.push(line.selfId);
            if (completed && line.custodyType === 'trade') io.completed?.(row, line);
        }
        actors.forEach((actor, side) => {
            const own = side ? 'B' : 'A', other = side ? 'A' : 'B';
            credit(actor, { selfId: 57 }, sum(row[`routeReserve${own}`], row[`escrow${completed ? other : own}`]), now());
        });
        write('UPDATE board_trade_meeting_lines SET heldCount=0 WHERE meetingId=?', [id]);
        write(`UPDATE board_trade_meetings SET state=?,revision=revision+1,escrowA=0,escrowB=0,
            routeReserveA=0,routeReserveB=0,reason=? WHERE id=?`, [completed ? 'completed' : 'cancelled', String(reason).slice(0, 80), id]);
        io.stopTrip?.(row);
        const next = meeting(id);
        return result(next, fence(next, changed));
    }
    function present(id, positions) {
        const row = meeting(id);
        if (!row || row.state !== 'accepted') return row ? result(row) : null;
        const actors = ids(row);
        let mask = 0;
        positions.forEach((position, side) => {
            if (position?.characterId !== actors[side] || !position.alive || !position.available) return;
            if (Math.hypot(position.locX - row.locX, position.locY - row.locY, position.locZ - row.locZ) <= 200) mask |= 1 << side;
        });
        write('UPDATE board_trade_meetings SET arrivalMask=? WHERE id=?', [mask, id]);
        return mask === 3 ? terminal(id, true, 'arrived') : result(meeting(id));
    }
    function acknowledge(id, actorId) {
        const row = meeting(id);
        if (!row) return null;
        const side = ids(row).indexOf(actorId);
        if (side < 0 || row.state === 'accepted') throw Error('trade_meeting_ack');
        const mask = row.deliveryMask | 1 << side;
        write('UPDATE board_trade_meetings SET deliveryMask=? WHERE id=?', [mask, id]);
        if (mask === 3) {
            ids(row).forEach((actor, index) => write('UPDATE board_trade_participants SET meetingId=NULL WHERE characterId=? AND meetingId=? AND nextSequence=?',
                [actor, id, (index ? row.seqB : row.seqA) + 1]));
            write('DELETE FROM board_trade_meeting_lines WHERE meetingId=?', [id]);
            write('DELETE FROM board_trade_meetings WHERE id=?', [id]);
        }
        return { acknowledged: true, cleaned: mask === 3 };
    }
    return { accept, leg, terminal, present, acknowledge, participant, meeting };
}
module.exports = { create, canonical };
