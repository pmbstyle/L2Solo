'use strict';
const assert = require('assert');

require('../src/Global');

// No solo ground -> a party (decision 10-30, T106): a healer or buffer whose
// solo gate admits no spot near its level seeks a party, groups with the bots
// of the spot a party search finds for it, and joins a party of its level
// wherever that party hunts; a support with solo ground plays as before.

invoke('GameServer/DataCache').init();
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Request = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const Persona = invoke('GameServer/Bot/Population/PersonaPartyPolicy');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Calculation = invoke('GameServer/Bot/Population/PartyGoalCalculation');

const spot = (id, level, locX) => ({ id, name: id, avgLevel: level, minLevel: level - 1, maxLevel: level + 1,
    density: 20, center: { locX, locY: 0, locZ: 0 }, tags: [], tagsAuthoritative: true });
// Grey ground for a 76 (spot 12_-14's level), ground of its level, and of a 46.
const spots = [spot('grey65', 65, 10), spot('ground76', 76, 9000), spot('ground46', 46, 30000)];
const reserved = { primaryDrive: 'wealth', archetype: 'pragmatic_earner',
    traits: { sociability: 0.30, commitment: 0.40, empathy: 0.35 } };
const bot = (characterId, classId, level, spotId, role, extra = {}) => ({ characterId, name: `Bot${characterId}`,
    accountName: `bot_${characterId}`, phase: 'cold', activity: 'hunting', level, spotId, persona: reserved,
    loc: { ...spots.find(row => row.id === spotId).center }, inventory: {},
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {}, stats: { classId, role }, ...extra });
const at = Date.now();

async function run() {
    const previousDiagnostics = Config.developerDiagnostics;
    Config.developerDiagnostics = true;

    // Rule 1+2: a Prophet 76 on grey ground has no solo ground: it seeks a
    // party at the ground of its level, whatever its persona.
    const prophet = bot(9001, 17, 76, 'grey65', 'buffer');
    assert.strictEqual(Request.supportWithoutGround(prophet, spots), true, 'grey ground is no solo ground for a 76');
    const request = Request.partyRequestForPlan(prophet, null, at, { spots });
    assert.deepStrictEqual({ status: request.status, priority: request.priority, reason: request.reason,
        spotId: request.spotId, objectiveKey: request.objectiveKey },
    { status: 'open', priority: 'preferred', reason: 'no_solo_ground', spotId: 'ground76', objectiveKey: 'spot:ground76' },
    'it asks for a party at the spot a party of its level hunts');
    const seeker = { ...prophet, stats: { ...prophet.stats, partyRequest: request } };
    assert.strictEqual(Persona.backgroundIntent({ ...prophet }).accept, false, 'its persona alone prefers solo');
    assert.deepStrictEqual((({ accept, reason }) => ({ accept, reason }))(Persona.backgroundIntent(seeker)),
        { accept: true, reason: 'no_solo_ground' }, 'the fact forces the seeking');
    const kept = Request.partyRequestForPlan(seeker, null, at + 1000, { spots });
    assert.strictEqual(kept.requestedAt, request.requestedAt, 'the open request keeps its window and spot');
    // A Shillien Elder (a healer) is a seeker too; a DPS on the same ground is not.
    assert.strictEqual(Request.supportWithoutGround(bot(9002, 43, 76, 'grey65', 'healer'), spots), true);
    assert.strictEqual(Request.supportWithoutGround(bot(9003, 2, 76, 'grey65', 'dps'), spots), false,
        'only a healer or buffer seeks by this rule');

    // Rule 2: recruitment across spots: a party of its level that hunts
    // another spot (not the seeker's ground nor its request spot) takes it.
    const originals = { active: PartyState.active, find: PartyState.find, createOrUpdate: PartyState.createOrUpdate,
        cachedStatesForParties: LifeState.cachedStatesForParties, cachedState: LifeState.cachedState,
        assignParty: LifeState.assignParty, recruitCheck: Calculation.recruitCheck,
        partyMinSize: Config.partyMinSize, partyMaxSize: Config.partyMaxSize };
    const members = [bot(1, 2, 76, 'ground76', 'dps'), bot(2, 88, 75, 'ground76', 'dps')]
        .map(member => ({ ...member, spotId: 'far76', party: { partyId: 'bgp_far', role: 'dps' } }));
    const party = { partyId: 'bgp_far', leaderId: 1, memberIds: [1, 2], spotId: 'far76', status: 'active', revision: 1, stats: {} };
    let saved = null;
    try {
        Config.partyMinSize = 2; Config.partyMaxSize = 5;
        PartyState.active = () => [party];
        PartyState.find = () => party;
        PartyState.createOrUpdate = next => { saved = next; return Promise.resolve(next); };
        LifeState.cachedStatesForParties = () => Promise.resolve(new Map([['bgp_far', members]]));
        LifeState.cachedState = id => members.find(member => member.characterId === id) || null;
        const loneHealer = bot(9004, 43, 76, 'grey65', 'healer');
        const ignored = await PopulationService.recruitBackgroundMembers([loneHealer]);
        assert.deepStrictEqual([...ignored], [], 'a support that is not seeking meets only parties on its spot');
        const recruited = await PopulationService.recruitBackgroundMembers([seeker]);
        assert.deepStrictEqual([...recruited], [9001], 'the seeker is claimed by the far party');
        assert.deepStrictEqual(saved.stats.pendingRecruits, { ids: [9001] }, 'the far leader\'s step checks the join');
        // A party near the player checks the join here; its verdict (the
        // worker's recruit check on real kits) is the edge of this fixture.
        members[0] = { ...members[0], phase: 'hot' };
        const assigned = [];
        LifeState.assignParty = (state, partyId) => { assigned.push([state.characterId, partyId]); return Promise.resolve(state); };
        Calculation.recruitCheck = () => ({ memberGoals: [], lastIncomeReviewAt: at, incomeReviews: [] });
        const joined = await PopulationService.recruitBackgroundMembers([seeker]);
        assert.deepStrictEqual([...joined], [9001]);
        assert.deepStrictEqual(assigned.filter(([id]) => id === 9001), [[9001, 'bgp_far']], 'the seeker joins the far party');
    } finally {
        LifeState.assignParty = originals.assignParty; Calculation.recruitCheck = originals.recruitCheck;
        Object.assign(PartyState, { active: originals.active, find: originals.find, createOrUpdate: originals.createOrUpdate });
        Object.assign(LifeState, { cachedStatesForParties: originals.cachedStatesForParties, cachedState: originals.cachedState });
        Config.partyMinSize = originals.partyMinSize; Config.partyMaxSize = originals.partyMaxSize;
    }
    // ... and it forms a party with the bots that hunt its request spot.
    const groups = PopulationService.groupPartyCandidatesByObjective([seeker, bot(3, 2, 76, 'ground76', 'dps'),
        bot(4, 88, 77, 'ground76', 'dps')]);
    assert.deepStrictEqual(groups.map(group => group.map(state => state.characterId).sort()), [[3, 4, 9001]],
        'the seeker groups with the hunters of its request spot');

    // Rule 3: a Prophet 46 with ground of its level plays as today.
    const young = bot(9005, 17, 46, 'ground46', 'buffer');
    assert.strictEqual(Request.supportWithoutGround(young, spots), false);
    assert.strictEqual(Request.partyRequestForPlan(young, null, at, { spots }), null, 'no request for a support with solo ground');
    assert.strictEqual(Persona.backgroundIntent(young).reason, 'prefers_solo', 'its persona decides as before');

    Config.developerDiagnostics = previousDiagnostics;
    console.log('Support without solo ground checks passed');
}

run().catch(error => { console.error(error); process.exit(1); });
