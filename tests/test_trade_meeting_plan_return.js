'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Goals = invoke('GameServer/Bot/Goals/GoalExecutor');
const ids = [730271, 730272];
const point = { locX: 83396, locY: 147904, locZ: -3400 };
const origins = [{ locX: 91819, locY: 172363, locZ: -3760 },
    { locX: 47064, locY: 147051, locZ: -3752 }];
const plans = ids.map((id, side) => ({ wishFocus: [`power:${side ? 283 : 274}:14`, 1, 0, 0, 0],
    dormantWishes: [], activityLeaf: 123 + side,
    equipmentPlan: { status: 'active', target: { selfId: side ? 283 : 274 } },
    money: [1000, 0, 0, 0] }));
const adopt = result => Object.values(result.coldLifeRows || {}).forEach(row => Life.acceptLifecycleRow(row));
const arrive = async id => {
    const state = Life.cachedState(id);
    const result = Resolver.resolveSolo({ state, spot: null, timestamp: state.stats.travel.arrivalAt });
    return Life.upsertState({ ...state, ...result.patch,
        timing: { ...state.timing, nextResolveAt: result.nextResolveAt } }, 'fixture_travel_arrival');
};
(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'meeting-plan-return');
    try {
        await Life.init();
        await Database.createAccount('bot_meeting_return', 'fixture');
        for (const [side, id] of ids.entries()) {
            await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_meeting_return', id]]);
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000 });
            await Database.setItem(id, { selfId: 1864, name: 'Stem', amount: 20 });
            await Life.upsertState({ characterId: id, name: `Return${side}`, phase: 'cold', activity: 'hunting',
                level: 30, currentRegion: `Field${side}`, loc: origins[side], adena: 120000,
                vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, stats: plans[side],
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), timing: {} }, 'return_fixture');
        }
        const accept = async token => {
            const old = (await Database.fetchAfkTradeShops(ids[0])).filter(row => row.kind === 'buy_ad');
            await Database.replaceBoardRecords(ids[0], 'buy_ad', [{ storeType: 3, town: 'Giran',
                lines: [{ selfId: 1864, name: 'Stem', count: 2, price: 100, stackable: true,
                    intent: { itemId: 1864, amount: 2, price: 100, key: 'resale:1864',
                        recipeId: 0, valueHours: 2, valueRate: 100 } }] }],
            { expected: Object.fromEntries(old.map(row => [row.id, row.revision])) });
            const ad = (await Database.fetchAfkTradeShops(ids[0])).find(row => row.kind === 'buy_ad');
            const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
            const source = parties[1].inventory.find(row => row.selfId === 1864);
            const result = await Database.acceptTradeMeeting({ token, actorA: ids[0], actorB: ids[1],
                seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
                lines: [{ payer: 0, itemId: source.id, selfId: 1864, count: 2, price: 100,
                    needAdId: ad.id, needAdRevision: ad.revision, certificate: JSON.parse(ad.lines[0].intentJson) }],
                parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })) });
            adopt(result); return result.meeting.id;
        };
        const checkPlan = (state, side) => {
            for (const key of ['wishFocus', 'dormantWishes', 'activityLeaf', 'equipmentPlan'])
                assert.deepEqual(state.stats[key], plans[side][key], `temporary meeting preserves ${key}`);
        };
        const meeting = await accept('return-completed');
        for (const [side, id] of ids.entries()) {
            assert.deepEqual(Life.cachedState(id).stats.marketReturn,
                { loc: origins[side], regionName: `Field${side}` });
            checkPlan(Life.cachedState(id), side);
            adopt(await Database.payTradeMeetingLeg(meeting, side, 1,
                `walk:${point.locX}:${point.locY}:${point.locZ}`, 0, false));
            await arrive(id);
        }
        const completed = await Database.arriveTradeMeeting(meeting);
        assert.equal(completed.meeting.state, 'completed'); adopt(completed);
        for (const [side, id] of ids.entries()) {
            await Database.settleBoardOwner(id);
            const state = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
            checkPlan(state, side);
            assert(!state.stats.tradeMeeting, 'terminal receipt releases the meeting');
            const returning = Goals.finishMarketVisit(state, Date.now());
            assert(returning, 'both buyer and seller can resume their original outing');
            assert.equal(returning.stats.travel.reason, 'return_after_market');
            assert.deepEqual(returning.stats.travel.to, origins[side]);
            await Life.upsertState(returning, 'fixture_return_start');
            const returned = await arrive(id);
            assert.equal(returned.activity, 'hunting');
            assert.deepEqual(returned.loc, origins[side]);
            assert.equal(returned.stats.marketReturn, null);
            checkPlan(returned, side);
            await Database.acknowledgeTradeMeeting(meeting, id);
        }
        // A second appointment must keep the existing outing rather than
        // making the meeting town its new hunting destination.
        const existing = { loc: { locX: 60000, locY: 150000, locZ: -3500 }, regionName: 'Original field' };
        await Life.upsertState({ ...Life.cachedState(ids[0]), stats: { ...Life.cachedState(ids[0]).stats,
            marketReturn: existing } }, 'return_already_saved');
        const cancelled = await accept('return-cancelled');
        assert.deepEqual(Life.cachedState(ids[0]).stats.marketReturn, existing);
        adopt(await Database.payTradeMeetingLeg(cancelled, 0, 1,
            `walk:${point.locX}:${point.locY}:${point.locZ}`, 0, false));
        await arrive(ids[0]);
        adopt(await Database.cancelTradeMeeting(cancelled, 'fixture_cancel'));
        const recovered = Goals.finishMarketVisit(Life.cachedState(ids[0]), Date.now());
        assert.deepEqual(recovered.stats.travel.to, existing.loc, 'cancelled detour also resumes the original outing');
        checkPlan(recovered, 0);
        for (const id of ids) {
            await Database.settleBoardOwner(id);
            Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
            await Database.acknowledgeTradeMeeting(cancelled, id);
        }
        // Acceptance can wait behind an existing trip. Its arrival clears the
        // previous outing, so meeting departure must save the reached field.
        const deferred = { ...Life.cachedState(ids[0]), activity: 'traveling',
            loc: point, stats: { ...Life.cachedState(ids[0]).stats, marketReturn: existing,
                travel: { from: point, to: origins[0], regionName: 'Field0', arrivalActivity: 'hunting',
                    reason: 'return_after_market', clearMarketReturn: true,
                    startedAt: Date.now(), arrivalAt: Date.now() + 1000 } } };
        await Life.upsertState(deferred, 'fixture_deferred_departure');
        const delayed = await accept('return-deferred');
        await arrive(ids[0]);
        assert.equal(Life.cachedState(ids[0]).stats.marketReturn, null);
        adopt(await Database.payTradeMeetingLeg(delayed, 0, 1,
            `walk:${point.locX}:${point.locY}:${point.locZ}`, 0, false));
        assert.deepEqual(Life.cachedState(ids[0]).stats.marketReturn.loc, origins[0],
            'the meeting departing after the old trip saves the actual reached field');
        await arrive(ids[0]);
        adopt(await Database.cancelTradeMeeting(delayed, 'fixture_cancel'));
        for (const id of ids) {
            await Database.settleBoardOwner(id);
            Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
            await Database.acknowledgeTradeMeeting(delayed, id);
        }
        // A leg that starts while the return trip is still on the row replaces that trip:
        // the meeting's arrival keeps the outing's return, and the visit's end goes back.
        const overtaken = { ...Life.cachedState(ids[0]), activity: 'traveling',
            loc: point, stats: { ...Life.cachedState(ids[0]).stats, marketReturn: existing,
                travel: { from: point, to: origins[0], regionName: 'Field0', arrivalActivity: 'hunting',
                    reason: 'return_after_market', clearMarketReturn: true,
                    startedAt: Date.now(), arrivalAt: Date.now() + 60000 } } };
        await Life.upsertState(overtaken, 'fixture_overtaken_return');
        const overtaking = await accept('return-overtaken');
        adopt(await Database.payTradeMeetingLeg(overtaking, 0, 1,
            `walk:${point.locX}:${point.locY}:${point.locZ}`, 0, false));
        const atMeeting = await arrive(ids[0]);
        assert.equal(atMeeting.activity, 'shopping');
        assert.deepEqual(atMeeting.stats.marketReturn, existing, 'the meeting keeps the outing the return trip was going to');
        adopt(await Database.cancelTradeMeeting(overtaking, 'fixture_cancel'));
        const back = Goals.finishMarketVisit(Life.cachedState(ids[0]), Date.now());
        assert.equal(back?.stats.travel.reason, 'return_after_market', 'the visit after the meeting returns to the field');
        assert.deepEqual(back.stats.travel.to, existing.loc);
        console.log('PASS native buyer/seller meeting completion, original plan, return travel and cancellation recovery');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
