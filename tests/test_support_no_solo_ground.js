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
    const restorePartyCommit = require('./helpers/recordedPartyCommit').install();
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
        restorePartyCommit();
    }
    // ... and it forms a party with the bots that hunt its request spot.
    const groups = PopulationService.groupPartyCandidatesByObjective([seeker, bot(3, 2, 76, 'ground76', 'dps'),
        bot(4, 88, 77, 'ground76', 'dps')]);
    assert.deepStrictEqual(groups.map(group => group.map(state => state.characterId).sort()), [[3, 4, 9001]],
        'the seeker groups with the hunters of its request spot');

    // Rule 4 (T126): the routed spot decides, not the old one. A Prophet 76 on
    // grey ground whose search (the route kept on its worker record) moves it
    // to ground of its level has solo ground; one whose search finds none has not.
    const levelled = bot(9006, 17, 76, 'grey65', 'buffer');
    assert.strictEqual(Request.supportWithoutGround(levelled, spots, { owner: { route: { spotId: 'ground76' } }, timestamp: at }), false,
        'the search moves it to fitting ground: no party request');
    assert.strictEqual(Request.partyRequestForPlan(levelled, null, at,
        { spots, search: { owner: { route: { spotId: 'ground76' } }, timestamp: at } }), null, 'no request opens');
    assert.strictEqual(Request.supportWithoutGround(levelled, spots, { owner: { route: { spotId: null } }, timestamp: at }), true,
        'a search that finds no spot leaves it without ground');
    assert.strictEqual(Request.supportWithoutGround(levelled, spots, { owner: { route: { spotId: 'grey65' } }, timestamp: at }), true,
        'a search that keeps it on grey ground leaves it without ground');
    assert.strictEqual(Request.supportWithoutGround(levelled, spots, { owner: {}, timestamp: at }), false,
        'a record without a route: its own search moves it to fitting ground');
    // A support on a resting step is not searched for (choose: not asked): that
    // is no verdict, so no request opens until it hunts again.
    const resting = { ...levelled, activity: 'resting' };
    assert.strictEqual(Request.supportWithoutGround(resting, spots, { owner: {}, timestamp: at }), false,
        'a rest asks no search: it says nothing about the ground');
    assert.strictEqual(Request.partyRequestForPlan(resting, null, at, { spots, search: { owner: {}, timestamp: at } }), null,
        'no request opens on a rest');

    // Rule 3: a Prophet 46 with ground of its level plays as today.
    const young = bot(9005, 17, 46, 'ground46', 'buffer');
    assert.strictEqual(Request.supportWithoutGround(young, spots), false);
    assert.strictEqual(Request.partyRequestForPlan(young, null, at, { spots }), null, 'no request for a support with solo ground');
    assert.strictEqual(Persona.backgroundIntent(young).reason, 'prefers_solo', 'its persona decides as before');

    // Live regression: 170 level-one Orc Mystics had level-fitting keltirs,
    // but no safe solo pull and no request after 8-13 played hours.
    const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const field = { id: '-9_-19', name: 'Prairie Keltir fields', minLevel: 1, maxLevel: 3, avgLevel: 2,
        density: 26, center: { locX: -50124, locY: -111341, locZ: -240 },
        tags: [], tagsAuthoritative: true, localStarterRegions: ['orc'], localUntilLevel: 5,
        npcSelfIds: [535, 538, 531], npcEntries: [
            { selfId: 535, count: 11, production: 1980 },
            { selfId: 538, count: 9, production: 1620 },
            { selfId: 531, count: 6, production: 1080 }
        ] };
    const starter = characterId => {
        const state = { characterId, name: `Mystic${characterId}`, accountName: `bot_${characterId}`,
            phase: 'cold', activity: 'hunting', level: 1, exp: 0, adena: 85, spotId: field.id,
            loc: { ...field.center }, timing: {}, stats: { classId: 49, role: 'buffer',
                generatedCold: true, populationWave: 1, starterRegion: 'orc',
                wishFocus: ['power:1129:12', 0, 529], money: [1, 1, 1188, 529],
                coldCombat: { skillSource: 'database',
                    skills: Cold.skillSnapshotsFromRecords(Cold.skillRecordsFromTree(49, 1)) } },
            inventory: Object.fromEntries([[425, 10], [461, 11], [2368, 14]].map(([selfId, slot]) =>
                [selfId, { selfId, amount: 1, equipped: true, equippedSlots: [slot], slot }])) };
        const profile = Cold.profileFor(state, at);
        state.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
        return state;
    };
    const mystic = starter(910049);
    assert(Matchup.admitsNone(Matchup.spotShares(Matchup.stateProfiles(mystic, { mode: 'solo' }), field,
        { soloSafety: true })), 'the real starter kit cannot safely pull even the young keltirs');
    const search = { owner: { route: { spotId: field.id } }, timestamp: at };
    assert(Request.supportWithoutGround(mystic, [field], search),
        'a fitting level band cannot hide an unsafe starter kit, including a held route');
    const starters = [mystic, starter(910050), starter(910051), starter(910052)].map(state => ({ ...state,
        stats: { ...state.stats, partyRequest: Request.partyRequestForPlan(state, null, at, { spots: [field], search }) } }));
    assert(starters.every(state => Request.seeksParty(state)), 'every stranded starter opens the native support request');
    assert.deepStrictEqual(PopulationService.groupPartyCandidatesByObjective(starters)
        .map(group => group.length), [4], 'stranded mystics can meet each other at their home field');
    const Income = invoke('GameServer/Bot/Population/PartyIncomeComparison');
    const objective = starters[0].stats.partyRequest;
    const forecast = Income.prepare(starters, { objective, spots: [field], timestamp: at });
    assert.equal(forecast.rows.size, 4, 'missing solo table rows do not erase a safe melee roster income');
    assert([...forecast.rows.values()].every(row => row.income > 0 && row.kills > 0));
    assert.equal(Income.compare(starters[0], starters.slice(1), { prepared: forecast, objective }).reason,
        'goal_requires_party', 'the party pays for real equipment through loot, without valuing bonus XP');
    assert.deepStrictEqual(invoke('GameServer/Bot/Population/PartyGoalPolicy')
        .formingVerdict(starters, objective, { spots: [field], timestamp: at }).formingAccepted,
    starters.map(state => state.characterId), 'the native formation verdict admits all starters');
    assert.equal(Income.prepare([mystic], { objective, spots: [field], timestamp: at }).rows.size, 0,
        'the fallback cannot invent safe solo income');
    const bowParty = starters.map(member => {
        const inventory = { ...member.inventory };
        delete inventory[2368];
        inventory[13] = { selfId: 13, amount: 1, equipped: true, equippedSlots: [14], slot: 14 };
        return { ...member, inventory };
    });
    const bowProfiles = Matchup.stateProfiles(bowParty[0],
        { timestamp: at, capacityStates: bowParty, mode: 'party', buffed: true });
    assert(bowProfiles.every(profile => profile.equipment.weaponKind === 'Weapon.Bow' && profile.equipment.bowMp > 0),
        'the real Short Bow spends MP even when its owner has no offensive skills');
    assert.strictEqual(require('../src/GameServer/Bot/Population/MeleePartyForecast').forecast(bowParty, bowProfiles, field,
        { timestamp: at, cohesion: 1 }), null, 'a melee forecast cannot price bow attacks without their MP recovery');
    const partyId = 'orc-starter-recovery';
    const hunt = invoke('GameServer/Bot/Population/BackgroundPartyResolver').resolve({
        party: { partyId, leaderId: starters[0].characterId, memberIds: starters.map(state => state.characterId),
            spotId: field.id, cohesion: 1, risk: 0, roleCoverage: { buffer: 4 },
            stats: { objective: starters[0].stats.partyRequest } },
        members: starters.map(state => ({ ...state, party: { partyId, role: 'buffer' } })),
        spot: field, elapsedMs: 60000, timestamp: at, rng: () => 0.1
    });
    assert(hunt.debug.wins > 0, 'the native party fight beats the real starter mobs');
    assert(hunt.memberResults.every(entry => entry.result.materialize.exp > 0),
        'all four mystics earn real shared XP without granting levels or equipment');

    Config.developerDiagnostics = previousDiagnostics;
    console.log('Support without solo ground checks passed');
}

run().catch(error => { console.error(error); process.exit(1); });
