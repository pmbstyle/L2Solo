// The mind (SavedStats.MIND_KEYS: the worker's decision, its money packet) is
// saved in its own column. A far commit refused on its revision writes
// nothing, the mind included; main's saves write the mind of a near bot, and of a far
// bot only when built on the row's revision (an older copy never writes over
// the worker's); the clan goal member repair writes the body only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Data = invoke('GameServer/DataCache');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-mind-column-'));
const ACCOUNT = 'bot_mind_column';
const OLD_MONEY = [77000, 0, 15000, 0];
const NEW_MONEY = [88000, 0, 16000, 0];
let sequence = 0;

async function create(phase, stats = {}) {
    const name = `MindColumn${++sequence}`;
    const id = Number((await Database.createCharacter(ACCOUNT, { name,
        race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 1, locY: 1, locZ: 0 })).insertId);
    await Life.upsertState(fixtureState(id, name, phase, stats), 'mind_column_fixture');
    return id;
}
function fixtureState(id, name, phase, stats, activity = 'resting') {
    return { characterId: id, accountName: ACCOUNT, name,
        phase, activity, level: 1, inventory: {}, stats: { classId: 0, generatedCold: true, ...stats },
        loc: { locX: 1, locY: 1, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        timing: { nextResolveAt: Date.now() + 86400000 } };
}
async function row(id) {
    return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
}
async function bodyMoney(id) {
    return (await Database.execute(["SELECT json_extract(statsJson,'$.money') AS money FROM bot_life_state WHERE characterId=?", [id]]))[0].money;
}

(async () => {
    try {
        options.default.Database.path = path.join(directory, 'world.sqlite');
        options.default.Database.historyPath = path.join(directory, 'history.sqlite');
        Config.knowledgeErrorsEnabled = false;
        await new Promise(resolve => Database.init(resolve));
        Data.init();
        await Database.createAccount(ACCOUNT, 'fixture');
        await Life.init();

        // (1) A far commit refused on its revision writes nothing: no body
        // column, no mind, no revision move. It hands back the row as it is,
        // and a main save built on the row's revision then writes its own mind.
        const far = await create('cold', { money: OLD_MONEY });
        const stepRevision = Life.cachedState(far).simulation.revision;
        const proposed = { ...Life.cachedState(far),
            stats: { ...Life.cachedState(far).stats, proposalProbe: true, money: NEW_MONEY } };
        await Database.updateGeneratedBotName(far, 'MindRenamed', 3);
        const mainCopy1 = Life.cachedState(far);
        const before = await row(far);
        const [refused] = await Owner.commitBatch([{ revision: stepRevision, nextState: proposed,
            proposal: { revision: stepRevision } }]);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, 'stale_revision', 'the proposal built before the main write is refused');
        const after = await row(far);
        assert.equal(after.simulationRevision, before.simulationRevision, 'the refused commit leaves the revision');
        assert.equal(after.statsJson, before.statsJson, 'the refused commit leaves the body');
        assert.equal(after.activity, before.activity, 'the refused commit leaves the activity');
        assert.equal(after.mindJson, before.mindJson, 'a refused commit writes nothing, the mind included');
        assert.equal(refused.row.mindJson, before.mindJson, 'the refusal hands back the row with the mind it had');
        // A main save built on the row's revision writes its own mind; nothing
        // of the refused proposal is on the row or in main's cache.
        const MAIN_MONEY = [77000, 0, 15000, 0];
        await Life.upsertState({ ...mainCopy1, stats: { ...mainCopy1.stats, money: MAIN_MONEY } }, 'mind_column_refused_main_save');
        const resaved = await row(far);
        assert.deepEqual(JSON.parse(resaved.mindJson).money, MAIN_MONEY, 'the row holds main\'s mind after its save');
        assert.equal(resaved.mindJson.includes(String(NEW_MONEY[0])), false, 'no mind value of the refused proposal is on the row');
        assert.deepEqual(Life.cachedState(far).stats.money, MAIN_MONEY, 'main\'s cache holds main\'s mind, none of the refused one');
        assert.equal(Life.cachedState(far).stats.proposalProbe, undefined, 'main\'s cache holds none of the refused proposal');

        // (2) A near bot's save writes its money into the mind column, not the body.
        const near = await create('hot', { money: OLD_MONEY });
        assert.deepEqual(JSON.parse((await row(near)).mindJson).money, OLD_MONEY, 'the first save writes the mind');
        assert.equal(await bodyMoney(near), null, 'the body holds no money');
        await Life.upsertState(fixtureState(near, 'MindColumn2', 'hot', { money: NEW_MONEY }), 'mind_column_near');
        assert.deepEqual(JSON.parse((await row(near)).mindJson).money, NEW_MONEY, 'a hot save writes the new mind');
        assert.equal(await bodyMoney(near), null, 'the body still holds no money');
        // The woken decisions (Situations' store) are the mind's too.
        const STORE = { woken: 1, waiting: 256, situationSeq: 4 };
        await Life.upsertState(fixtureState(near, 'MindColumn2', 'hot', { money: NEW_MONEY, ...STORE }), 'mind_column_store');
        const stored = await row(near), storedMind = JSON.parse(stored.mindJson), storedBody = JSON.parse(stored.statsJson);
        assert.deepEqual([storedMind.woken, storedMind.waiting, storedMind.situationSeq], [1, 256, 4], 'the store is saved in the mind');
        assert.equal(['woken', 'waiting', 'situationSeq'].some(key => Object.hasOwn(storedBody, key)), false, 'not in the body');
        // The hot->cold hand-off carries main's mind into the far row.
        const HANDOFF_MONEY = [99000, 0, 17000, 0];
        await Life.upsertState(fixtureState(near, 'MindColumn2', 'cold', { money: HANDOFF_MONEY }), 'mind_column_handoff',
            { releaseHot: true });
        const handedOff = await row(near);
        assert.equal(handedOff.phase, 'cold', 'fixture: the row is handed to the worker');
        assert.deepEqual(JSON.parse(handedOff.mindJson).money, HANDOFF_MONEY, 'the hand-off writes main\'s mind');

        // (3) A main save over a far row writes the body but keeps the row's
        // mind: the worker's newer mind is not written back with main's copy.
        const cold = await create('cold', { money: OLD_MONEY });
        const mainCopy = fixtureState(cold, 'MindColumn3', 'cold', { money: OLD_MONEY }, 'trading');
        const coldRevision = Life.cachedState(cold).simulation.revision;
        const decided = { ...Life.cachedState(cold), stats: { ...Life.cachedState(cold).stats, money: NEW_MONEY } };
        const [committed] = await Owner.commitBatch([{ revision: coldRevision, nextState: decided,
            proposal: { revision: coldRevision } }]);
        assert.equal(committed.ok, true, `the worker's commit lands: ${committed.reason}`);
        assert.deepEqual(JSON.parse((await row(cold)).mindJson).money, NEW_MONEY, 'fixture: the worker wrote its mind');
        await Life.upsertState(mainCopy, 'mind_column_main_save');
        const saved = await row(cold);
        assert.equal(saved.activity, 'trading', 'the main save writes the body');
        assert.deepEqual(JSON.parse(saved.mindJson).money, NEW_MONEY, 'the main save keeps the far row\'s mind');
        assert.deepEqual(Life.cachedState(cold).stats.money, NEW_MONEY, 'main\'s cache takes the far row\'s mind back');
        // A main save built on the row's revision (a worker packet main
        // applies for a lifecycle step) writes its mind into the far row.
        const APPLIED_MONEY = [66000, 0, 14000, 0];
        const current = Life.cachedState(cold);
        await Life.upsertState({ ...current, stats: { ...current.stats, money: APPLIED_MONEY } }, 'mind_column_applied');
        assert.deepEqual(JSON.parse((await row(cold)).mindJson).money, APPLIED_MONEY, 'a save on the row\'s revision writes its mind');
        assert.deepEqual(Life.cachedState(cold).stats.money, APPLIED_MONEY, 'main\'s cache keeps the applied mind');

        // (4) The clan goal member repair writes the body and leaves the mind.
        const member = await create('cold', { money: NEW_MONEY });
        const memberBefore = await row(member);
        const written = await Database.writeClanGoalMember(member, 'resting',
            JSON.stringify({ classId: 0, generatedCold: true, goalRepairProbe: true }), Number(memberBefore.simulationRevision));
        assert.equal(written.repairedMembers, 1, 'the goal write lands on the revision read');
        const memberAfter = await row(member);
        assert.equal(JSON.parse(memberAfter.statsJson).goalRepairProbe, true, 'the goal write writes the body');
        assert.equal(memberAfter.mindJson, memberBefore.mindJson, 'the goal write leaves the mind');

        // (5) Main's raise on a far row (BotLifeState.raiseOnRow) survives a worker
        // commit in flight: the commit built before it is refused and the bits stay;
        // main's whole-row save of an older copy keeps them too.
        const raisedId = await create('cold', { money: OLD_MONEY, woken: 0, activityLeaf: 5 });
        const inFlight = Life.cachedState(raisedId), flightRevision = inFlight.simulation.revision;
        const raised = await Life.raiseOnRow(raisedId, [{ name: 'goal_failed', payload: { impossible: true } }], 'mind_column_raise');
        assert(raised && raised.simulation.revision > flightRevision, 'the raise moves the far revision');
        const [late] = await Owner.commitBatch([{ revision: flightRevision, proposal: { revision: flightRevision },
            nextState: { ...inFlight, stats: { ...inFlight.stats, money: NEW_MONEY, woken: 0 } } }]);
        assert.equal(late.reason, 'stale_revision', 'the worker commit begun before the raise is refused');
        await Life.upsertState(fixtureState(raisedId, 'MindColumn5', 'cold', { money: OLD_MONEY, woken: 0 }), 'mind_column_old_copy');
        const raisedMind = JSON.parse((await row(raisedId)).mindJson);
        assert(raisedMind.woken & 2, 'the raised bits stay on the row');
        assert.equal(raisedMind.activityLeaf, 0, 'and its impossible mark dropped the held step');
        assert.equal(raisedMind.situationSeq, 1, 'one raise');
        assert.equal(await Life.raiseOnRow(await create('hot'), [{ name: 'goal_failed' }]), null, 'a row that is not far takes no row raise');
        // A raise whose only effect is a member's stay writes nothing on a solo row: the
        // revision stays, no worker step is refused.
        const quietRevision = (await row(raisedId)).simulationRevision;
        assert(await Life.raiseOnRow(raisedId, [{ name: 'party_outleveled' }]), 'a stay-only raise on a solo row lands');
        assert.equal((await row(raisedId)).simulationRevision, quietRevision, 'and moves no revision on a solo row');
        // The facts a raise carries land in the mind with its bits (situations.md B6): a spot the body could not
        // reach is marked, and a player's command is the held earning answer, decided as its caller: the bit its
        // move woke and one waiting for a stop both cleared.
        await Life.raiseOnRow(raisedId, [{ name: 'spot_unreachable', payload: { spotId: 'far', reason: 'walk_timeout' } }]);
        let factMind = JSON.parse((await row(raisedId)).mindJson);
        assert.deepEqual(factMind.spotMarks.map(mark => [mark.spotId, mark.reason]), [['far', 'walk_timeout']],
            'the unreachable spot is marked on the row');
        assert(factMind.woken & 1, 'and it woke the earning spot');
        // A raise that adds no bit writes nothing (the same walk failed again on a spot
        // already marked): the revision stays.
        const markedRevision = (await row(raisedId)).simulationRevision;
        const sameWalk = { spotId: 'far', reason: 'walk_timeout' };
        const again = await Life.raiseOnRow(raisedId, [{ name: 'spot_unreachable', payload: sameWalk }]);
        assert(again, 'a raise that adds nothing still lands');
        assert.equal((await row(raisedId)).simulationRevision, markedRevision, 'and moves no revision');
        const Situations = invoke('GameServer/Bot/Situations');
        const takenBefore = Situations.counts().decided.earning_spot?.[0] || 0;
        await Life.raiseOnRow(raisedId, [{ name: 'grade_changed' }, { name: 'moved_by_world' },
            { name: 'player_command', payload: { spotId: 'near', at: 5 } }]);
        factMind = JSON.parse((await row(raisedId)).mindJson);
        assert.equal(factMind.earning.spotId, 'near', 'a command is the held answer');
        assert.equal(factMind.woken & 1, 0, 'and it took the earning spot\'s bit');
        assert.equal(factMind.waiting & (1 | 1 << 8), 0, 'on every waiting plane too');
        assert.equal(Situations.counts().decided.earning_spot[0], takenBefore + 1, 'counted as a decision taken');
        // A rejection whose row is not far and whose body is not in the world is counted, not lost silently.
        const Events = invoke('GameServer/Bot/AI/DecisionEvents'), FailureLog = require('../src/FailureLog');
        const lostBefore = FailureLog.snapshot()?.['situations.raise_lost'] || 0;
        const gone = Life.cachedState(await create('hot'));
        await Events.rejectOnRow(gone, gone, 'mind_column');
        assert.equal(FailureLog.snapshot()?.['situations.raise_lost'], lostBefore + 1, 'a raise that lands nowhere is counted');
        console.log('PASS the mind column: refused far commits write nothing, main saves write a far row\'s only on its revision');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
