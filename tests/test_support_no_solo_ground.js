'use strict';
const assert = require('assert');

require('../src/Global');

// No solo ground -> a party (decision 10-30, T106): a healer or buffer whose
// held earning answer names no spot or grey ground seeks a party, groups with the bots
// of the spot a party search finds for it, and joins a party of its level
// wherever that party hunts; a support with solo ground plays as before.
// A bot whose party share beats its solo hunt seeks a party on its earning ground.

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
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {}, stats: { classId, role, earning: { spotId, income: 1000 } }, ...extra });
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
    // A support with a real solo hunt has ground: its gear plan's source, or grey ground
    // it farms for gain (an economic hunt within 15 levels below).
    assert.strictEqual(Request.supportWithoutGround({ ...prophet, stats: { ...prophet.stats,
        equipmentPlan: { status: 'active', next: { spotId: 'grey65' } } } }, spots), false, 'a gear plan source is its solo hunt');
    const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression'), adventurer = Progression.adventurer;
    Progression.adventurer = () => true;
    try {
        assert.strictEqual(Request.supportWithoutGround({ ...prophet, stats: { ...prophet.stats, wishFocus: ['resale:57'] } }, spots), false,
            'grey ground farmed for gain is solo ground');
    } finally { Progression.adventurer = adventurer; }

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
        Calculation.recruitCheck = () => ({ memberGoals: [] });
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
    // Its LFP is heard across the region (C4 trade chat): a damage dealer of its band asking
    // on another spot of the region meets it there; one of another band does not.
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles'), ensure = Profiles.ensure;
    try {
        Profiles.ensure = () => spots;
        const asking = (id, level) => bot(id, 2, level, 'grey65', 'dps', { stats: { classId: 2, role: 'dps',
            earning: { spotId: 'grey65', income: 1000 }, partyRequest: { status: 'open', priority: 'preferred',
                reason: 'party_progress', spotId: 'grey65', objectiveKey: 'spot:grey65' } } });
        assert.strictEqual(Request.meetingKey(Request.partyObjectiveForState(seeker), 76, spots), 'de_village:15');
        const met = PopulationService.groupPartyCandidatesByObjective([seeker, bot(3, 2, 76, 'ground76', 'dps'), asking(5, 77), asking(6, 71)]);
        assert.deepStrictEqual(met.find(group => group.includes(seeker)).map(state => state.characterId).sort(), [3, 5, 9001],
            'the seeker meets its spot and the askers of its band in the region');
    } finally { Profiles.ensure = ensure; }

    // Rule 4: its held earning answer decides (the solo spot it hunts), not the spot it
    // stands on: an answer on ground of its level is solo ground; none or grey ground is not.
    const levelled = bot(9006, 17, 76, 'grey65', 'buffer');
    const answering = spotId => ({ ...levelled, stats: { ...levelled.stats, earning: { spotId, income: 1000 } } });
    assert.strictEqual(Request.supportWithoutGround(answering('ground76'), spots), false, 'its answer moves it to fitting ground');
    assert.strictEqual(Request.partyRequestForPlan(answering('ground76'), null, at, { spots }), null, 'no request opens');
    assert.strictEqual(Request.supportWithoutGround(answering(null), spots), true, 'an answer with no spot: no ground');
    assert.strictEqual(Request.supportWithoutGround(answering('grey65'), spots), true, 'an answer on grey ground: no ground');
    assert.strictEqual(Request.supportWithoutGround({ ...levelled, stats: { classId: 17, role: 'buffer' } }, spots), false,
        'no answer held yet says nothing about its ground');
    // Its solo hunt there counts as none wherever a party is weighed against it.
    const Income = invoke('GameServer/Bot/Population/PartyProgressComparison'), compare = Income.compare;
    assert.strictEqual(Income.heldSoloRoute(answering('grey65'), spots, at), null, 'grey ground is no solo side for forming or its stay');

    // Rule 3: a Prophet 46 with ground of its level plays as today.
    const young = bot(9005, 17, 46, 'ground46', 'buffer');
    assert.strictEqual(Request.supportWithoutGround(young, spots), false);
    assert.strictEqual(Request.partyRequestForPlan(young, null, at, { spots }), null, 'no request for a support with solo ground');
    assert.strictEqual(Persona.backgroundIntent(young).reason, 'prefers_solo', 'its persona decides as before');

    // Live regression: 170 level-one Orc Mystics had level-fitting keltirs but no safe solo
    // pull and no request after 8-13 played hours. The solo gate every spot search reads
    // refuses the field for the real starter kit, so its earning answer names no spot: no
    // solo ground, and the stranded starters ask for a party and meet at their home field.
    const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
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
    assert.strictEqual(Routes.isSpotAllowedForState(field, mystic, { mode: 'solo', timestamp: at }), false,
        'the solo gate of every spot search refuses the level-fitting field');
    const answered = state => ({ ...state, stats: { ...state.stats,
        earning: invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').answerOf(null, at) } });
    assert.strictEqual(Request.supportWithoutGround(answered(mystic), [field]), true, 'an answer with no safe spot: no solo ground');
    const starters = [mystic, starter(910050), starter(910051), starter(910052)].map(answered).map(state => ({ ...state,
        stats: { ...state.stats, partyRequest: Request.partyRequestForPlan(state, null, at, { spots: [field] }) } }));
    assert(starters.every(state => Request.seeksParty(state)), 'every stranded starter asks for a party');
    assert.deepStrictEqual(PopulationService.groupPartyCandidatesByObjective(starters)
        .map(group => group.length), [4], 'stranded mystics can meet each other at their home field');

    // Party progress -> a party: a bot that levels sooner in a party of two (itself and a
    // partner of its level) at its earning spot asks for a party there.
    const earner = { ...young, stats: { ...young.stats, earning: { spotId: 'ground46', income: 1000 } } };
    try {
        Income.compare = (state, peers, options) => ({ accept: options.objective.spotId === 'ground46' && peers.length === 1 });
        const asked = Request.partyRequestForPlan(earner, null, at, { spots });
        assert.deepStrictEqual({ status: asked.status, priority: asked.priority, reason: asked.reason, spotId: asked.spotId,
            objectiveKey: asked.objectiveKey }, { status: 'open', priority: 'preferred', reason: 'party_progress', spotId: 'ground46',
            objectiveKey: 'spot:ground46' }, 'it asks for a party on its earning ground');
        assert.strictEqual(Persona.backgroundIntent({ ...earner, stats: { ...earner.stats, partyRequest: asked } }).reason, 'party_progress');
        Income.compare = () => ({ accept: false });
        assert.strictEqual(Request.partyRequestForPlan(earner, null, at, { spots }), null, 'solo is sooner: no request');
        // The ask is held on what it stands on: asked again with nothing moved it is not weighed again; a level is.
        let weighed = 0;
        Income.compare = () => { weighed++; return { accept: true }; };
        const memo = {};
        assert.strictEqual(Request.partyRequestForPlan(earner, null, at, { spots, memo }).reason, 'party_progress');
        assert.strictEqual(Request.partyRequestForPlan(earner, null, at + 60000, { spots, memo }).reason, 'party_progress');
        assert.strictEqual(weighed, 1, 'an unchanged ask is held, not weighed at every build');
        const open = Request.partyRequestForPlan(earner, null, at + 90000, { spots, memo });
        assert.strictEqual(Request.partyRequestForPlan({ ...earner, stats: { ...earner.stats, partyRequest: open } }, null, at + 100000,
            { spots, memo }).reason, 'party_progress');
        assert.strictEqual(weighed, 1, 'the bot holding its own ask does not weigh it again');
        Income.compare = () => { weighed++; return { accept: false }; };
        assert.strictEqual(Request.partyRequestForPlan({ ...earner, level: earner.level + 1 }, null, at + 120000, { spots, memo }), null,
            'a new level weighs it again');
        assert.strictEqual(Request.partyRequestForPlan({ ...earner, stats: { ...earner.stats, earning: { ...earner.stats.earning, at: at + 1 } } },
            null, at + 180000, { spots, memo }), null);
        assert.strictEqual(weighed, 3, 'a new earning answer weighs it again');
    } finally { Income.compare = compare; }

    Config.developerDiagnostics = previousDiagnostics;
    console.log('Support without solo ground checks passed');
}

run().catch(error => { console.error(error); process.exit(1); });
