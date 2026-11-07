// T189: a review's agenda, through the build and the step's own question. Leaves are
// built by the real wish network on a real board; no plan is written by hand.
'use strict';
const assert = require('node:assert/strict');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('./helpers/databaseIsolation');
require('../src/Global');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');

async function run() {
    const Data = invoke('GameServer/DataCache'); Data.init();
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    // A review's stock is two items, shots and potions, whatever potion use a table
    // rebuild measures (bots that rest drink none): the canonical table with its fighters
    // drinking a bottle every twenty kills. Shots stand second when a review rolls the
    // potions first, and gear follows both.
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const canonical = JSON.parse(fs.readFileSync(Table.DEFAULT_FILE, 'utf8')), potions = canonical.rowFields.indexOf('potions');
    const tableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-')), tableFile = path.join(tableDir, 'potion-table.json');
    process.on('exit', () => fs.rmSync(tableDir, { recursive: true, force: true }));
    fs.writeFileSync(tableFile, JSON.stringify({ ...canonical,
        rows: canonical.rows.map(rows => rows.map(row => row && row.map((value, at) => at === potions ? .05 : value))) }));
    Table.useFile(tableFile);
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex;
    const board = new Board();
    const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    Economy.configure({ board: () => board, spots: () => spots });
    Config.knowledgeErrorsEnabled = false;
    const T = Date.now();
    const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
    // A step a second later: a review stamps its baseline then (its at), a move of the
    // agenda keeps the review's.
    const later = () => ({ ...deps(), timestamp: T + 1000 });
    const deps = () => ({ timestamp: T, memoryIdentity: 'fixture-memory', sourceReady: true, caller: 'step', routeRows: Trip.prepared(base), routeKey: Trip.key(base) });
    const base = { characterId: 901, phase: 'cold', activity: 'shopping', level: 35, adena: 5000000,
        inventory: { 5285: { selfId: 5285, amount: 1, equipped: true, equippedCount: 1, slot: 14 } },
        loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    let line = 1;
    const sell = (selfId, count, price, town = 'Giran') => {
        const id = 1000 + line;
        board.put({ id, ownerId: 5000 + line, storeType: 1, kind: 'shop', town, revision: 1, lines: [{ lineId: 2000 + line++, selfId, count, price }] });
        return id;
    };
    // Shots at half a D-grade soulshot's usual board price: a unit's worth beats a gear
    // piece's priority on any table, so the shots' steps come first.
    const SHOTS = 1463, POTIONS = 1061;
    sell(SHOTS, 5000, 6); sell(POTIONS, 50, 120);
    // One bot's review on a visit and the state its plan was published on.
    let nextId = 9000;
    const review = (over = {}) => {
        const characterId = nextId++;
        const state = { ...base, characterId, ...over, stats: { ...base.stats, ...over.stats } };
        const plan = Economy.forState(state, deps());
        return { plan, state: { ...state, stats: { ...state.stats, ...plan.statsPacket } } };
    };
    const clear = id => { for (const row of board.list(id, 1)) board.remove(row.recordId); };
    // The review keeps the step the bot was on: shots come first, potions after them.
    const Network = invoke('GameServer/Bot/Economy/WishNetwork');
    const shotsFirst = (over = {}) => {
        const first = review(over), { plan } = first, later = plan.network.agenda.find(step => step.itemId === SHOTS);
        if (plan.network.activity?.itemId === SHOTS) return first;
        return review({ ...over, stats: { ...over.stats, decisionSeq: 5, activityLeaf: Network.leafId(later), wishFocus: plan.statsPacket.wishFocus } });
    };
    // A bot with its potion stock full (the stock's own target): the shots' steps follow
    // each other, whatever potion use the table gives it.
    const stocked = (inventory = {}) => ({ inventory: { ...base.inventory,
        [POTIONS]: { selfId: POTIONS, amount: Economy.basics(base, deps()).stock('potions').target }, ...inventory } });
    const bought = (state, leaf, units = leaf.amount) => ({ ...state, adena: state.adena - units * leaf.unitPrice, inventory: { ...state.inventory,
        [leaf.itemId]: { selfId: leaf.itemId, amount: Number(state.inventory[leaf.itemId]?.amount || 0) + units } } });

    { // A filled step takes the next one with no build, its focus and queue moving with it.
        const { plan, state } = review();
        const first = plan.network.activity;
        assert.equal(first.kind, 'buy', 'fixture: the review chose a purchase');
        assert(plan.network.agenda.length > 0, 'fixture: the review decided a second step');
        const second = plan.network.agenda[0];
        assert.notEqual(second.itemId, first.itemId, 'each item stands once');
        // It bought the step and wore it: a weapon in its hands for the one it had.
        const worn = (({ 5285: had, ...rest }) => ({ ...bought(state, first), inventory: { ...rest,
            2499: { ...had, selfId: 2499 } } }))(bought(state, first).inventory);
        const next = Economy.forState(worn, later());
        assert.equal(next.network.activity.itemId, second.itemId, 'the bot works down its agenda');
        assert.equal(next.statsPacket.decisionSeq, plan.statsPacket.decisionSeq + 1, 'one more step of one decision');
        assert.equal(next.statsPacket.wishSections.at, T, 'its baseline stands: one review');
        // What the step bought is the review's own answer: the baseline holds the bot as it
        // is now, so the field reads no change of its stock or gear later.
        const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
        assert.equal(next.statsPacket.wishSections.gear, Sections.semanticFacts(worn).gear, 'its facts are the bot\'s now');
        assert.notEqual(next.statsPacket.wishSections.gear, plan.statsPacket.wishSections.gear, 'fixture: the gear changed');
        assert.equal(next.network.queue.some(wish => wish.key === first.rootKey), false, 'what was bought left the money queue');
    }
    { // A step's count is taken at the build: what arrived on the way is its progress.
        // Shots and potions are weighed alike with the gear (A5): the first kit kind among the later steps,
        // every step before it bought.
        let found = null, ITEM = 0, shots = null, first = null;
        for (let tries = 0; tries < 40 && !found; tries++) {
            const row = review({ inventory: { ...base.inventory, [SHOTS]: { selfId: SHOTS, amount: 2 }, [POTIONS]: { selfId: POTIONS, amount: 2 } } });
            const steps = [row.plan.network.activity, ...(row.plan.network.agenda || [])];
            const at = steps.findIndex((step, index) => index > 0 && [SHOTS, POTIONS].includes(step?.itemId));
            if (at > 0) {
                found = row; shots = steps[at]; ITEM = shots.itemId;
                first = steps.slice(0, at).reduce((state, step) => bought(state, step), row.state);
            }
        }
        assert(found, 'fixture: a kit kind is a later step of some review');
        assert.equal(shots.heldAtDecision, 2, 'the step keeps the bag it was counted on');
        const part = Math.floor(shots.amount / 2);
        // The visit's bought steps end (goal_done:visit woke the build): its agenda moves to the step.
        const next = Economy.forState({ ...first, inventory: { ...first.inventory, [ITEM]: { selfId: ITEM, amount: 2 + part } } }, deps());
        assert.equal(next.network.activity.itemId, ITEM);
        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        assert.equal(Decision.remainingToOrder(next.network.activity, { ...first, inventory: { ...first.inventory, [ITEM]: { selfId: ITEM, amount: 2 + part } } }), shots.amount - part,
            'what reached the bag since the review is not bought again');
        // The whole step in the bag: the agenda moves on, to the next seller of what it still wants.
        const whole = Economy.forState({ ...first, inventory: { ...first.inventory, [ITEM]: { selfId: ITEM, amount: 2 + shots.amount } } }, deps());
        const rest = Number(shots.wanted || shots.amount) - shots.amount;
        if (rest > 0) assert.deepEqual([whole.network.activity?.itemId, whole.network.activity?.amount], [ITEM, rest], 'its rest from the next seller');
        else assert.notEqual(whole.network.activity?.itemId, ITEM, 'a step that arrived drops');
    }
    { // A seller that fell short: the next seller of the town, up to the value per unit.
        const bid = { status: 'deferred', reason: 'wish_focus', target: { selfId: 1 } };
        clear(SHOTS);
        let thin = sell(SHOTS, 1, 4);
        const fairLine = sell(SHOTS, 5000, 6);
        const dear = shotsFirst({ ...stocked(), stats: { equipmentPlan: bid } }), leaf = dear.plan.network.activity;
        assert.equal(leaf.amount, 1, 'fixture: the cheapest seller holds one');
        assert(leaf.wanted > 1, 'fixture: the bot wanted more of it');
        board.remove(thin); board.remove(fairLine); sell(SHOTS, 5000, 100000);
        const stopped = Economy.forState(bought(dear.state, leaf), deps());
        assert.notEqual(stopped.network.activity?.itemId, SHOTS, 'a dearer seller stops at the value per unit');
        const before = dear.plan.watchList.find(row => row.itemId === SHOTS)?.amount;
        assert.equal(stopped.watchList.find(row => row.itemId === SHOTS)?.amount, before - 1, 'filled goods left the bids a re-projection read');
        clear(SHOTS); thin = sell(SHOTS, 1, 4); sell(SHOTS, 5000, 5);
        const fair = shotsFirst(stocked()), one = fair.plan.network.activity;
        board.remove(thin);
        const moved = Economy.forState(bought(fair.state, one), deps()), next = moved.network.activity;
        assert.deepEqual([next.itemId, next.amount, next.unitPrice], [SHOTS, one.wanted - 1, 5], 'the next seller takes the rest');
        const bids = view => view.watchList.find(row => row.itemId === SHOTS)?.amount ?? 0;
        assert.equal(bids(moved), Math.max(0, fair.plan.watchList.find(row => row.itemId === SHOTS).amount - 1), 'one step left the bids once');
        const second = Economy.forState(bought(bought(fair.state, one), next), deps());
        assert.equal(bids(second), Math.max(0, fair.plan.watchList.find(row => row.itemId === SHOTS).amount - 1 - next.amount), 'two steps, each once');
        assert.equal(invoke('GameServer/Bot/Economy/Agenda').bidsAfter([{ itemId: SHOTS, amount: 5, retainedProject: true }], [[SHOTS, 2]])[0].amount, 5,
            'a retained project reads today\'s bag, the goods are counted there');
        assert.equal(invoke('GameServer/Bot/Population/ColdEconomyDecision').remainingToOrder(next, bought(fair.state, one)), one.wanted - 1,
            'nothing it bought is ordered again');
        clear(SHOTS); sell(SHOTS, 5000, 6);
    }
    { // A bot that held some at its decision: the next seller counts from the bag it holds now.
        clear(SHOTS); const thin = sell(SHOTS, 1, 4); sell(SHOTS, 5000, 5);
        const fair = shotsFirst(stocked({ [SHOTS]: { selfId: SHOTS, amount: 3 } })), one = fair.plan.network.activity;
        assert.deepEqual([one.itemId, one.amount], [SHOTS, 1], 'fixture: the cheapest seller holds one');
        assert(one.wanted > 4, 'fixture: the bot wants more than it held');
        board.remove(thin);
        const after = bought(fair.state, one), next = Economy.forState(after, deps()).network.activity;
        assert.equal(next?.itemId, SHOTS, 'the next seller takes the rest');
        assert.equal(invoke('GameServer/Bot/Population/ColdEconomyDecision').remainingToOrder(next, after), one.wanted - 1,
            'what the bot held before is no progress of the next seller');
        clear(SHOTS); sell(SHOTS, 5000, 6);
    }
    { // A seller lost after a part: the part leaves the bids once, the next seller takes the rest.
        clear(SHOTS); const part = 15, short = sell(SHOTS, 40, 4); sell(SHOTS, 5000, 5);
        const fair = shotsFirst(stocked()), one = fair.plan.network.activity;
        assert.deepEqual([one.itemId, one.amount], [SHOTS, 40], 'fixture: the cheapest seller holds 40');
        assert(one.wanted > 40, 'fixture: the bot wants more than that seller has');
        board.remove(short);
        const next = Economy.forState(bought(fair.state, one, part), deps());
        assert.deepEqual([next.network.activity?.itemId, next.network.activity?.amount], [SHOTS, one.wanted - part], 'the next seller takes the rest');
        const bids = view => view.watchList.find(row => row.itemId === SHOTS)?.amount ?? 0;
        assert.equal(bids(next), Math.max(0, bids(fair.plan) - part), 'what the bot bought is bid for no more');
        clear(SHOTS); sell(SHOTS, 5000, 6);
    }
    { // A step pays its trip: one unit elsewhere is not worth the road.
        const { plan, state } = shotsFirst();
        assert.equal(plan.network.activity.itemId, SHOTS, 'fixture: shots are the step');
        clear(SHOTS);
        const lone = sell(SHOTS, 1, 5, 'Dion');
        const next = Economy.forState(state, deps()).network.activity;
        assert(next?.itemId !== SHOTS || next.town !== 'Dion', 'the road costs more than the unit brings');
        board.remove(lone); sell(SHOTS, 5000, 6);
    }
    { // A seller lost: the next one elsewhere, after what this town still has.
        const { plan, state } = shotsFirst();
        assert.equal(plan.network.activity.itemId, SHOTS, 'fixture: shots are the step');
        clear(SHOTS);
        const away = sell(SHOTS, 5000, 5, 'Dion');
        const next = Economy.forState(state, deps()).network;
        assert.equal(next.activity.itemId, plan.network.agenda[0].itemId, 'this town goes first');
        const seller = next.agenda.find(step => step.itemId === SHOTS);
        assert.equal(seller?.town, 'Dion', 'the lost item waits at its next seller');
        assert.equal(next.agenda.findIndex(step => step.town !== 'Giran'), next.agenda.indexOf(seller), 'the trip comes after this town');
        board.remove(away); sell(SHOTS, 5000, 6);
    }
    { // A tight purse is read by the step's place in the money queue.
        const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
        const { plan } = review();
        const steps = [plan.network.activity, ...plan.network.agenda];
        const cost = steps.reduce((sum, step) => sum + step.price, 0);
        const reserve = Packet.refillReserve(plan.statsPacket.money);
        const tight = review({ adena: reserve + cost + 1 });
        const first = tight.plan.network.activity;
        assert(tight.plan.network.agenda.length > 0, 'fixture: the steps are funded');
        const noRow = tight.state.stats.money.map((value, at) => at >= 6 && (at - 6) % 3 === 0 ? 0 : value);
        const material = Economy.forState({ ...tight.state, stats: { ...tight.state.stats, money: noRow } }, { ...deps(), decide: false });
        assert.equal(material.plan, tight.plan.plan, 'a step with no packet row of its own reads its root\'s place');
        const spent = bought(tight.state, first);
        spent.stats = { ...spent.stats, money: Funding.packetAfterPurchase(spent.stats.money, first.amount * first.unitPrice, { itemId: first.itemId }) };
        assert.equal(Economy.forState(spent, deps()).network.activity?.itemId, tight.plan.network.agenda[0].itemId,
            'what the plan left for the step pays for it');
    }
    { // A failed step drops: the agenda goes on, its root keeps its place for the review.
        const { plan, state } = shotsFirst();
        const first = plan.network.activity;
        clear(first.itemId);
        const next = Economy.forState(state, deps());
        assert.equal(next.network.activity?.itemId, plan.network.agenda[0].itemId, 'a gone offer moves on');
        assert.equal(next.network.queue.some(wish => wish.key === first.rootKey), true, 'its root stands');
        sell(SHOTS, 5000, 6);
    }
    { // A native plan that failed or moved is heard at once: a real review.
        const { plan, state } = review();
        const built = Economy.forState(bought(state, plan.network.activity), { ...later(), fullReview: true });
        assert.equal(built.statsPacket.wishSections.at, T + 1000, 'the agenda waits');
    }
    { // Shots and potions below their line are weighed with the gear they serve (A5): one tier,
        // one queue, by value; the agenda works through both in one review.
        const { plan, state } = review();
        const tier = key => plan.network.queue.find(wish => wish.key.startsWith(key))?.progressionPriority;
        assert(tier('stock:') > 0 && tier('stock:') === tier('power:'), 'fixture: stock and gear in one tier');
        let current = state, step = plan;
        while (step.network.agenda?.length) {
            const after = bought(current, step.network.activity);
            step = Economy.forState(after, later());
            current = { ...after, stats: { ...after.stats, ...step.statsPacket } };
            assert.equal(step.statsPacket.wishSections.at, T, 'one review');
        }
        const end = Economy.forState(bought(current, step.network.activity), later());
        assert.equal(end.statsPacket.wishSections.at, T + 1000, 'the end of the agenda is a review');
    }
    { // What the first tier could not pay holds the money: nothing later spends it.
        const poor = review({ adena: 2000 });
        assert.deepEqual(poor.plan.network.later || [], [], 'a gap holds what is left for it');
    }
    { // Another's deal is a look: whatever moved, the plan answers (its goods are counted at the act).
        const { plan, state } = shotsFirst();
        const door = { ...deps(), caller: 'meeting_prepare', deal: new Set([SHOTS]) };
        const moved = { ...state, adena: state.adena + 1, inventory: { ...state.inventory, [SHOTS]: { selfId: SHOTS, amount: 7 } } };
        assert.equal(Economy.forState(moved, door).plan, plan.plan, 'a deal reads the held plan');
    }
    { // How long a plan may wait is the plan's: main reads it from the packet.
        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const { state } = review();
        const read = { ...deps(), board, decisions: { decided: () => null } };
        const urgent = { ...state, stats: { ...state.stats, kitRates: Packet.kitRates({ ...Packet.ratesOf(state.stats.kitRates), gapHorizonHours: 7.5 }) } };
        const wants = Decision.economyFor(urgent, { ...read, decisions: { decided: () => ({ urgency: 1 }) } });
        assert.equal(wants.gapHorizonHours, 7.5, 'how long it may wait is the plan\'s');
    }
    console.log('PASS agenda');
}
run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
