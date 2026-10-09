const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const ids = [730201, 730202];
const point = { locX: 83396, locY: 147904, locZ: -3400 };
(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'board-meeting');
    try {
        await Database.createAccount('bot_meeting_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_meeting_fixture' WHERE id IN (?,?)", ids]);
        await Life.init();
        const certify = async lines => {
            for (const side of [0, 1]) {
                const bought = lines.filter(line => line.payer === side);
                if (!bought.length) continue;
                const configs = bought.map(line => ({ storeType: 3, town: 'Giran', title: 'Fixture need', ...point,
                    lines: [{ selfId: line.selfId, name: 'Fixture need', count: line.count, price: line.price, stackable: true,
                        intent: { itemId: line.selfId, amount: line.count, price: line.price, key: `resale:${line.selfId}`,
                            recipeId: 0, valueHours: 2, valueRate: 100 } }] }));
                const previous = (await Database.fetchAfkTradeShops(ids[side])).filter(ad => ad.kind === 'buy_ad');
                await Database.replaceBoardRecords(ids[side], 'buy_ad', configs, { expected: Object.fromEntries(previous.map(ad => [ad.id, ad.revision])) });
                const ads = await Database.fetchAfkTradeShops(ids[side]);
                for (const line of bought) { const ad = ads.find(row => row.kind === 'buy_ad' && row.lines[0].selfId === line.selfId);
                    line.needAdId = ad.id; line.needAdRevision = ad.revision; line.certificate = JSON.parse(ad.lines[0].intentJson); line.certificate[1] = line.count; line.certificate[2] = line.price; }
            }
            return lines;
        };
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20, slot: 0 });
            await Database.setItem(id, { selfId: 736, name: 'Scroll of Escape', amount: 2, slot: 0 });
            await Life.upsertState({ characterId: id, name: `Meeting${id}`, phase: 'cold', activity: 'shopping',
                level: 30, adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                loc: point, currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0], supplyErrand: { meetingToken: 'native-meeting-one' } }, timing: {} }, 'meeting_fixture');
        }
        const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
        const source = parties[1].inventory.find(row => row.selfId === 1867);
        const advertised = await Database.createAfkTradeShop(ids[1], { kind: 'sell_ad', storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: source.id, selfId: 1867, count: 20, price: 100 }] });
        const request = { token: 'native-meeting-one', actorA: ids[0], actorB: ids[1],
            seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
            lines: await certify([{ payer: 0, itemId: source.id, selfId: 1867, count: 6, price: 100,
                adId: advertised.shop.id, adRevision: advertised.shop.revision }]),
            parties: parties.map(p => ({ ...p, route: { fee: 20, scroll: true, method: 'scroll', durationMs: 25000 } })) };
        const held = async () => {
            const rows = await Database.execute([`SELECT selfId,SUM(amount) amount FROM (
                SELECT selfId,amount FROM items UNION ALL SELECT selfId,amount FROM board_settlements
                UNION ALL SELECT selfId,heldCount amount FROM board_trade_meeting_lines
                UNION ALL SELECT 57 selfId,escrowA+escrowB+routeReserveA+routeReserveB amount FROM board_trade_meetings
                UNION ALL SELECT 57 selfId,escrowAdena amount FROM afk_trade_shops
                UNION ALL SELECT l.selfId,l.count amount FROM afk_trade_lines l JOIN afk_trade_shops s ON s.id=l.shopId
                    WHERE s.storeType=1 AND s.custodyPolicy=0) GROUP BY selfId`]);
            return Object.fromEntries(rows.map(row => [row.selfId, Number(row.amount)]));
        };
        const flows = async () => { await Database.flushJournals(); await Database.flushHistory();
            return Object.fromEntries((await Database.readHistory(['SELECT selfId,SUM(delta) amount FROM economy_flow_hour GROUP BY selfId']))
                .map(row => [row.selfId, Number(row.amount)])); };
        const difference = (after, before) => Object.fromEntries([...new Set([...Object.keys(after), ...Object.keys(before)])]
            .map(key => [key, Number(after[key] || 0) - Number(before[key] || 0)]).filter(row => row[1]));
        const holdings = await held(), journal = await flows();
        // A fresh native membership wins over an earlier unassigned projection.
        for (const phase of ['cold', 'hot']) {
            await Database.execute(['UPDATE bot_life_state SET partyId=?,phase=? WHERE characterId=?', ['native-party', phase, ids[1]]]);
            assert.equal((await Database.prepareTradeParticipant(ids[1])).partyId, 'native-party');
            await assert.rejects(Database.acceptTradeMeeting(request), /party_busy/);
            assert.deepEqual(await held(), holdings, 'party rejection reserves neither goods, fare nor Adena');
        }
        await Database.execute(["UPDATE bot_life_state SET partyId=NULL,phase='cold',statsJson=json_set(statsJson,'$.playerPartyTakeover',json('{\"playerId\":9,\"partyId\":\"old-takeover\"}')) WHERE characterId=?", [ids[1]]]);
        assert.equal((await Database.prepareTradeParticipant(ids[1])).playerPartyId, 9);
        await assert.rejects(Database.acceptTradeMeeting(request), /party_busy/);
        assert.deepEqual(await held(), holdings, 'native player membership blocks custody even with no runtime session');
        const nativeTakenOver = (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [ids[1]]]))[0];
        const departedSession = { actor: { fetchId: () => ids[1] }, coldLifeState: Life.acceptLifecycleRow(nativeTakenOver) };
        const staleSoloStats = { ...departedSession.coldLifeState.stats };
        delete staleSoloStats.playerPartyTakeover;
        await Life.upsertState({ ...departedSession.coldLifeState, stats: staleSoloStats }, 'late_solo_snapshot_before_takeover');
        assert.equal((await Database.prepareTradeParticipant(ids[1])).playerPartyId, 9,
            'a late solo lifecycle snapshot cannot remove current native player ownership');
        const staleDepartureState = departedSession.coldLifeState;
        const queuedDeparture = Life.releasePlayerPartyTakeover(departedSession);
        departedSession.partyCompanion = true;
        await queuedDeparture;
        assert.equal((await Database.prepareTradeParticipant(ids[1])).playerPartyId, 9,
            'a runtime reattachment while departure is queued keeps its native admission fence');
        departedSession.partyCompanion = false;
        departedSession.coldLifeState = Life.cachedState(ids[1]);
        await Life.releasePlayerPartyTakeover(departedSession);
        assert.equal((await Database.prepareTradeParticipant(ids[1])).playerPartyId, null,
            'the departure publication clears native player ownership before fresh solo acceptance');
        assert.equal(Life.cachedState(ids[1]).stats.playerPartyTakeover, undefined);
        assert.equal(departedSession.coldLifeState.stats.playerPartyTakeover, undefined,
            'later hot/cold snapshots cannot resurrect dismissed player ownership');
        await Life.upsertState(staleDepartureState, 'late_snapshot_before_party_departure');
        assert.equal((await Database.prepareTradeParticipant(ids[1])).playerPartyId, null,
            'a late lifecycle snapshot cannot resurrect retired native player ownership');
        parties[1] = await Database.prepareTradeParticipant(ids[1]);
        request.parties[1] = { ...parties[1], route: request.parties[1].route };

        await assert.rejects(Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => false }), /preparation_changed/);
        assert.deepEqual(await held(), holdings, 'worker source invalidation after native flush moves no assets');
        for (const changed of [{ ownerId: 'stale_owner' }, { leaseId: 'stale_lease' }, { hotAt: 1 }, { revision: parties[0].revision + 1 }]) {
            const stale = { ...request, parties: request.parties.map((party, side) => side ? party : { ...party, ...changed }) };
            await assert.rejects(Database.acceptTradeMeeting(stale), /authority_changed/);
            assert.deepEqual(await held(), holdings, 'a stale owner moves no assets');
        }
        await Database.execute([`CREATE TRIGGER fail_meeting_reserve BEFORE INSERT ON board_trade_meeting_lines
            BEGIN SELECT RAISE(ABORT, 'injected meeting reserve failure'); END`]);
        try {
            await assert.rejects(Database.acceptTradeMeeting(request), /injected meeting reserve failure/);
            assert.deepEqual(await held(), holdings, 'mid-reservation failure rolls back custody and both wallets');
            const slots = await Promise.all(ids.map(actor => Database.prepareTradeParticipant(actor)));
            assert(slots.every(slot => slot.sequence === 1 && slot.meetingId === null), 'failed reserve claims neither actor');
        } finally { await Database.execute(['DROP TRIGGER fail_meeting_reserve']); }
        const attempts = await Promise.allSettled([
            Database.acceptTradeMeeting(request), Database.acceptTradeMeeting({ ...request, token: 'concurrent-other' })
        ]);
        assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1, 'one consent reserves the pair');
        assert.match(attempts.find(attempt => attempt.status === 'rejected').reason.message, /participant_changed/);
        const result = attempts.find(attempt => attempt.status === 'fulfilled').value, id = result.meeting.id;

        assert(result.pending);
        assert.deepEqual(await Database.reconcileConditionalSellAds(ids[1]), [], 'reserved meeting stock continues to back the seller advertisement');
        assert.equal((await Database.fetchAfkTradeShop(advertised.shop.id)).lines[0].count, 20);
        assert.deepEqual(result.coldLifeRows[ids[0]].acceptedIncoming, { 1867: 6 }, 'native owner slot exposes only accepted incoming trade goods');
        assert.deepEqual(result.coldLifeRows[ids[1]].acceptedIncoming, {}, 'outgoing goods and route scrolls are not incoming');
        Life.acceptLifecycleRow(result.coldLifeRows[ids[0]]);
        assert.equal(Life.cachedState(ids[0]).acceptedIncoming[1867], 6);
        assert.equal((await Database.prepareTradeParticipant(ids[0])).acceptedIncoming[1867], 6);
        assert.deepEqual(await held(), holdings, 'acceptance only moves custody');
        await Database.execute(['UPDATE bot_life_state SET partyId=? WHERE characterId=?', ['legacy-party', ids[1]]]);
        assert.equal((await Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => { throw Error('expired_worker'); } })).meeting.id, id, 'durable replay precedes expired worker preparation');
        await Database.execute(['UPDATE bot_life_state SET partyId=NULL WHERE characterId=?', [ids[1]]]);
        await assert.rejects(Database.acceptTradeMeeting({ ...request, token: 'another' }), /participant_changed|authority_changed/);
        await assert.rejects(Database.acceptTradeMeeting({ ...request, lines: [{ ...request.lines[0], count: 5 }] }), /consent_changed/);
        const bag = async owner => Object.fromEntries((await Database.fetchItems(owner)).map(row => [row.selfId, row.amount]));
        assert.equal((await bag(ids[0]))[57], 119380);
        assert.equal((await bag(ids[1]))[1867], 14);
        await Database.payTradeMeetingLeg(id, 0, 1, 'outbound', 20, true);
        await Database.payTradeMeetingLeg(id, 0, 1, 'outbound', 20, true);
        const heldAfterLeg = await held();
        const started = await Database.payTradeMeetingLeg(id, 0, 1, 'outbound', 20, true);
        const originalTravel = JSON.parse((await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [ids[0]]]))[0].statsJson).travel;
        assert(started.meeting);
        await Life.upsertState({ ...Life.cachedState(ids[0]), activity: 'fighting',
            stats: { ...Life.cachedState(ids[0]).stats, travel: null } }, 'meeting_combat_pause');
        const paused = await Database.payTradeMeetingLeg(id, 0, 1, 'outbound', 20, true);
        assert.equal(Object.keys(paused.coldLifeRows).length, 0, 'survival pauses a paid trip');
        await Life.upsertState({ ...Life.cachedState(ids[0]), activity: 'shopping' }, 'meeting_recovery');
        const resumed = await Database.payTradeMeetingLeg(id, 0, 1, 'outbound', 20, true);
        assert(resumed.coldLifeRows[ids[0]], 'lost travel state resumes at the native fence');
        Life.acceptLifecycleRow(resumed.coldLifeRows[ids[0]]);
        assert.equal(Life.cachedState(ids[0]).stats.travel.meetingId, id);
        assert.deepEqual(Life.cachedState(ids[0]).stats.travel.to, originalTravel.to);
        assert.deepEqual(await held(), heldAfterLeg, 'resuming moves no goods, money or scrolls');
        const repeated = await Database.payTradeMeetingLeg(id, 0, 1, 'outbound', 20, true);
        assert.equal(Object.keys(repeated.coldLifeRows).length, 0, 'an active travel replay does not reset arrival');

        await assert.rejects(Database.payTradeMeetingLeg(id, 0, 2, 'next', 0, false), /leg_changed/);
        await Database.acknowledgeTradeMeetingLeg(id, 0, 1);
        await assert.rejects(Database.payTradeMeetingLeg(id, 0, 1, 'outbound', 20, true), /leg_changed/);
        await Database.cancelTradeMeeting(id, 'fixture');
        await Database.cancelTradeMeeting(id, 'fixture');
        const releasedErrands = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN (?,?)', ids]);
        assert(releasedErrands.every(row => !JSON.parse(row.statsJson).supplyErrand), 'native terminal receipt releases orphan companion workflows after restart');
        for (const actor of ids) {
            await Database.settleBoardOwner(actor);
            await Database.acknowledgeTradeMeeting(id, actor);
        }
        assert.equal(await Database.fetchTradeMeeting(id), undefined);
        assert.equal((await bag(ids[0]))[57], 119980, 'only spent travel remains a sink');
        assert.equal((await bag(ids[0]))[736], 1);
        assert.equal((await bag(ids[1]))[57], 120000);
        assert.equal((await bag(ids[1]))[1867], 20);
        assert.equal((await bag(ids[1]))[736], 2);
        await assert.rejects(Database.acceptTradeMeeting(request), /participant_changed/);
        // Native item identity must match the consent, before any debit.
        const prepare = async (token, lines, routes = [{ fee: 0, scroll: false, method: 'walk', durationMs: 0 }, { fee: 0, scroll: false, method: 'walk', durationMs: 0 }]) => {
            const fresh = await Promise.all(ids.map(actor => Database.prepareTradeParticipant(actor)));
            return { token, actorA: ids[0], actorB: ids[1], seqA: fresh[0].sequence, seqB: fresh[1].sequence,
                town: 'Giran', point, lines: await certify(lines(fresh)), parties: fresh.map((party, side) => ({ ...party, route: routes[side] })) };
        };
        const sellSkin = fresh => [{ payer: 0, itemId: fresh[1].inventory.find(item => item.selfId === 1867).id,
            selfId: 1867, count: 6, price: 100 }];
        const wrong = await prepare('wrong-native-item', fresh => sellSkin(fresh).map(line => ({ ...line, itemId: fresh[1].inventory.find(item => item.selfId === 736).id })));
        await assert.rejects(Database.acceptTradeMeeting(wrong), /stock_changed/);
        assert.equal((await bag(ids[0]))[57], 119980, 'invalid native identity rolls back the debit');
        const fulfilled = await prepare('completed-meeting', sellSkin);
        const active = await Database.acceptTradeMeeting(fulfilled), completedId = active.meeting.id;
        assert.equal((await Database.fetchTradeMeetingByToken(fulfilled.token)).id, completedId, 'native consent remains available after a lost reply');
        const recovered = await Database.recoverTradeMeetings();
        assert.equal(recovered.length, 1); assert.equal(recovered[0].id, completedId);
        // Presence is authoritative: a paid traveling participant has not
        // arrived merely because its saved coordinates equal the point.
        await Life.upsertState({ ...Life.cachedState(ids[0]), activity: 'shopping', stats: { ...Life.cachedState(ids[0]).stats, travel: undefined } }, 'fixture_arrival');
        const completed = await Database.arriveTradeMeeting(completedId);
        assert.equal(completed.meeting.state, 'completed');
        assert.equal(completed.coldLifeRows[ids[0]].acceptedIncoming[1867], 6, 'terminal held goods become pending delivery, never both');
        await Database.arriveTradeMeeting(completedId);
        await Database.cancelTradeMeeting(completedId, 'late-cancel');
        for (const actor of ids) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(completedId, actor); }
        assert.equal((await Database.fetchTradeMeetingByToken(fulfilled.token)) ?? null, null, 'terminal rows are reclaimed');
        const receipt = { pending: false, meetingId: completedId, revision: completed.meeting.revision, outcome: 'completed' };
        const delivered = await Database.fetchTradeMeetingOwnerState(ids[0]);
        Life.acceptLifecycleRow(delivered);
        assert.deepEqual(Life.cachedState(ids[0]).acceptedIncoming, {}, 'physical delivery clears incoming instead of counting it twice');
        assert.equal(Life.acceptLifecycleRow(result.coldLifeRows[ids[0]]), Life.cachedState(ids[0]), 'an old acceptance reply cannot rewind delivered inventory or incoming');
        assert.deepEqual(Life.cachedState(ids[0]).acceptedIncoming, {});
        for (const actor of ids) assert.deepEqual(await Database.fetchTradeMeetingReceipt(fulfilled.token, actor), receipt,
            'a lost reply after terminal cleanup recovers the original outcome from the participant slot');
        assert.equal(await Database.fetchTradeMeetingReceipt(fulfilled.token, 999), null);
        assert.equal(await Database.fetchTradeMeetingReceipt('changed-token', ids[0]), null);
        assert.equal((await bag(ids[0]))[1867], 26);
        assert.equal((await bag(ids[1]))[1867], 14);
        assert.equal((await bag(ids[0]))[57], 119380);
        assert.equal((await bag(ids[1]))[57], 120600);
        await assert.rejects(Database.acceptTradeMeeting(fulfilled), /participant_changed/);
        // Mutual outgoing is reserved in full; expected receipts do not
        // pay a participant's current bill.
        const mutual = await prepare('mutual-completed', fresh => [
            { payer: 0, itemId: fresh[1].inventory.find(item => item.selfId === 1867).id, selfId: 1867, count: 1, price: 50 },
            { payer: 1, itemId: fresh[0].inventory.find(item => item.selfId === 1867).id, selfId: 1867, count: 2, price: 75 }]);
        const mutualId = (await Database.acceptTradeMeeting(mutual)).meeting.id;
        assert.equal((await bag(ids[0]))[57], 119330);
        assert.equal((await bag(ids[1]))[57], 120450);
        assert.equal((await Database.arriveTradeMeeting(mutualId)).meeting.state, 'completed');
        for (const actor of ids) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(mutualId, actor); }
        assert.equal((await bag(ids[0]))[57], 119480);
        assert.equal((await bag(ids[1]))[57], 120500);
        assert.equal((await bag(ids[0]))[1867], 25);
        assert.equal((await bag(ids[1]))[1867], 15);
        assert.deepEqual(difference(await held(), holdings), { 57: -20, 736: -1 });
        assert.deepEqual(difference(await flows(), journal), difference(await held(), holdings), 'every meeting move and travel sink is journalled exactly once');
        const retained = await Database.execute(['SELECT (SELECT count(*) FROM board_trade_participants) participants,(SELECT count(*) FROM board_trade_meetings) meetings,(SELECT count(*) FROM board_trade_meeting_lines) lines']);
        assert.deepEqual(retained[0], { participants: 2, meetings: 0, lines: 0 });
        const oldStock = (await Database.fetchItems(ids[0])).find(item => item.selfId === 1867);
        const oldSell = (await Database.createAfkTradeShop(ids[0], { storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: oldStock.id, selfId: 1867, name: 'Animal Skin', count: 2, price: 50, stackable: true }] })).shop;
        await Database.execute(["UPDATE afk_trade_shops SET kind='sell_ad' WHERE id=?", [oldSell.id]]);
        const oldBuy = (await Database.createAfkTradeShop(ids[0], { storeType: 3, town: 'Giran', ...point,
            lines: [{ selfId: 1864, name: 'Stem', count: 2, price: 100, stackable: true }] })).shop;
        await Database.execute(["UPDATE afk_trade_shops SET kind='buy_ad' WHERE id=?", [oldBuy.id]]);
        await Database.execute(['UPDATE afk_trade_lines SET count=5,fills=7 WHERE shopId=?', [oldBuy.id]]);
        assert.equal((await bag(ids[0]))[57], 119280);
        assert.equal((await bag(ids[0]))[1867], 23);
        assert.equal((await Database.migrateConditionalTradeAds(ids[0])).migrated, 2);
        await Database.settleBoardOwner(ids[0]);
        assert.equal((await Database.migrateConditionalTradeAds(ids[0])).migrated, 0);
        assert.equal((await bag(ids[0]))[57], 119480, 'migration returns actual held money, not count times price');
        assert.equal((await bag(ids[0]))[1867], 25);
        const migrated = await Database.fetchAfkTradeShop(oldBuy.id);
        assert.equal(migrated.custodyPolicy, 1); assert.equal(migrated.escrowAdena, 0);
        assert.equal(migrated.lines[0].id, oldBuy.lines[0].id); assert.equal(migrated.lines[0].fills, 7);
        assert.equal(migrated.lines[0].count, 5); assert.equal(migrated.lines[0].price, 100);
        assert.equal(migrated.lines[0].intentRevision, -1); assert.equal(migrated.lines[0].intentJson, null);
        assert.deepEqual(difference(await flows(), journal), difference(await held(), holdings), 'legacy custody migration is journal-neutral');
        console.log('native meeting reserve/replay/route/refund/completion/mutual/cleanup/migration conservation pass');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
