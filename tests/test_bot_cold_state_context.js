const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

const originalUpsertState = LifeState.upsertState;
const originalFindById = SpotService.findById;
const originalRandomPointNear = SpotService.randomPointNear;

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
        phase: 'cold',
        activity: 'resting',
        currentRegion: 'Giran',
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
    });
