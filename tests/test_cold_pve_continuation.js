const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Encounter = require('../src/GameServer/Bot/Population/ColdPveEncounter');
const original = Cold.npcForSpot;
const start = 1750000000000;
const base = { characterId: 901, name: 'Slow', level: 12, phase: 'cold', activity: 'hunting',
    loc: { locX: 0, locY: 0, locZ: 0 }, inventory: {},
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 },
    stats: { classId: 0, coldCombat: { version: 1, classId: 0,
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
        equipment: { weaponKind: 'Weapon.Sword', pAtk: 80, pAtkRnd: 0, mAtk: 40,
            atkSpd: 379, critical: 0, accur: 100, pDef: 120, mDef: 50, evasion: 0, bonusMp: 0, shieldPDef: 0 },
        skills: [], effects: [] } } };
const spot = { id: 'continuation', name: 'Long fights', minLevel: 12, maxLevel: 12, avgLevel: 12,
    // Dense enough that the walk to a mob (T106) fits the 12 s round.
    density: 30, rewards: { exp: 1000, sp: 10, adenaMin: 1, adenaMax: 1 } };
let selected = 0;
let mobHp = 1200;
Cold.npcForSpot = () => { selected++; return { level: 12, maxHp: mobHp, pAtk: 1, pAtkRnd: 0,
    pDef: 200, mDef: 100, accur: 1, evasion: 0, critical: 0, atkSpd: 253 }; };
const merge = (state, patch) => JSON.parse(JSON.stringify({ ...state, ...patch,
    stats: { ...state.stats, ...patch.stats }, vitals: { ...state.vitals, ...patch.vitals } }));
try {
    let state = structuredClone(base), previousHp = mobHp, won = false, first;
    for (let i = 0; i < 19; i++) {
        const result = Solo.resolveSolo({ state, spot, elapsedMs: 12000, timestamp: start + i * 60000, rng: () => .5 });
        assert(result.debug.combatActions <= 48 * 5);
        state = merge(state, result.patch);
        if (result.debug.wins) { won = true; assert(result.materialize.exp > 0); break; }
        first ||= structuredClone(result.patch.stats.pveEncounter);
        assert.strictEqual(result.debug.fights, 0);
        assert.strictEqual(result.materialize.exp, 0);
        assert(state.stats.pveEncounter.hp < previousHp, 'each slice must damage the same mob');
        previousHp = state.stats.pveEncounter.hp;
        assert.strictEqual(selected, 1, 'resume must not resample an opponent');
    }
    assert(won, 'solo must eventually finish a mob that exceeds one slice');
    assert.strictEqual(Encounter.read(first, Encounter.key([base], { ...spot, id: 'elsewhere' }, 0), start + 60000), null);
    assert.strictEqual(Encounter.read(first, first.key, start + 11 * 60000), null, 'stale encounters expire');
    const fatal = Solo.resolveSolo({ state: { ...base, stats: { ...base.stats, pveEncounter: {
        ...first, mob: { ...first.mob, pAtk: 1e9, accur: 1000 }, mobReadyAt: 0, botReadyAt: 1000
    } } }, spot, elapsedMs: 12000, timestamp: start + 60000, rng: () => .5 });
    assert.strictEqual(fatal.debug.died, true);
    assert.strictEqual(fatal.patch.stats.pveEncounter, null);
    assert.strictEqual(fatal.debug.fights, 1);
    const exhausted = Solo.resolveSolo({ state: { ...base, stats: { ...base.stats, pveEncounter: {
        ...first, hp: 1e9, slices: Encounter.MAX_SLICES - 1
    } } }, spot, elapsedMs: 12000, timestamp: start + 60000, rng: () => .5 });
    assert.strictEqual(exhausted.patch.stats.pveEncounter, null, 'an unwinnable fight cannot continue forever');
    assert.strictEqual(exhausted.debug.fights, 1);
    const rest = Solo.resolveSolo({ state: { ...base, activity: 'resting', stats: { ...base.stats, pveEncounter: first } },
        spot, elapsedMs: 60000, timestamp: start + 60000, rng: () => .5 });
    assert.strictEqual(rest.patch.stats.pveEncounter, null, 'rest abandons the encounter');

    selected = 0; mobHp = 4000;
    let members = [901, 902].map(characterId => ({ ...structuredClone(base), characterId, activity: 'grouped',
        party: { partyId: 'test-party', role: 'dps' } }));
    let party = { partyId: 'test-party', memberIds: [901, 902], leaderId: 901, spotId: spot.id, stats: {} };
    previousHp = mobHp; won = false;
    for (let i = 0; i < 19; i++) {
        const result = Party.resolve({ party, members, spot, elapsedMs: 12000, timestamp: start + i * 60000, rng: () => .5 });
        assert(result.debug.combatActions <= 96, 'party keeps its original per-slice action cap');
        const huntMs = result.partyPatch.stats.recommendationHunt.pending['901:902'];
        assert(huntMs > 0 && huntMs <= (i + 1) * 12000,
            'shared hunt records active simulated combat, excluding the longer wall-clock gaps between resolves');
        party = JSON.parse(JSON.stringify({ ...party, ...result.partyPatch, stats: { ...party.stats, ...result.partyPatch.stats } }));
        members = result.memberResults.map(({ state, result }) => merge(state, result.patch));
        if (result.debug.wins) { won = true; assert(result.memberResults.some(x => x.result.materialize.exp > 0)); break; }
        assert.strictEqual(party.stats.fightsResolved, 0, 'partial combat is not a loss or completed fight');
        assert(party.stats.pveEncounter.hp < previousHp);
        previousHp = party.stats.pveEncounter.hp;
        assert.strictEqual(selected, 1);
        assert(result.memberResults.every(x => x.result.debug.fights === 0 && x.result.materialize.exp === 0));
        const altered = Encounter.key(members.slice(1), spot, 0, party.partyId);
        assert.strictEqual(Encounter.read(party.stats.pveEncounter, altered, start + i * 60000), null);
    }
    assert(won, 'party must eventually finish its shared mob');
    assert.strictEqual(party.stats.fightsResolved, 1);
    assert.strictEqual(party.stats.fightsWon, 1);
    assert.strictEqual(party.stats.pveEncounter, null);
    Cold.npcForSpot = () => ({ avoided: true, reason: 'target_resistance' });
    const avoided = Party.resolve({ party, members, spot, elapsedMs: 60000, timestamp: start + 20 * 60000, rng: () => .5 });
    assert.strictEqual(avoided.debug.fights, 0, 'an avoided encounter cannot inflate the planned fight count');
    assert.strictEqual(avoided.partyPatch.stats.recommendationHunt.pending['901:902'], party.stats.recommendationHunt.pending['901:902'],
        'an avoided fight adds no shared-hunt time');
    console.log('Cold PvE continuation: serialized solo/party damage, bounded slices, one reward, reset and honest counters passed');
} finally { Cold.npcForSpot = original; }
