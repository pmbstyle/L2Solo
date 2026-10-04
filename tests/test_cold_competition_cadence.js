const assert = require('assert');
require('../src/Global');
const Persona = invoke('GameServer/Bot/AI/BotPersona');
const { ColdCompetitionMonitor, INTERVAL_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const { CONFLICT_COOLDOWN_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionActions');
const neutral = { ready: true, revision: 0, personal: null };
const friendly = { ...neutral, personal: { affinity: 30, trust: 30, hostility: 0, fear: 0 } };
const at = 1800000000000, runs = 32;

// Fixed populations on occupied grounds for one hour. This measures encounter
// opportunities with accepted-dispute cooldowns; it is not a live fight-rate claim.
function observe(pressure, relation = neutral, stall = false) {
    let meetings = 0, intents = 0, first20 = 0;
    for (let run = 0; run < runs; run++) {
        const spot = { id: `cadence-${run}`, npcEntries: [{ selfId: 10, count: 1 }] };
        const entries = Array.from({ length: 6 }, (_, i) => ({ state: {
            characterId: 2000000 + run * 6 + i, name: `Hunter${i}`, level: 40,
            phase: 'cold', activity: 'hunting', spotId: spot.id, vitals: { hp: 100 }, stats: {}
        }, context: { spot, targetNpcId: 10 } }));
        const personas = new Map(entries.map(({ state }, i) => [state.characterId,
            Persona.generate({ characterId: state.characterId, stats: { generatedIndex: run * 6 + i } })]));
        const monitor = new ColdCompetitionMonitor({ capacityForSpot: () => 6 / pressure,
            personaFor: s => personas.get(s.characterId) });
        const memory = { assess: () => relation, views: new Map() }, fights = new Map();
        let seenEarlyFight = false;
        for (let tick = 0; tick <= 120; tick++) {
            const now = at + tick * INTERVAL_MS + (stall && tick > 0 ? 24 * 3600000 : 0);
            monitor.sample(entries, memory, now);
            for (const event of monitor.snapshot().events) {
                meetings++;
                if (event.pvpIntent) {
                    intents++;
                    if (tick <= 40) seenEarlyFight = true;
                }
                if (event.action !== 'contest') continue;
                for (const id of [event.actor.id, event.peer.id]) {
                    if (event.pvpIntent) {
                        assert(now - (fights.get(id) || 0) >= CONFLICT_COOLDOWN_MS,
                            'a crowded spot cannot repeatedly drag the same hunter into fights');
                        fights.set(id, now);
                    }
                    entries.find(e => e.state.characterId === id).state.stats.coldCompetition = {
                        conflictUntil: now + (event.pvpIntent ? CONFLICT_COOLDOWN_MS : 3 * 60000)
                    };
                }
            }
        }
        first20 += Number(seenEarlyFight);
    }
    return { meetings, intents, earlySessions: first20, meanIntentsPerHour: intents / runs };
}
const quiet = observe(1), ordinary = observe(1.1), busy = observe(2), friends = observe(2, friendly);
assert.strictEqual(quiet.meetings, 0, 'available resources do not manufacture incidents');
assert(busy.intents > ordinary.intents * 2, 'the increase belongs to actual shortages, not every occupied spot');
assert(busy.intents < busy.meetings * 0.25, 'peaceful interactions remain the large majority');
assert(busy.meanIntentsPerHour >= 4 && busy.meanIntentsPerHour <= 10,
    'six competing hunters offer several PvP opportunities per hour without constant combat');
assert(busy.earlySessions >= runs * 0.65, 'crowded sessions need no hour-long warmup');
assert(friends.intents < busy.intents / 10, 'repeated friendly encounters do not become a feud');
const stalled = observe(2, neutral, true);
assert(stalled.meanIntentsPerHour < 10, 'a long offline interval cannot generate a catch-up war');

// A forecast the main thread skipped for its action budget gives its cooldowns
// back: the same pair can meet again on the next scan, before the two minutes.
{
    const spot = { id: 'release', npcEntries: [{ selfId: 10, count: 1 }] };
    const entries = [2100001, 2100002].map((characterId, i) => ({ state: { characterId, name: `Leaver${i}`, level: 40,
        phase: 'cold', activity: 'hunting', spotId: spot.id, vitals: { hp: 100 }, stats: {} }, context: { spot, targetNpcId: 10 } }));
    const memory = { assess: () => neutral, views: new Map() };
    const make = () => new ColdCompetitionMonitor({ capacityForSpot: () => 1, personaFor: s => Persona.generate({ characterId: s.characterId, stats: {} }) });
    const kept = make(), released = make();
    let first = null, tick = 0;
    for (; !first && tick < 20; tick++) {
        for (const monitor of [kept, released]) monitor.sample(entries, memory, at + tick * INTERVAL_MS);
        first = released.snapshot().events.find(e => e.action !== 'revenge') || null;
    }
    assert(first, 'two hunters on a one-slot ground meet');
    released.release([{ at: first.at - 1, action: first.action, actor: first.actor, peer: first.peer }]);
    assert.strictEqual(released.pairs.size, 1, 'a release from another scan keeps the cooldown');
    released.release([JSON.parse(JSON.stringify(first))]);
    assert.strictEqual(released.pairs.size + released.bots.size, 0, 'the skipped forecast releases its pair and unit cooldowns');
    const again = { kept: 0, released: 0 };
    for (let next = tick; next < tick + 3; next++) {
        for (const [name, monitor] of Object.entries({ kept, released })) {
            monitor.sample(entries, memory, at + next * INTERVAL_MS);
            again[name] += monitor.snapshot().events.length;
        }
    }
    assert.strictEqual(again.kept, 0, 'an applied forecast keeps the pair cooling down');
    assert(again.released > 0, 'a released pair re-decides before the cooldown ends');
    const revenge = new ColdCompetitionMonitor({ capacityForSpot: () => 1, personaFor: () => ({ traits: {} }) });
    const retry = require('../src/GameServer/Social/RevengePolicy').RETRY_MS;
    revenge.revenge.cooldowns.set('solo:1', at + retry).set('party-2', at + retry).set('solo:3', at + INTERVAL_MS + retry);
    revenge.release([{ at, action: 'revenge', actor: { id: 1, partyId: null }, peer: { id: 2, partyId: 'party-2' } },
        { at, action: 'revenge', actor: { id: 3 }, peer: { id: 4 } }]);
    assert.deepStrictEqual([...revenge.revenge.cooldowns.keys()], ['solo:3'], 'a skipped revenge releases only its own scan cooldowns');
}
console.log('Local competition cadence passed', JSON.stringify({ runs, quiet, ordinary, busy, friends, stalled }));
