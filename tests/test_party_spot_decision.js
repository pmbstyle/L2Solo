const assert = require('assert');

require('../src/Global');

const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Situations = require('../src/GameServer/Bot/Situations');

// A party's spot (party_spot) is held on the party and searched only at its situations:
// a member joined or left, a contest lost at its arrival, a round its ground admitted no
// fight of it, its own deaths there, its leader outleveling the ground; with no answer
// for its objective (a new party, a new objective) the first step decides. No ground at
// all breaks the party up. A hot competition's "offer_party" pins the party to the shared
// target's ground: once that ground no longer stands for the party (its leader outlevels
// it: the search answers objectiveEnded, BotRoute.choose), the decision drops the
// objective and the party routes as any other.
const at = 1800000000000;
const ground = '-10_-19'; // a level 1-15 field of the spot table
const sharedTarget = { reason: 'shared_target', spotId: ground, npcId: 432 };
const partyFor = (objective, extra = {}) => ({ partyId: 'shared', leaderId: 1, memberIds: [1, 2], status: 'active',
    spotId: ground, nextResolveAt: at, revision: 1, cohesion: 1, stats: { objective, fightsWon: 10, fightsResolved: 10, ...extra } });
const membersFor = (level) => [1, 2].map((characterId) => ({ characterId, name: `Hunter${characterId}`, level, spotId: ground,
    phase: 'cold', activity: 'grouped', party: { partyId: 'shared', leaderId: 1, role: 'dps' }, loc: { locX: -84000, locY: 244000, locZ: -3700 },
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 }, timing: { lastResolvedAt: at - 45000, nextResolveAt: at },
    stats: { classId: 0, role: 'dps' } }));

// One party step: its spot decision (a search answering the ground it stands on),
// then a round with no member result. Returns the party row its leader commits and
// the searches run.
let steps = 0;
async function step(party, level, { answer = { spotId: ground }, round = {} } = {}) {
    const messages = [], members = membersFor(level).filter(member => party.memberIds.includes(member.characterId));
    let searches = 0;
    // Each step a second after the last (an answer's time is its key).
    const now = at + 1000 * ++steps;
    const kernel = new ColdSimulationKernel({ now: () => now,
        resolveSolo: () => { throw Error('party must not become solo combat'); },
        resolveParty: () => ({ memberResults: [], events: [], nextResolveAt: at + 45000, partyPatch: {}, ...round }),
        partyRoute: ({ held }) => held ? { route: null } : (searches++, { route: null, answer }),
        emit: (type, payload) => messages.push({ type, payload }),
        projectResolve: (state, result) => ({ ...state, ...result.patch }) });
    for (const state of members) {
        kernel.upsert({ state });
        kernel.inFlight.set(state.characterId, { state, startedAt: at, partyId: party.partyId });
    }
    kernel.partyRuns.set(party.partyId, { party, members, spot: { id: ground }, startedAt: at });
    await kernel.resolvePartyStep(party.partyId);
    const batch = messages.find((m) => m.type === 'proposal_batch');
    assert(batch, JSON.stringify(messages));
    return { party: batch.payload.proposals.find((p) => p.partyResolution).partyResolution.party, searches,
        states: batch.payload.proposals.map(p => p.nextState) };
}

(async () => {
    const ended = { answer: { spotId: ground, objectiveEnded: true } };
    const outgrown = await step(partyFor(sharedTarget), 30, ended);
    assert.strictEqual(outgrown.party.stats.objective, null, 'an outgrown shared target ends at the party\'s spot decision');
    assert.strictEqual(outgrown.searches, 1, 'the decision searches once');
    assert.strictEqual(outgrown.party.stats.partySpot.spotId, ground, 'and holds its answer');
    const hot = await step(partyFor({ kind: 'shared_target', spotId: ground, npcId: 432 }), 30, ended);
    assert.strictEqual(hot.party.stats.objective, null, 'a hot competition party (kind) ends the same way');
    const fits = await step(partyFor(sharedTarget), 5);
    assert.deepStrictEqual(fits.party.stats.objective, sharedTarget, 'a party that still fits its shared target keeps it');
    const clanHelp = { ...sharedTarget, reason: 'clan_help' };
    assert.deepStrictEqual((await step(partyFor(clanHelp), 30)).party.stats.objective, clanHelp, 'other objectives keep pinning');
    // Held: the next step searches nothing and hears nothing new.
    const held = await step(partyFor(sharedTarget, { partySpot: fits.party.stats.partySpot }), 5);
    assert.strictEqual(held.searches, 0, 'a held spot answer is not searched again');
    // The leader outlevels the held ground: spot_outleveled wakes the decision, the target ends.
    const grown = await step(partyFor(sharedTarget, { partySpot: fits.party.stats.partySpot }), 30, ended);
    assert.strictEqual(grown.searches, 1, 'spot_outleveled wakes the spot decision');
    assert.strictEqual(grown.party.stats.objective, null);
    assert.strictEqual(Situations.partyWoken(grown.party), false, 'the answer taken with the target dropped holds');
    // A new objective is a new question: the answer for the old one holds none.
    const retargeted = { ...grown.party, stats: { ...grown.party.stats, objective: { reason: 'clan_help', spotId: ground } } };
    assert.strictEqual(Situations.partyWoken(retargeted), true);
    // Its situations, each heard once at the next step against the held answer.
    const holding = { partySpot: (await step(partyFor(null), 5)).party.stats.partySpot };
    const empty = await step(partyFor(null, holding), 5, { round: { unhuntable: true } });
    assert.strictEqual(empty.searches, 0, 'a round with no fight it may take is no search yet');
    const emptied = await step({ ...partyFor(null), stats: empty.party.stats }, 5);
    assert.strictEqual(emptied.searches, 1, 'its next step hears spot_empty on the held ground');
    assert(require('../src/GameServer/Bot/Population/PartySpotRiskPolicy').excludedSpotIds(emptied.party).has(ground),
        'the empty ground stays marked over the answer: the search passes it by');
    const left = await step({ ...partyFor(null, holding), memberIds: [1, 3] }, 5);
    assert.strictEqual(left.searches, 1, 'a roster change (a member left, one joined) wakes the decision');
    const died = await step(partyFor(null, { ...holding, deaths: 1 }), 5);
    assert.strictEqual(died.searches, 1, 'a death of the party on its ground wakes it');
    const Risk = require('../src/GameServer/Bot/Population/PartySpotRiskPolicy');
    const lost = Risk.withMark(partyFor(null, holding), ground, 'contest_lost');
    assert.strictEqual((await step(lost, 5)).searches, 1, 'a contest lost at its arrival wakes it');
    // No ground at all: the party breaks up, each member to its own hunt (party_left raised on each).
    const none = await step(partyFor(null), 5, { answer: { spotId: null } });
    assert.strictEqual(none.party.status, 'dissolved');
    assert.strictEqual(none.party.stats.partyBreakReason, 'party_no_spot');
    assert(none.states.every(state => !state.party.partyId && state.activity === 'hunting'));
    console.log('party spot decision: ok');
})().catch((err) => { console.error(err); process.exit(1); });
