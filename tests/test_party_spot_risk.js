const assert = require('assert');
require('../src/Global');
const Solo = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const Party = invoke('GameServer/Bot/Population/PartySpotRiskPolicy');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const at = 1800000000000;
const personal = { characterId: 1, level: 20, phase: 'cold', activity: 'hunting', spotId: 'danger',
    exp: 0, sp: 0, adena: 0, inventory: {}, timing: {}, loc: { locX: 1, locY: 2, locZ: 3 },
    vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
    stats: { deaths: 5, fightsResolved: 10, classId: 0, classProgressionLevel: 20, classProgressionClassId: 0,
        spotRisk: { version: 2, spotId: 'danger', windowFights: 3, windowWins: 0, windowDeaths: 2 },
        spotBackoffs: [{ spotId: 'danger', startedAt: at - 1000, until: at + 3600000, attempts: 1 }] } };
const party = { partyId: 'group1', memberIds: [1, 2, 3], spotId: 'danger', stats: { fightsResolved: 100, deaths: 25 } };
const merge = (p, r) => ({ ...p, ...r.partyPatch, stats: { ...p.stats, ...r.partyPatch.stats } });
async function run() {
    assert(Solo.excludedSpotIdsForStates([personal], at).has('danger'));
    assert(!Party.excludedSpotIds(party, at).has('danger'), 'legacy party counters and member bans are not evidence for current group');
    assert.strictEqual(Party.backoff(party, 'danger', at), null);
    const failed = { debug: { fights: 3, wins: 0, spotId: 'danger' },
        partyPatch: { stats: { deaths: 27 } }, memberResults: [] };
    const recorded = Party.record(party, failed, at);
    const unhappy = merge(party, recorded);
    assert(Party.excludedSpotIds(unhappy, at).has('danger'), 'group failures create their own exclusion');
    const pressure = Party.backoff(unhappy, 'danger', at);
    assert.strictEqual(pressure.deaths, 2, 'only deaths from this group window count');
    const backedOff = Party.withBackoff(unhappy, pressure, at);
    assert(backedOff.stats.partySpotRisk.spotBackoffs.length === 1);
    const persisted = JSON.parse(JSON.stringify(backedOff));
    assert(Party.backoff(persisted, 'danger', at + 1000), 'party risk survives persistence/restart');
    assert.strictEqual(Party.backoff({ ...persisted, partyId: 'other' }, 'danger', at), null, 'new parties start independently');
    assert.strictEqual(Party.backoff({ ...persisted, memberIds: [1, 2, 3, 4] }, 'danger', at), null,
        'reinforced party re-evaluates its capability');
    assert(Party.backoff({ ...persisted, memberIds: [3, 2, 1] }, 'danger', at), 'roster ordering is not a composition change');
    const lowWins = merge(party, Party.record(party, { debug: { fights: 12, wins: 1, spotId: 'danger' },
        partyPatch: { stats: { deaths: 25 } } }, at));
    assert.strictEqual(Party.backoff(lowWins, 'danger', at).reason, 'low_win_rate');
    const route = { needed: true, mode: 'party', spotId: 'safer', to: { locX: 10, locY: 20, locZ: 3 }, spotBackoff: pressure };
    const travelled = beginHuntingTrip(personal, route, at);
    assert.deepStrictEqual(travelled.stats.spotBackoffs, personal.stats.spotBackoffs,
        'group retreat cannot copy/extend its ban into a member');
    assert.deepStrictEqual(travelled.stats.spotRisk, personal.stats.spotRisk);
    const before = JSON.stringify(personal.stats.spotRisk);
    invoke('GameServer/DataCache').init();
    const prepared = await Life.prepareResolve({ ...personal, party: { partyId: party.partyId } }, {
        patch: { deathCount: 6 }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: at + 1000, debug: { fights: 3, wins: 0 }
    }, { timestamp: at, persist: false, projectClassProgression: true });
    assert(prepared);
    // Inspect the resulting state without persisting a live character.
    const snapshot = prepared.snapshot || prepared.state || prepared;
    const stats = snapshot.stats || JSON.parse(prepared.row.statsJson);
    assert.strictEqual(JSON.stringify(stats.spotRisk), before, 'party combat leaves solo risk history untouched');
    console.log('Party risk: isolated history, persistence, roster changes, real group failures and uncontaminated solo state passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
