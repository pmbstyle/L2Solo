const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');
const world = require('./fixtures/native_stock_world')();
const previousRate = process.env.L2NODE_PROGRESSION_RATE;
useRate('x10');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const originalGeo = Object.fromEntries(['getCellData', 'getHeight', 'hasGeo', 'hasLineOfSight'].map((key) => [key, Geo[key]]));
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const BotManager = invoke('GameServer/Bot/BotManager');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const World = invoke('GameServer/World/World');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ClanService = invoke('GameServer/Clan/ClanService');
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const originalCatalog = { spots: SpotService.spots, profiles: Spots.cache };

const originals = {
    active: PartyState.active,
    counts: PartyState.counts,
    statesForParty: LifeState.statesForParty,
    cachedStatesForParties: LifeState.cachedStatesForParties,
    coldPartyCandidateProjections: LifeState.coldPartyCandidateProjections,
    coldPartyCandidateCount: LifeState.coldPartyCandidateCount,
    coldPartyCandidates: LifeState.coldPartyCandidates,
    coldPartyCandidatesForSpots: LifeState.coldPartyCandidatesForSpots,
    assignParty: LifeState.assignParty,
    partyRequirementCounts: LifeState.partyRequirementCounts,
    clearParty: LifeState.clearParty,
    releaseDissolvedPartyMembers: LifeState.releaseDissolvedPartyMembers,
    cachedState: LifeState.cachedState,
    createOrUpdate: PartyState.createOrUpdate,
    setStatus: PartyState.setStatus,
    loadAndSpawnBot: BotManager.loadAndSpawnBot,
    findCurrentSpot: SpotService.findCurrentSpot,
    record: LifeEvents.record,
    handoffToMain: ColdSimulationOwner.handoffToMain,
    acceptColdState: ColdSimulationCoordinator.acceptColdState,
    requestPartyGoals: ColdSimulationCoordinator.requestPartyGoals,
    partyMinSize: Config.partyMinSize,
    partyMaxSize: Config.partyMaxSize,
    maxBackgroundParties: Config.maxBackgroundParties,
    partyFormationBatchSize: Config.partyFormationBatchSize
};
const originalFormationState = {
    resolving: PopulationService.resolving,
    partyFormationRunning: PopulationService.partyFormationRunning,
    partyFormationPending: PopulationService.partyFormationPending
};

async function run() {
    Data.init(); Database.init();
    assert(Database.isReady());
    // A unit world with one available authored ordinary camp. Its actual NPC
    // mix and center are borrowed from canonical data, never invented combat.
    // T43 table: '0_13' (level 18, NPCs 44/36 as the gone level-19 '-1_10', plus 466).
    const NATIVE_SPOT = '0_13';
    const source = require('../data/Bots/spot-reward-npcs.json').rows.find(row => row[0] === NATIVE_SPOT);
    const cell = require('../data/Bots/spot-table.json').spots.find(row => row[0] === NATIVE_SPOT);
    assert(source && cell);
    const camp = { id: NATIVE_SPOT, avgLevel: cell[1], density: cell[2],
        npcEntries: source[1].map(([selfId, count]) => ({ selfId, count })),
        npcSelfIds: source[1].map(([selfId]) => selfId), tags: [], tagsAuthoritative: true };
    camp.center = source[1].flatMap(([selfId]) => invoke('GameServer/Knowledge/SpawnCatalog').spawnsForNpc(selfId)
        .flatMap(row => [...(row.definition.coords || []), ...(row.group.bounds || [])
            .map(point => ({ locX: point.locX, locY: point.locY, locZ: point.maxZ }))]))
        .find(loc => SpotService.findCurrentSpot(loc, [camp]) === camp);
    assert(camp.center, 'a published spawn coordinate or boundary belongs to this actual camp');
    const levels = source[1].map(([selfId]) => Number(Data.npcs.find(row => row.selfId === selfId).template.level));
    camp.minLevel = Math.min(...levels); camp.maxLevel = Math.max(...levels);
    SpotService.spots = [invoke('GameServer/World/WorldAreaCatalog').decorateSpot(camp)]; Spots.reset();
    const nativeSpot = invoke('GameServer/Bot/AI/SpotIndex').spotById(Spots.ensure(), NATIVE_SPOT);
    assert(nativeSpot && !nativeSpot.raidBoss);
    assert.deepStrictEqual(nativeSpot.npcEntries, camp.npcEntries);
    async function nativeMember(id, name, classId, level, role) {
        const account = `bot_party_fixture_${id}`, Actor = invoke('GameServer/Actor/Actor');
        await Database.createAccount(account, 'fixture');
        const created = await Database.createCharacter(account, { name, race: classId === 49 ? 3 : 0, classId,
            maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, ...nativeSpot.center });
        // Preserve the original ownership IDs in the isolated native database;
        // the character allocator normally starts at 2000000.
        await Database.execute(['UPDATE characters SET id = ? WHERE id = ?', [id, Number(created.insertId)]]);
        const Catalog = invoke('GameServer/Skills/SkillBookCatalog'), ranks = [];
        for (const entry of Catalog.entries(classId)) {
            let learned = 0, training;
            while ((training = Catalog.nextTraining(classId, level, entry.selfId, learned))) {
                ranks.push(training); learned = training.level;
            }
        }
        await Database.execute(['UPDATE characters SET level = ?, exp = ?, sp = ? WHERE id = ?',
            [level, Data.experience[level - 1], ranks.reduce((sum, rank) => sum + rank.sp, 0), id]]);
        for (const rank of ranks) assert((await Database.learnBotSkill(id, rank.skillId, rank.level)).learned);
        // This promoted character still owns the authored kit from milestone10;
        // it has not acquired its current level20 equipment milestone yet.
        for (const entry of require('./fixtures/profitable_stock_state').kitFor(classId, 10).entries)
            await Database.setItem(id, { selfId: entry.selfId, name: entry.name, amount: 1, equipped: true, slot: entry.slot });
        const items = await Database.fetchItems(id), paperdoll = Array.from({ length: 16 }, () => ({}));
        for (const row of items.filter(row => row.equipped)) paperdoll[row.slot] = { id: row.id, selfId: row.selfId };
        const session = { accountId: account, currentSpot: nativeSpot, plan: 'hunting', dataSendToMe() {}, dataSendToOthers() {} };
        session.actor = new Actor(session, { ...(await Database.fetchCharacters(account))[0],
            ...utils.crushOb(Data.classTemplates.find(row => row.classId === classId)), items, paperdoll });
        session.actor.skillset.populateSnapshot(await Database.fetchSkills(id));
        invoke(global.path.actor).calculateStats(session, session.actor);
        session.actor.setHp(session.actor.fetchMaxHp()); session.actor.setMp(session.actor.fetchMaxMp());
        const state = invoke('GameServer/Bot/Economy/EconomyContext').stateForActor(session.actor);
        return { ...state, name, phase: 'cold', party: { role }, stats: { ...state.stats, role } };
    }
    // Knight and Cleric are available from level20; raise the original fixture
    // by five levels while retaining its +1 recruit and +10 excluded candidate.
    const nativeRows = [await nativeMember(1, 'Tank', 4, 20, 'tank'), await nativeMember(2, 'Healer', 15, 20, 'healer'),
        await nativeMember(3, 'Buffer', 49, 20, 'buffer'), await nativeMember(4, 'Dps', 0, 21, 'dps')];
    // Ownership/party fixtures use synthetic coordinates on an open plane.
    Geo.getCellData = (x, y, z) => ({ z, nswe: 15 });
    Geo.getHeight = (x, y, z) => z;
    Geo.hasGeo = () => true;
    Geo.hasLineOfSight = () => true;
    Config.partyMinSize = 2;
    Config.partyMaxSize = 5;
    let projectionCalls = 0;
    PartyState.active = () => [];
    PartyState.counts = () => ({ active: 0 });
    LifeState.coldPartyCandidateProjections = () => {
        projectionCalls += 1;
        return Promise.resolve([]);
    };
    LifeState.coldPartyCandidates = () => Promise.resolve([]);
    LifeState.coldPartyCandidatesForSpots = () => Promise.resolve([]);
    LifeState.cachedStatesForParties = () => Promise.resolve(new Map());
    PopulationService.resolving = false;
    PopulationService.partyFormationRunning = false;
    await PopulationService.formBackgroundParties();
    assert.strictEqual(projectionCalls, 1, 'party formation must discover the complete lightweight candidate projection once');

    PartyState.active = originals.active;
    PartyState.counts = originals.counts;
    LifeState.coldPartyCandidateCount = originals.coldPartyCandidateCount;
    LifeState.coldPartyCandidates = originals.coldPartyCandidates;
    LifeState.coldPartyCandidatesForSpots = originals.coldPartyCandidatesForSpots;
    LifeState.cachedStatesForParties = originals.cachedStatesForParties;
    LifeState.coldPartyCandidateProjections = originals.coldPartyCandidateProjections;

    const party = { partyId: 'bgp_1', leaderId: 1, memberIds: [1, 2], spotId: NATIVE_SPOT, stats: {} };
    const members = nativeRows.slice(0, 2);
    const candidates = [
        ...nativeRows.slice(2),
        { characterId: 5, name: 'FarAway', level: 30, spotId: NATIVE_SPOT, party: { role: 'buffer' } },
        { characterId: 6, name: 'OtherSpot', level: 20, spotId: 'dion', party: { role: 'buffer' } }
    ];
    const assigned = [];
    const events = [];
    let saved = null;

    PartyState.active = () => [party];
    LifeState.statesForParty = () => Promise.resolve(members);
    LifeState.cachedStatesForParties = () => Promise.resolve(new Map([['bgp_1', members]]));
    LifeState.assignParty = (state, partyId, role, leaderId) => {
        assigned.push({ state, partyId, role, leaderId });
        return Promise.resolve(state);
    };
    PartyState.createOrUpdate = (nextParty) => {
        saved = nextParty;
        return Promise.resolve(nextParty);
    };
    LifeEvents.record = (...args) => {
        events.push(args);
        return Promise.resolve(null);
    };

    const Income = invoke('GameServer/Bot/Population/PartyIncomeComparison');
    const prepared = Income.prepare(nativeRows, { party });
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const unbuffedGroup = Match.spotMatchup(nativeSpot, Match.stateProfiles(nativeRows[0],
        { timestamp: prepared.timestamp, capacityStates: nativeRows, mode: 'party' }), { soloSafety: true });
    const profiles = nativeRows.map(row => {
        const own = Match.stateProfiles(row, { timestamp: prepared.timestamp });
        return { characterId: row.characterId, classId: row.stats.classId, level: row.level,
            skillSource: row.stats.coldCombat.skillSource, learnedRanks: row.stats.coldCombat.skills.length,
            equipped: Object.values(row.inventory).filter(item => item.equipped).map(item => item.selfId),
            combat: own.map(profile => ({ maxHp: profile.maxHp, pDef: profile.pDef, pAtk: profile.pAtk, mAtk: profile.mAtk })),
            solo: Match.spotMatchup(nativeSpot, own, { soloSafety: true }) };
    });
    const comparisons = nativeRows.map(row => ({ characterId: row.characterId,
        ...Income.compare(row, nativeRows.filter(peer => peer !== row), { party, prepared }) }));
    const diagnostics = { unbuffedGroup, profiles, comparisons };
    require('node:fs').mkdirSync(require('node:path').resolve(__dirname, '../tmp/ci-repair'), { recursive: true });
    require('node:fs').writeFileSync(require('node:path').resolve(__dirname, '../tmp/ci-repair/party-prior10-native-input.json'),
        JSON.stringify({ ...diagnostics, spot: nativeSpot, states: nativeRows.map(row => ({ ...row, physicalInventory: undefined })) }, null, 2));
    console.log('Native ordinary profile:', JSON.stringify(diagnostics));
    if (!comparisons.every(row => row.accept)) console.error('Native ordinary admission:', JSON.stringify(comparisons));
    assert(comparisons.every(row => row.accept), 'the unchanged native comparison admits every member before recruitment');
    // Native physical preparation ends here; the original ownership checks
    // below use mocked assignments, not persisted cold-life membership rows.
    await Database.close();
    // A far party (cold leader): the pass records the pending join for the
    // leader's step and joins nobody itself.
    const originalFind = PartyState.find;
    PartyState.find = () => ({ ...party, status: 'active' });
    const pendingPass = await PopulationService.recruitBackgroundMembers(candidates);
    PartyState.find = originalFind;
    assert.deepStrictEqual([...pendingPass], [3, 4], 'a far party claims its recruits for this pass');
    assert.deepStrictEqual(saved.stats.pendingRecruits, { ids: [3, 4] }, 'a far party records the pending join');
    assert.deepStrictEqual(saved.memberIds, [1, 2]);
    assert.deepStrictEqual(assigned, [], 'a far party joins nobody before its leader\'s check');
    // A party near the player (hot leader): the check runs here and joins.
    members[0] = { ...members[0], phase: 'hot' };
    const recruited = await PopulationService.recruitBackgroundMembers(candidates);
    assert.deepStrictEqual([...recruited], [3, 4]);
    assert.deepStrictEqual(assigned.map((entry) => entry.state.characterId), [3, 4]);
    assert.deepStrictEqual(saved.memberIds, [1, 2, 3, 4]);
    assert.deepStrictEqual(saved.roleCoverage, { tank: 1, healer: 1, buffer: 1, dps: 1 });
    assert.strictEqual(saved.leaderId, 1, 'recruitment must preserve an attached party leader');
    assert.strictEqual(events.length, 1);

    const staleLeaderParty = { partyId: 'bgp_stale_leader', leaderId: 999, memberIds: [1, 2], spotId: NATIVE_SPOT, stats: {} };
    let staleLeaderSaved = null;
    PartyState.active = () => [staleLeaderParty];
    LifeState.cachedStatesForParties = () => Promise.resolve(new Map([['bgp_stale_leader', members]]));
    PartyState.createOrUpdate = (nextParty) => {
        staleLeaderSaved = nextParty;
        return Promise.resolve(nextParty);
    };
    await PopulationService.recruitBackgroundMembers([
        { ...nativeRows[3], characterId: 7, name: 'StaleLeaderRecruit' }
    ]);
    assert.strictEqual(staleLeaderSaved.leaderId, 1,
        'recruitment must re-elect an attached member when the stored leader has already departed');
    assert.deepStrictEqual(
        assigned.filter((entry) => entry.partyId === 'bgp_stale_leader').map((entry) => entry.leaderId),
        [1, 1, 1],
        'retained members and recruits must receive the elected leader id'
    );

    const sharedParties = [
        { partyId: 'bgp_shared_a', leaderId: 50, memberIds: [50, 51, 52, 53], spotId: NATIVE_SPOT, stats: {} },
        { partyId: 'bgp_shared_b', leaderId: 54, memberIds: [54, 55, 56, 57], spotId: NATIVE_SPOT, stats: {} }
    ];
    const sharedMembers = new Map(sharedParties.map((sharedParty) => [
        sharedParty.partyId,
        sharedParty.memberIds.map((characterId, index) => ({
            ...nativeRows[index], characterId, phase: 'hot',
            name: `Member${characterId}`,
        }))
    ]));
    const sharedAssignments = [];
    PartyState.active = () => sharedParties;
    LifeState.cachedStatesForParties = () => Promise.resolve(sharedMembers);
    LifeState.assignParty = (state, partyId) => {
        sharedAssignments.push({ characterId: state.characterId, partyId });
        return Promise.resolve(state);
    };
    const sharedCandidates = await PopulationService.recruitBackgroundMembers([
        { ...nativeRows[3], characterId: 60, name: 'SharedOne' },
        { ...nativeRows[3], characterId: 61, name: 'SharedTwo' }
    ]);
    assert.deepStrictEqual([...sharedCandidates].sort((a, b) => a - b), [60, 61], 'a candidate must be claimed by only one active party per formation pass');
    assert.deepStrictEqual(sharedAssignments.map((entry) => entry.characterId).sort((a, b) => a - b), [60, 61]);

    const fairGroups = PopulationService.groupPartyCandidatesBySpot([
        { characterId: 101, level: 10, spotId: 'crowded', activity: 'party_wait', timing: { activityStartedAt: 20 } },
        { characterId: 102, level: 10, spotId: 'crowded', activity: 'party_wait', timing: { activityStartedAt: 20 } },
        { characterId: 103, level: 10, spotId: 'crowded', activity: 'party_wait', timing: { activityStartedAt: 20 } },
        { characterId: 104, level: 10, spotId: 'under_served', activity: 'party_wait', timing: { activityStartedAt: 10 } },
        { characterId: 105, level: 10, spotId: 'under_served', activity: 'party_wait', timing: { activityStartedAt: 10 } }
    ], {
        prioritizePartyWait: true,
        activePartiesBySpot: new Map([['crowded', 5]])
    });
    assert.strictEqual(fairGroups[0][0].spotId, 'under_served', 'party-wait groups must prefer a ground with no existing party over a larger but already saturated queue');

    const objectiveGroups = PopulationService.groupPartyCandidatesByObjective([
        { characterId: 111, level: 25, spotId: 'fallback', activity: 'hunting', stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701:88', spotId: 'cruma' } } },
        { characterId: 112, level: 26, spotId: 'fallback', activity: 'hunting', stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701:88', spotId: 'cruma' } } },
        { characterId: 113, level: 25, spotId: 'fallback', activity: 'hunting', stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'craft:cruma:701:1988', spotId: 'cruma' } } }
    ], { prioritizePartyWait: true });
    assert.strictEqual(objectiveGroups.length, 2, 'party formation must keep different acquisition objectives separate even on one spot');
    assert.strictEqual(objectiveGroups[0].length, 2, 'compatible requesters must share an objective group');
    const clanObjectiveGroups = PopulationService.groupPartyCandidatesByObjective([
        { characterId: 114, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701', clanGoalKey: 'clan-equipment:77:114:88:7' } } },
        { characterId: 115, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'direct_drop:cruma:701', clanGoalKey: 'clan-equipment:78:115:88:7' } } }
    ]);
    assert.strictEqual(clanObjectiveGroups.length, 2,
        'different clan equipment goals must never merge merely because they hunt the same NPC');
    const prioritizedClanGroups = PopulationService.groupPartyCandidatesByObjective([
        { characterId: 116, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'large-normal' } } },
        { characterId: 117, level: 25, stats: { partyRequest: { status: 'open', priority: 'required', objectiveKey: 'large-normal' } } },
        { characterId: 118, level: 25, stats: { clanPartyObjective: { status: 'open', priority: 'required', objectiveKey: 'clan-route', clanId: 77, clanGoalKey: 'clan-equipment:77:118:88:7', clanOperation: 'equipment' } } }
    ], { prioritizePartyWait: true });
    assert.strictEqual(prioritizedClanGroups[0][0].characterId, 116,
        'clan origin alone must not override equal urgency and larger compatible demand');
    assert.strictEqual(PopulationService.partyObjectivesShareRoute(
        { spotId: 'cruma', npcId: 701, clanGoalKey: 'clan-equipment:77:114:88:7' },
        { spotId: 'cruma', npcId: 701, clanGoalKey: 'clan-equipment:78:115:88:7' }
    ), false, 'route compatibility must preserve clan ownership');
    assert.deepStrictEqual(
        PopulationService.partyLimitsForObjective({
            clanId: 77,
            clanOperation: 'equipment',
            minPartySize: 5,
            maxPartySize: 9,
            levelRange: 99
        }),
        { minSize: 5, maxSize: 9, levelRange: 99 },
        'a clan equipment objective may form one native nine-member party'
    );
    assert.strictEqual(
        PopulationService.requiresClanEquipmentParty({
            stats: {
                partyRequest: {
                    status: 'open',
                    priority: 'required',
                    clanId: 77,
                    clanOperation: 'equipment'
                }
            }
        }),
        true,
        'a required clan equipment roster must override elective persona party preferences'
    );
    assert.strictEqual(
        PartyRequestPlanner.partyObjectiveForState({
            stats: {
                partyRequest: { status: 'open', priority: 'required', objectiveKey: 'personal-route' },
                clanPartyObjective: {
                    status: 'open', priority: 'required', objectiveKey: 'clan-route', clanId: 77,
                    clanGoalKey: 'clan-equipment:77:114:88:7', clanOperation: 'equipment'
                }
            }
        }).objectiveKey,
        'clan-route',
        'a stale personal request must not hide the durable clan party objective'
    );

    const electiveParty = { partyId: 'bgp_elective', leaderId: 11, memberIds: [11, 12], spotId: 'cruma', startedAt: 1 };
    const requiredParty = { partyId: 'bgp_required', leaderId: 21, memberIds: [21, 22], spotId: 'dion', startedAt: 2 };
    const socialParty = { ...electiveParty, partyId: 'bgp_social', stats: { capacityPool: 'social' } };
    PartyState.active = () => [electiveParty, requiredParty, socialParty];
    Config.maxBackgroundParties = 2;
    Config.partyFormationBatchSize = 2;
    assert.strictEqual(PopulationService.partyCapacityLimit(), 2, 'without a backlog the base party capacity must remain unchanged');
    assert.strictEqual(PopulationService.partyCapacityLimit(), 2, 'all requests share one capacity ceiling');

    const activationOrder = [];
    ColdSimulationOwner.handoffToMain = async (state) => {
        activationOrder.push(`handoff:${state.characterId}`);
        return {
            ok: true,
            revision: Number(state.simulation?.revision || 0)
        };
    };
    const groupedState = {
        characterId: 91001,
        accountName: 'bot_activation_probe',
        name: 'ActivationProbe',
        phase: 'cold',
        activity: 'grouped',
        homeRegion: 'human',
        loc: { locX: -71300, locY: 258000, locZ: -3100 },
        stats: {},
        party: { partyId: 'bgp_activation_probe', leaderId: 91001 }
    };
    const releasedState = {
        ...groupedState,
        activity: 'hunting',
        party: { partyId: null, leaderId: null }
    };
    PartyState.setStatus = async (partyId, status) => {
        activationOrder.push(`status:${partyId}:${status}`);
        return { partyId, status };
    };
    LifeState.releaseDissolvedPartyMembers = async (partyId, reason) => {
        activationOrder.push(`release:${partyId}:${reason}`);
        return 2;
    };
    LifeState.cachedState = (characterId) => characterId === groupedState.characterId ? releasedState : null;
    SpotService.findCurrentSpot = () => null;
    BotManager.loadAndSpawnBot = (_accountName, options) => {
        activationOrder.push(`spawn:${options.coldLifeState?.party?.partyId || 'solo'}`);
        return Promise.resolve({ actor: {} });
    };

    Geo.getCellData = (x, y, z) => ({ z, nswe: 0 });
    const groupedInvite = await HotActivation.activate(groupedState, 'party_invite', { keepStoreLocation: true });
    assert.strictEqual(groupedInvite.reason, 'already_grouped', 'a player invite must never dissolve an existing roster');
    assert.deepStrictEqual(activationOrder, []);
    const unsafe = await HotActivation.activate(groupedState, 'manual', { keepStoreLocation: true, interruptBackgroundActivity: true });
    assert.strictEqual(unsafe.reason, 'no_safe_activation_placement');
    assert.deepStrictEqual(activationOrder, [], 'unsafe placement must not hand off ownership, dissolve the party or spawn');
    Geo.getCellData = (x, y, z) => ({ z, nswe: 15 });
    const activated = await HotActivation.activate(groupedState, 'manual', { keepStoreLocation: true, interruptBackgroundActivity: true });
    assert.strictEqual(activated.ok, true, 'an explicitly requested grouped bot should still materialize');
    assert.deepStrictEqual(
        activationOrder,
        [
            'handoff:91001',
            'status:bgp_activation_probe:dissolved',
            'release:bgp_activation_probe:hot_activation_manual',
            'spawn:solo'
        ],
        'background party cleanup must finish before a member spawns from the released solo snapshot'
    );

    activationOrder.length = 0;
    const travelingState = {
        ...groupedState,
        characterId: 91005,
        name: 'TravelingConstProbe',
        activity: 'traveling',
        party: { partyId: null, leaderId: null },
        stats: {
            travel: {
                from: groupedState.loc,
                to: { locX: -50000, locY: 250000, locZ: -3000 },
                arrivalAt: Date.now() + 20000
            }
        }
    };
    const blockedTravel = await HotActivation.activate(travelingState, 'remote_invite', {
        keepStoreLocation: true
    });
    assert.strictEqual(blockedTravel.reason, 'in_transit', 'ordinary activation must not interrupt background travel');
    let summonedState = null;
    LifeState.cachedState = () => null;
    BotManager.loadAndSpawnBot = (_accountName, options) => {
        summonedState = options.coldLifeState;
        return Promise.resolve({ actor: {} });
    };
    const summonedTravel = await HotActivation.activate(travelingState, 'remote_invite', {
        keepStoreLocation: true,
        interruptBackgroundActivity: true
    });
    assert.strictEqual(summonedTravel.ok, true, 'a const summon must interrupt background travel and activate the bot');
    assert.strictEqual(summonedState.activity, 'hunting', 'the interrupted travel must not survive into hot AI state');
    assert.strictEqual(summonedState.stats.travel, null, 'the stale background route must be cleared before the bot spawns');

    const inviteOriginals = {
        findClanById: ClanService.findById,
        findByName: LifeState.findByName,
        findSessionByName: BotManager.findSessionByName,
        botTell: BotManager.botTell,
        getSnapshot: BotSocialMemory.getSnapshot,
        recordEvent: BotSocialMemory.recordEvent,
        attach: PartyCompanionService.attach,
        enabled: Config.enabled
    };
    try {
        Config.enabled = true;
        const player = {
            actor: {
                fetchId: () => 92000,
                fetchName: () => 'ClanLeader',
                fetchClanId: () => 77,
                fetchLevel: () => 55,
                fetchLocX: () => 1000,
                fetchLocY: () => 2000,
                fetchLocZ: () => -3000
            },
            dataSendToMe() {}
        };
        BotSocialMemory.getSnapshot = () => ({ trust: 0, familiarity: 0, recentlyAbandonedAt: Date.now() });
        BotSocialMemory.recordEvent = () => Promise.resolve();
        BotManager.botTell = () => {};

        for (const [index, activity] of ['traveling', 'pk_hunting'].entries()) {
            const clanState = {
                ...travelingState,
                characterId: 92001 + index,
                name: `ClanSummon${index}`,
                level: 55,
                activity,
                // Cold snapshots can lag behind the current clan roster.
                stats: { ...travelingState.stats, clanId: 0 }
            };
            ClanService.findById = id => Number(id) === 77
                ? { id: 77, members: [{ id: clanState.characterId }] } : null;
            let hotSession = null;
            let attached = false;
            invoke('GameServer/Social/InteractionMemoryRuntime').accept(
                require('../src/GameServer/Social/InteractionMemoryPolicy').empty(clanState.characterId));
            LifeState.findByName = async () => clanState;
            BotManager.findSessionByName = () => hotSession;
            BotManager.loadAndSpawnBot = (_accountName, options) => {
                assert.strictEqual(options.coldLifeState.activity, 'hunting', 'clan summon must stop the background activity');
                assert.strictEqual(options.coldLifeState.stats.travel, null, 'clan summon must clear the old route');
                assert(Math.hypot(options.locX - 1000, options.locY - 2000) <= Config.activationRadius,
                    'a distant clan bot must materialize near the inviting player');
                hotSession = {
                    actor: {
                        ...player.actor,
                        fetchId: () => clanState.characterId,
                        fetchName: () => clanState.name,
                        fetchLevel: () => 55
                    },
                    plan: options.plan,
                    coldLifeState: options.coldLifeState
                };
                return Promise.resolve(hotSession);
            };
            PartyCompanionService.attach = (leader, companion, options) => {
                assert.strictEqual(leader, player);
                assert.strictEqual(companion, hotSession);
                assert.strictEqual(options.distribution, 1);
                PartyCompanionService.releaseCapacity(leader, options.capacityReservation);
                attached = true;
                return true;
            };

            assert.strictEqual(await World.inviteBotByName(player, player.actor, clanState.name, 1, 'invite'), true,
                `a normal party invite must summon a clan bot during ${activity} without a friend override`);
            assert.strictEqual(attached, true, 'the activated clan bot must proceed to party attachment');
        }
    } finally {
        ClanService.findById = inviteOriginals.findClanById;
        LifeState.findByName = inviteOriginals.findByName;
        BotManager.findSessionByName = inviteOriginals.findSessionByName;
        BotManager.botTell = inviteOriginals.botTell;
        BotSocialMemory.getSnapshot = inviteOriginals.getSnapshot;
        BotSocialMemory.recordEvent = inviteOriginals.recordEvent;
        PartyCompanionService.attach = inviteOriginals.attach;
        Config.enabled = inviteOriginals.enabled;
    }

    activationOrder.length = 0;
    const blockedState = {
        ...groupedState,
        characterId: 91002,
        name: 'BlockedActivationProbe'
    };
    LifeState.releaseDissolvedPartyMembers = async () => 0;
    LifeState.cachedState = (characterId) => characterId === blockedState.characterId ? blockedState : null;
    const blockedActivation = await HotActivation.activate(blockedState, 'manual', { keepStoreLocation: true, interruptBackgroundActivity: true });
    assert.strictEqual(blockedActivation.ok, false, 'a member must not spawn while its persisted party link is still present');
    assert.strictEqual(blockedActivation.reason, 'activation_prepare_failed');
    assert(!activationOrder.some((entry) => entry.startsWith('spawn:')), 'failed party cleanup must stop hot activation before spawning');

    activationOrder.length = 0;
    const failedSpawnState = {
        ...groupedState,
        characterId: 91004,
        name: 'FailedSpawnProbe'
    };
    LifeState.releaseDissolvedPartyMembers = async () => 2;
    LifeState.cachedState = (characterId) => characterId === failedSpawnState.characterId
        ? { ...releasedState, characterId: failedSpawnState.characterId, name: failedSpawnState.name }
        : null;
    BotManager.loadAndSpawnBot = () => Promise.resolve(null);
    ColdSimulationCoordinator.acceptColdState = async (state) => {
        activationOrder.push(`restore:${state.characterId}`);
        return { ok: true, reason: 'restored_for_test' };
    };
    const failedSpawn = await HotActivation.activate(failedSpawnState, 'spawn_failure', { keepStoreLocation: true, interruptBackgroundActivity: true });
    assert.strictEqual(failedSpawn.ok, false, 'failed hot spawn must be reported as failed');
    assert.strictEqual(activationOrder.at(-1), 'restore:91004', 'failed activation must return its released state to the cold worker');

    activationOrder.length = 0;
    const concurrentState = {
        ...groupedState,
        characterId: 91003,
        name: 'ConcurrentActivationProbe'
    };
    const concurrentReleasedState = {
        ...concurrentState,
        activity: 'hunting',
        party: { partyId: null, leaderId: null }
    };
    BotManager.loadAndSpawnBot = (_accountName, options) => {
        activationOrder.push(`spawn:${options.coldLifeState?.party?.partyId || 'solo'}`);
        return Promise.resolve({ actor: {} });
    };
    let releaseStatus;
    const releaseGate = new Promise((resolve) => { releaseStatus = resolve; });
    PartyState.setStatus = async () => releaseGate;
    LifeState.releaseDissolvedPartyMembers = async () => 2;
    LifeState.cachedState = (characterId) => characterId === concurrentState.characterId ? concurrentReleasedState : null;

    const firstActivation = HotActivation.activate(concurrentState, 'concurrent_first', { keepStoreLocation: true, interruptBackgroundActivity: true });
    const secondActivation = HotActivation.activate(concurrentState, 'concurrent_second', { keepStoreLocation: true, interruptBackgroundActivity: true });
    await Promise.resolve();
    releaseStatus({ partyId: concurrentState.party.partyId, status: 'dissolved' });
    const concurrentResults = await Promise.all([firstActivation, secondActivation]);
    assert.strictEqual(concurrentResults.filter((result) => result.ok).length, 1, 'only one concurrent request may activate a character');
    assert.strictEqual(concurrentResults.filter((result) => result.reason === 'activation_pending').length, 1, 'the competing request must observe the early activation reservation');
    assert.strictEqual(activationOrder.filter((entry) => entry.startsWith('spawn:')).length, 1, 'concurrent activation must create exactly one hot AI session');
    console.log('Bot background party recruitment checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(async () => {
    SpotService.spots = originalCatalog.spots; Spots.cache = originalCatalog.profiles;
    useRate(previousRate);
    Object.assign(Geo, originalGeo);
    PartyState.active = originals.active;
    PartyState.counts = originals.counts;
    LifeState.statesForParty = originals.statesForParty;
    LifeState.cachedStatesForParties = originals.cachedStatesForParties;
    LifeState.coldPartyCandidateProjections = originals.coldPartyCandidateProjections;
    LifeState.coldPartyCandidateCount = originals.coldPartyCandidateCount;
    LifeState.coldPartyCandidates = originals.coldPartyCandidates;
    LifeState.coldPartyCandidatesForSpots = originals.coldPartyCandidatesForSpots;
    LifeState.assignParty = originals.assignParty;
    LifeState.partyRequirementCounts = originals.partyRequirementCounts;
    LifeState.clearParty = originals.clearParty;
    LifeState.releaseDissolvedPartyMembers = originals.releaseDissolvedPartyMembers;
    LifeState.cachedState = originals.cachedState;
    PartyState.createOrUpdate = originals.createOrUpdate;
    PartyState.setStatus = originals.setStatus;
    BotManager.loadAndSpawnBot = originals.loadAndSpawnBot;
    SpotService.findCurrentSpot = originals.findCurrentSpot;
    LifeEvents.record = originals.record;
    ColdSimulationOwner.handoffToMain = originals.handoffToMain;
    ColdSimulationCoordinator.acceptColdState = originals.acceptColdState;
    ColdSimulationCoordinator.requestPartyGoals = originals.requestPartyGoals;
    Config.partyMinSize = originals.partyMinSize;
    Config.partyMaxSize = originals.partyMaxSize;
    Config.maxBackgroundParties = originals.maxBackgroundParties;
    Config.partyFormationBatchSize = originals.partyFormationBatchSize;
    Object.assign(PopulationService, originalFormationState);
    await world.close();
});
