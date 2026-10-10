'use strict';
// Task 4 B5 N12 (E169 race): a trade meeting acceptance and a party join for the
// same bot are started together, in both orders. Exactly one wins; the losing side
// is refused (party_busy / party_trade_busy) and moves no goods, Adena or journal rows.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const ids = [730291, 730292, 730293, 730294, 730295, 730296, 730297, 730298, 730299], point = { locX: 83396, locY: 147904, locZ: -3400 };
(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'b5-party-race');
    try {
        await Database.createAccount('bot_b5_party_race', 'test');
        await Database.execute([`UPDATE characters SET username='bot_b5_party_race' WHERE id IN (${ids.map(() => '?')})`, ids]);
        await Life.init();
        assert.equal(await PartyState.init(), true);
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 100, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
                adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: point,
                currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        const held = async () => {
            const rows = await Database.execute([`SELECT selfId,SUM(amount) amount FROM (
                SELECT selfId,amount FROM items UNION ALL SELECT selfId,amount FROM board_settlements
                UNION ALL SELECT selfId,heldCount amount FROM board_trade_meeting_lines
                UNION ALL SELECT 57 selfId,escrowA+escrowB+routeReserveA+routeReserveB amount FROM board_trade_meetings
                UNION ALL SELECT 57 selfId,escrowAdena amount FROM afk_trade_shops) GROUP BY selfId`]);
            return Object.fromEntries(rows.map(row => [row.selfId, Number(row.amount)]));
        };
        const flows = async () => { await Database.flushJournals(); await Database.flushHistory();
            return Object.fromEntries((await Database.readHistory(['SELECT selfId,SUM(delta) amount FROM economy_flow_hour GROUP BY selfId']))
                .map(row => [row.selfId, Number(row.amount)])); };
        const bag = async id => Object.fromEntries((await Database.fetchItems(id)).map(row => [row.selfId, row.amount]));
        // buyer, seller (joins the party), partner (party leader).
        // order: 'accept,join' and 'join,accept' start both in one tick; 'accept,tick,join' starts the
        // join one macrotask later, after the acceptance flush queued its transaction.
        const scenario = async ([buyer, seller, partner], order) => {
            const parties = await Promise.all([buyer, seller].map(id => Database.prepareTradeParticipant(id)));
            const request = { token: `race-${seller}`, actorA: buyer, actorB: seller, seqA: parties[0].sequence, seqB: parties[1].sequence,
                town: 'Giran', point, lines: [{ payer: 0, itemId: parties[1].inventory.find(row => row.selfId === 1867).id, selfId: 1867,
                    count: 2, price: 100, certificate: Intent.encode({ itemId: 1867, amount: 2, price: 100, key: 'resale:1867',
                        recipeId: 0, valueHours: 2, valueRate: 100 }) }],
                parties: parties.map(p => ({ ...p, route: { fee: 20, scroll: false, method: 'walk', durationMs: 100 } })) };
            const members = await Life.statesByIds([partner, seller], { ownerId: 'legacy_main', unassigned: true });
            const due = Date.now() + 45000, partyId = `b5_race_${seller}`;
            const party = PartyState.prepareCommit({ partyId, leaderId: partner, memberIds: [partner, seller], spotId: 'cruma',
                nextResolveAt: due, status: 'active', roleCoverage: { tank: 1, healer: 1 },
                stats: { objective: { objectiveKey: 'direct_drop:cruma:701', spotId: 'cruma' } } });
            const assignments = members.map(member => Life.preparePartyAssignment(member, partyId,
                member.characterId === partner ? 'tank' : 'healer', partner, due));
            const holdings = await held(), journal = await flows(), sellerBag = await bag(seller), buyerBag = await bag(buyer);
            const accept = () => Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => true });
            const join = () => Database.commitBackgroundPartyMembership({ party: party.row, members: assignments });
            const later = () => new Promise(resolve => setImmediate(resolve)).then(join);
            const [accepted, joined] = order === 'join,accept' ? (await Promise.allSettled([join(), accept()])).reverse()
                : await Promise.allSettled([accept(), order === 'accept,join' ? join() : later()]);
            const acceptWon = accepted.status === 'fulfilled', joinWon = joined.status === 'fulfilled' && joined.value?.ok === true;
            assert.equal(Number(acceptWon) + Number(joinWon), 1, `exactly one wins (${order}): accept=${accepted.status}/${accepted.reason?.message} join=${JSON.stringify(joined.value || joined.reason?.message)}`);
            const count = async () => [(await Database.execute(['SELECT COUNT(*) n FROM bot_background_parties WHERE partyId=?', [partyId]]))[0].n,
                (await Database.execute(['SELECT COUNT(*) n FROM bot_life_state WHERE partyId=?', [partyId]]))[0].n];
            const meetings = (await Database.execute(['SELECT COUNT(*) n FROM board_trade_meetings WHERE token=?', [request.token]]))[0].n;
            assert.deepEqual(await held(), holdings, 'neither side creates or destroys goods or Adena');
            if (joinWon) {
                assert.match(accepted.reason.message, /party_busy/, 'trade side refuses the new party member');
                assert.equal(meetings, 0, 'refused trade leaves no meeting');
                assert.deepEqual(await bag(seller), sellerBag, 'refused trade leaves the seller bag unchanged');
                assert.deepEqual(await bag(buyer), buyerBag, 'refused trade leaves the buyer bag unchanged');
                assert.deepEqual(await flows(), journal, 'refused trade writes no economy flow');
                assert.deepEqual(await count(), [1, 2]);
            } else {
                // The acceptance rewrites both life rows, so the join prepared before it is stale first
                // (membership_conflict); a join re-prepared from fresh rows meets the trade fence itself.
                assert.match(String(joined.value?.reason), /^(membership_conflict|party_trade_busy)$/, 'party side refuses the race loser');
                const fresh = (await Life.statesByIds([partner, seller], { ownerId: 'legacy_main', unassigned: true }))
                    .map(member => Life.preparePartyAssignment(member, partyId, member.characterId === partner ? 'tank' : 'healer', partner, due));
                const retried = await Database.commitBackgroundPartyMembership({ party: party.row, members: fresh });
                assert.equal(retried.reason, 'party_trade_busy', 'a fresh join is refused for the trade-busy bot');
                assert.deepEqual(retried.conflicts, [seller], 'only the meeting member is fenced');
                assert.deepEqual(await count(), [0, 0], 'refused join leaves no party row and assigns no member');
                assert.deepEqual(await held(), holdings, 'refused join moves no goods or Adena');
                assert.equal(meetings, 1);
            }
            return joinWon ? 'join' : 'accept';
        };
        const winners = {};
        for (const [index, order] of ['accept,join', 'join,accept', 'accept,tick,join'].entries()) {
            winners[order] = await scenario(ids.slice(index * 3, index * 3 + 3), order);
        }
        assert.deepEqual(new Set(Object.values(winners)), new Set(['join', 'accept']), `both refusal directions exercised: ${JSON.stringify(winners)}`);
        console.log(`PASS task4 b5 N12: ${JSON.stringify(winners)}; one winner each, loser refused, no side effect`);
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
