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
console.log('Local competition cadence passed', JSON.stringify({ runs, quiet, ordinary, busy, friends, stalled }));
