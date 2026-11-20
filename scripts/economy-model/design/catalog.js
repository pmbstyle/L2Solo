'use strict';

// The design's situation catalog: every fact a bot of the design can hear,
// the plane it is heard on and the decisions it wakes, as one table the
// account's fact queue reads (attention.js). A new situation is a new row.
//
// The planes are the game's (Situations.js NOW, STOP, TOWN): 'now' is heard
// wherever the bot stands; 'stop' at its next stop: at once while hunting (the
// model reads a hunt at the hour its fight stops) and in town, on arrival
// while on the road; 'town' only in town.
//
//   born  a new character stands in its first town;
//   out   a consumable it fires ran out (held became 0): a hunt spent the last of it, or a level changed the shot it
//         fires to one it holds none of;
//   bag   its bag reached the full rule (slots or weight);
//   town  it arrived in a town (also after a death's respawn);
//   died  it died: heard at once, it decides nothing by itself (the respawn
//         town's arrival is the fact that runs the town's decisions).

const SITUATIONS = Object.freeze({
    born: Object.freeze({ heard: 'now', wakes: Object.freeze(['supply']) }),
    out: Object.freeze({ heard: 'stop', wakes: Object.freeze(['supply']) }),
    bag: Object.freeze({ heard: 'stop', wakes: Object.freeze(['supply']) }),
    town: Object.freeze({ heard: 'now', wakes: Object.freeze(['supply']) }),
    died: Object.freeze({ heard: 'now', wakes: Object.freeze([]) })
});

// Whether a plane is heard where the account stands ('hunt', 'road', 'town').
const HEARD = Object.freeze({
    now: () => true,
    stop: place => place !== 'road',
    town: place => place === 'town'
});

// The catalog row of a fact's kind; a kind with no row throws by name.
function situationOf(kind) {
    const row = SITUATIONS[kind];
    if (!row) throw new Error(`no situation '${kind}' in the catalog`);
    return row;
}

const heardAt = (kind, place) => HEARD[situationOf(kind).heard](place);

// The decisions a heard chain wakes, each once, in the order of the chain's facts.
function woken(chain) {
    const out = [];
    for (const fact of chain) for (const decision of situationOf(fact.kind).wakes) if (!out.includes(decision)) out.push(decision);
    return out;
}

module.exports = { SITUATIONS, HEARD, situationOf, heardAt, woken };
