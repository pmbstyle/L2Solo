const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

const originalUpsertState = LifeState.upsertState;
const originalFindById = SpotService.findById;
const originalRandomPointNear = SpotService.randomPointNear;
const originalArrivalPointForState = SpotService.arrivalPointForState;

const canonicalDungeonState = LifeState.canonicalizeAreaState({
    characterId: 273,
    activity: 'hunting',
    currentRegion: 'Skeleton fields',
    loc: { locX: 45596, locY: 247589, locZ: -6518 },
    timing: { nextResolveAt: Date.now() + 60 * 60 * 1000 },
    party: {},
    stats: {}
});
assert.strictEqual(canonicalDungeonState.currentRegion, 'Elven Ruins',
    'startup migration must replace persisted synthetic area labels');
assert.strictEqual(canonicalDungeonState.stats.canonicalAreaId, 'elven_ruins');
assert.ok(canonicalDungeonState.timing.nextResolveAt < Date.now() + 3 * 60 * 1000,
    'legacy solo hunters must be scheduled for a bounded capacity-aware replan');

const mithrilSpot = {
    id: '29_-30',
    name: 'Mithril Mines',
    center: { locX: 176673, locY: -177656, locZ: 801 }
};
SpotService.findById = (id) => id === mithrilSpot.id ? mithrilSpot : originalFindById.call(SpotService, id);
SpotService.arrivalPointForState = () => ({ locX: 176812, locY: -177503, locZ: 792 });
const canonicalMithrilState = LifeState.canonicalizeAreaState({
    characterId: 271,
    activity: 'hunting',
    currentRegion: 'Akaste Bone Soldier fields',
    spotId: mithrilSpot.id,
    loc: { ...mithrilSpot.center },
    timing: { nextResolveAt: Date.now() + 60 * 60 * 1000 },
    party: {},
    stats: {}
});
assert.strictEqual(canonicalMithrilState.currentRegion, 'Mithril Mines', 'persisted Akaste field labels must migrate to Mithril Mines');
assert.strictEqual(canonicalMithrilState.stats.canonicalAreaId, 'mithril_mines');
assert.deepStrictEqual(canonicalMithrilState.loc, { locX: 176812, locY: -177503, locZ: 792 },
    'persisted bots stacked on the sector center must be redistributed among real spawn anchors');

const canonicalMarketReturn = LifeState.canonicalizeAreaState({
    characterId: 272,
    activity: 'shopping',
    currentRegion: 'Giran',
    loc: { locX: 83446, locY: 147904, locZ: -3400 },
    stats: {
        marketReturn: {
            spotId: mithrilSpot.id,
            regionName: 'Akaste Bone Soldier fields',
            loc: { ...mithrilSpot.center }
        }
    }
});
assert.strictEqual(canonicalMarketReturn.stats.marketReturn.regionName, 'Mithril Mines',
    'startup migration must repair dungeon destinations even while the bot is currently in town');
assert.deepStrictEqual(canonicalMarketReturn.stats.marketReturn.loc, { locX: 176812, locY: -177503, locZ: 792 },
    'legacy market returns must not recreate the exact-center stack');
SpotService.findById = originalFindById;
SpotService.arrivalPointForState = originalArrivalPointForState;

async function run() {
    let saved = null;
    LifeState.upsertState = (state) => {
        saved = state;
        return Promise.resolve(state);
    };

    const session = {
        accountId: 'bot_context',
        homeRegion: 'Wandering',
        plan: 'resting',
        currentSpot: { id: '2_-24' },
        coldLifeState: {
            characterId: 77,
            accountName: 'bot_context',
            name: 'ContextBot',
            level: 24,
            exp: 1000,
            sp: 200,
            adena: 5000,
            phase: 'hot',
            activity: 'hunting',
            homeRegion: 'Wandering',
            currentRegion: 'Wandering',
            spotId: '2_-24',
            loc: { locX: -8200, locY: 11300, locZ: -3100 },
            vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
            timing: {},
            party: { partyId: null, role: 'dps' },
            stats: { equipmentPlan: { target: { name: 'Atuba Mace' } } },
            inventory: {}
        },
        actor: {
            fetchId: () => 77,
            fetchName: () => 'ContextBot',
            fetchLevel: () => 24,
            fetchExp: () => 1200,
            fetchSp: () => 220,
            fetchClassId: () => 53,
            fetchClanId: () => 0,
            fetchLocX: () => 83180,
            fetchLocY: () => 147780,
            fetchLocZ: () => -3466,
            fetchHp: () => 100,
            fetchMaxHp: () => 100,
            fetchMp: () => 50,
            fetchMaxMp: () => 50,
            backpack: { fetchItems: () => [] }
        }
    };

    await LifeState.markCold(session, 'test_context');

    assert(saved, 'cooldown should persist a state');
    assert.deepStrictEqual(saved.loc, { locX: -8200, locY: 11300, locZ: -3100 }, 'a bot activated in Giran must return to its saved field location when cooled');
    assert.strictEqual(saved.currentRegion, 'Wandering');
    assert.strictEqual(saved.spotId, '2_-24');
    assert.strictEqual(saved.stats.equipmentPlan.target.name, 'Atuba Mace', 'cooldown must preserve the acquisition plan');

    SpotService.findById = () => ({ center: { locX: -8000, locY: 11000, locZ: -3100 } });
    SpotService.randomPointNear = () => ({ locX: -7900, locY: 11100, locZ: -3100 });
    session.coldLifeState = {
        ...session.coldLifeState,
        // markCold receives a still-hot snapshot, so this regression covers
        // the exact cooldown path that used to reintroduce plaza stacks.
        phase: 'hot',
        activity: 'resting',
        // The old hunting-region label was what let this exact stale plaza
        // coordinate bypass the previous Giran-only repair.
        currentRegion: 'Talking Island',
        loc: { locX: 83180, locY: 147780, locZ: -3466 },
        stats: {
            ...session.coldLifeState.stats,
            craftReturn: { loc: { locX: 1, locY: 2, locZ: 3 } },
            marketReturn: { loc: { locX: 4, locY: 5, locZ: 6 } }
        }
    };
    await LifeState.markCold(session, 'test_orphan_repair');
    assert.deepStrictEqual(saved.loc, { locX: -7900, locY: 11100, locZ: -3100 }, 'a stale craftReturn must not keep an ordinary bot on the Giran plaza');
    assert.strictEqual(saved.currentRegion, 'Wandering');
}

run()
    .then(() => console.log('Bot cold life-state context checks passed'))
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        LifeState.upsertState = originalUpsertState;
        SpotService.findById = originalFindById;
        SpotService.randomPointNear = originalRandomPointNear;
        SpotService.arrivalPointForState = originalArrivalPointForState;
    });
