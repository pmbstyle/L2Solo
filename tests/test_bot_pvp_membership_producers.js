'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require(path.join(gameRoot, 'src/Global'));

const directory = fs.mkdtempSync(path.join(gameRoot, 'tmp', 'pvp-membership-producers-'));
const databasePaths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
options.default.Database.path = databasePaths.world;
options.default.Database.historyPath = databasePaths.history;
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Index = invoke('GameServer/Bot/AI/BotPvpIndex');
const Database = invoke('Database');
const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
const previousUser = World.user;
const originalRefresh = World.refreshPartyMemberships;
const failures = [], publications = [], managerSessions = [], effects = [];
let serial = 9_870_000, publicationObserver = null;

// Full producer modules retain their lexical loader. World, Model, Index,
// publication helper and key policy are native. UI/navigation, the tool
// dispatch boundary and accepted persistence receipts below are controlled;
// this fixture makes no Native SQL, prepared companion or Worker claim.
function producer(relative, controlled) {
    const filename = path.join(gameRoot, 'src', relative);
    const module = { exports: {} };
    function load(name) {
        if (name === 'GameServer/World/World') return World;
        if (name === 'GameServer/Bot/AI/BotPvpIndex') return Index;
        if (Object.hasOwn(controlled, name)) return controlled[name];
        throw Error('undeclared producer dependency: ' + name);
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: createRequire(filename), invoke: load,
        utils: global.utils, path: global.path, options: global.options,
        console, Date, Promise, Map, Set, WeakMap, Buffer, setTimeout, clearTimeout
    }, { filename });
    return module.exports;
}

function session({ leader = null, partyId = null } = {}) {
    const id = ++serial, name = `bot_membership_producer_${id}`;
    const value = { accountId: name, partyCompanion: !!leader, followPlayerSession: leader,
        coldLifeState: partyId ? { characterId: id, phase: 'hot', party: { partyId } } : null,
        fetchAccountId() { return this.accountId; }, socket: { destroy() {} },
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    value.actor = new Actor({ id, name, username: name, clanId: 0, isOnline: false,
        level: 20, karma: 0, locX: 0, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
    value.actor.session = value;
    value.actor.unselect = () => effects.push('unselect');
    value.actor.moveTo = () => effects.push('move');
    value.actor.automation = { abortAll() {}, stopReplenish() {} };
    World.insertUser(value);
    value.actor.setIsOnline(true);
    managerSessions.push(value);
    const record = World.registeredActorById(id);
    assert.equal(record.session, value); assert.equal(record.actor, value.actor);
    assert.equal(Runtime.index.getSource(id, 'actor'), record);
    return value;
}

function reset() {
    World.user = { sessions: [], revision: 0 };
    managerSessions.length = 0; publications.length = 0; effects.length = 0;
    publicationObserver = null; Index.invalidate();
}

function refs(actual, expected, label) {
    assert.equal(actual.length, expected.length, label);
    expected.forEach((value, i) => assert.equal(actual[i], value, `${label}: original reference/order ${i}`));
}

function members(value, expected, label) { refs(Index.members(value), expected, label); }
function published(expected, label) {
    assert.equal(publications.length, 1, `${label}: one addressed publication`);
    refs(publications[0], expected, label);
}
async function check(name, work) {
    try { await work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); }
}

const noop = () => {};
const response = Object.fromEntries(['joinParty', 'partyMemberPosition', 'partySmallWindowAll',
    'partySmallWindowDeleteAll', 'partySmallWindowUpdate', 'sitAndStand']
    .map(name => [name, () => Buffer.alloc(0)]));
response.partySpelled = { fromActor: () => Buffer.alloc(0) };
const ai = { cancelScheduledTick: noop, wakeup: noop, say: noop, tell: noop };
const common = {
    'GameServer/Network/Response': response,
    'GameServer/Bot/BotManager': { sessions: managerSessions, botSay: noop },
    'GameServer/Bot/BotAI': ai,
    'GameServer/Bot/AI/PartyAwareness': {},
    'GameServer/Bot/AI/PartyCombatState': { isActive: () => false },
    'GameServer/Bot/AI/BotRoles': { inferRole: () => 'dps' },
    'GameServer/Bot/AI/BotEventJournal': { record: () => Promise.resolve(null) },
    'GameServer/Karma': invoke('GameServer/Karma'),
    'GameServer/Bot/AI/BotSupportPlanner': { cancelSupportCast: noop },
    'GameServer/Bot/BotTradeService': { cleanup: noop },
    'GameServer/Bot/AI/HotBotPolicyOverlay': { clearForPartyDetach: noop },
    'GameServer/Bot/AI/BotSocialMemory': { recordEvent: noop },
    'GameServer/World/Generics/NpcBypasses/CompanionControl': { render: noop },
    [global.path.actor]: { teleportTo: () => false }
};

async function main() {
    assert.equal(Database.isReady(), false);
    assert.equal(World.pvpPartyMembershipIndex, true, 'real native prerequisite is required');
    World.refreshPartyMemberships = function (changed) {
        publications.push(Array.from(changed));
        publicationObserver?.(changed);
        return originalRefresh.call(this, changed);
    };
    console.log('BOUNDARY', JSON.stringify({ gameRoot, controlled: ['UI/navigation', 'tool dispatch', 'persistence receipts'],
        native: ['World', 'Model', 'Index', 'publication helper', 'full producer bodies'], databaseInitialized: false }));

    const Companion = producer('GameServer/Bot/AI/PartyCompanionService.js', common);

    await check('actual companion attach and detach publish after original ownership fields', () => {
        reset();
        const leader = session(), companion = session();
        members(leader, [leader], 'before attach');
        assert.equal(Companion.attach(leader, companion), true);
        published([companion], 'attach');
        members(leader, [leader, companion], 'attach enters addressed group');
        assert.equal(companion.partyCompanion, true); assert.equal(companion.followPlayerSession, leader);
        publications.length = 0;
        assert.equal(Companion.detach(leader, companion), true);
        published([companion], 'detach');
        members(leader, [leader], 'detach removes old group');
        members(companion, [companion], 'detached original seed');
    });

    await check('actual full attachRoster publishes once after the entire roster changes', () => {
        reset();
        const leader = session(), first = session({ partyId: 'producer_old' }), second = session({ partyId: 'producer_old' });
        first.hotBackgroundPartyId = second.hotBackgroundPartyId = 'producer_old';
        const states = [first, second].map(value => ({ characterId: value.actor.fetchId(), phase: 'hot', party: null }));
        publicationObserver = changed => {
            refs(changed, [first, second], 'complete addressed roster');
            [first, second].forEach(value => {
                assert.equal(value.partyCompanion, true); assert.equal(value.followPlayerSession, leader);
                assert.equal(value.hotBackgroundPartyId, null); assert.equal(value.plan, 'following');
                assert.equal(value.coldLifeState, states.find(state => state.characterId === value.actor.fetchId()));
            });
        };
        const result = Companion.attachRoster(leader, [first, second], { expectedBackgroundPartyId: 'producer_old', lifeStates: states });
        assert.equal(result.ok, true); published([first, second], 'attachRoster');
        members(leader, [leader, first, second], 'complete roster query');
    });

    await check('actual buff completion and exhausted guide restore companion membership', () => {
        const Buff = producer('GameServer/Bot/AI/States/GettingBuffedState.js', {
            'GameServer/Bot/AI/BotSpeechTemplates': { lines: () => [] },
            'GameServer/Bot/AI/BotBuffs': { needsNewbieRefresh: () => false },
            'GameServer/Bot/AI/PartyCombatState': { isActive: () => false },
            'GameServer/Bot/AI/CompanionNavigationRecovery': { clear: noop, move: () => ({ status: 'exhausted' }) },
            'GameServer/Bot/AI/TownNpcApproach': { reset: noop, planOpen: () => ({ ready: false, waiting: false }) },
            'GameServer/Bot/AI/TownChatter': { say: noop }, 'GameServer/Bot/AI/HotTownRebuff': {}
        });
        for (const exhausted of [false, true]) {
            reset(); const leader = session(), companion = session();
            companion.resumeAfterBuff = { plan: 'following', followPlayerSession: leader,
                conditionalNewbieBuff: !exhausted, role: 'dps', botStay: false };
            Buff.tick(companion, companion.actor, {}, { getClosestNewbieGuide: () => ({ locX: 0, locY: 0, locZ: 0 }), say: noop });
            published([companion], exhausted ? 'exhausted guide' : 'completed buff');
            members(leader, [leader, companion], 'restored original leader');
            assert.equal(companion.resumeAfterBuff, undefined);
        }
    });

    await check('actual hunt fallback and following loss publish; valid companion hunt stays attached', () => {
        const registry = new Map();
        const controlled = { ...common,
            'GameServer/Bot/AI/BotToolRegistry': { register: tool => registry.set(tool.name, tool), execute(context) {
                const tool = registry.get(context.decision.action);
                assert(tool.available(context.session)); return tool.execute(context);
            } },
            'GameServer/Bot/AI/BotChatText': { normalize: text => String(text || ''), DEFAULT_LINE_LIMIT: 120, DEFAULT_MAX_LINES: 3 },
            'GameServer/Bot/AI/ChatArrivalState': { clear: noop }
        };
        for (const name of ['SpotService', 'BotBuffs', 'BotSkillCapabilities', 'BotCombatUtility',
            'BotEquipmentUpgrade', 'BotAvailability']) controlled['GameServer/Bot/AI/' + name] = {};
        controlled['GameServer/Actor/Attack'] = {};
        controlled['GameServer/Bot/Economy/BotNegotiationService'] = {};
        controlled['GameServer/Bot/AI/PartyCompanionService'] = Companion;
        const Tools = producer('GameServer/Bot/AI/BotAgentTools.js', controlled);
        reset(); const leader = session(), companion = session({ leader });
        const decision = { action: 'hunt', confidence: 1, reply: '' };
        assert.equal(Tools.execute(companion, decision, []).reason, 'party_hunt');
        assert.equal(publications.length, 0); members(leader, [leader, companion], 'valid hunt keeps ownership');
        // An explicitly controlled incomplete original input takes the actual
        // fallback branch. No earlier setter/native attachment claim is made.
        companion.followPlayerSession = null;
        assert.equal(Tools.execute(companion, decision, []).reason, 'hunt');
        published([companion], 'hunt fallback'); members(leader, [leader], 'hunt removes old derived key');

        const followingDeps = { ...common, 'GameServer/SpeckMath': {},
            'GameServer/Bot/AI/PartyCompanionService': Companion, 'GameServer/Effects/EffectStore': {},
            'GameServer/Inventory/ShotStock': {}, 'GameServer/Bot/TradeService': {},
            'GameServer/Bot/Economy/TownServiceCatalog': {}, 'GameServer/Bot/Economy/ItemDisposition': {} };
        for (const name of ['SummonerTactics', 'BotBuffs', 'BotSkillCapabilities', 'BotWorkflowTelemetry', 'PartyPulling',
            'PartyRevivalService', 'BotPartyChat', 'CompanionEquipmentShopping', 'TownPathfinder', 'BotRetreatPlanner',
            'PartyClassTactics', 'BotRaidSafety', 'HotActorLodPolicy', 'HotTownRebuff', 'CompanionTownTransit', 'BotHuntingVisibility']) {
            followingDeps['GameServer/Bot/AI/' + name] = {};
        }
        const Following = producer('GameServer/Bot/AI/States/FollowingState.js', followingDeps);
        reset(); const owner = session(), follower = session({ leader: owner });
        follower.partyCompanion = false; // Controlled existing field input, before actual tick.
        Following.tick(follower, follower.actor, {}, ai);
        published([follower], 'following loss'); members(owner, [owner], 'old owner bucket removed');
        assert.equal(follower.followPlayerSession, null);
        reset(); const offlineOwner = session(), retained = session({ leader: offlineOwner });
        offlineOwner.actor.setIsOnline(false);
        Following.tick(retained, retained.actor, {}, ai);
        assert.equal(publications.length, 0); members(offlineOwner, [offlineOwner, retained], 'disconnection policy does not detach');
    });

    await check('actual autonomous form and restore publish complete accepted original state receipts', async () => {
        reset(); const first = session(), second = session();
        const states = new Map([first, second].map(value => [value.actor.fetchId(),
            { characterId: value.actor.fetchId(), phase: 'hot', activity: 'hunting', stats: {} }]));
        let released = 0, commits = 0, formations = 0;
        const life = { settleWrites: () => Promise.resolve(), cachedState: id => states.get(id),
            preparePartyAssignment(state, partyId, role, leaderId) {
                return { row: { ...state, partyId }, snapshot: { ...state, party: { partyId, role, leaderId } } };
            }, acceptPartyAssignments: assignments => assignments.map(entry => entry.snapshot), acceptLifecycleRow: row => row };
        const parties = { prepareCommit: value => ({ row: { ...value, updatedAt: Date.now() }, snapshot: { ...value } }),
            acceptCommit: noop, acceptRow: row => row };
        const controlled = {
            'GameServer/Bot/Population/BotLifeState': life,
            'GameServer/Bot/Population/BackgroundPartyState': parties,
            'GameServer/Bot/Population/HotPartyLifecycle': { pending: new Set() },
            'GameServer/Bot/Population/PopulationService': { reserveCompetitionPartySlot: () => () => { released++; } },
            'GameServer/Bot/Population/BackgroundPartyComposition': { chooseLeader: values => values[0], roleCoverage: () => ({}), roleForState: () => 'dps' },
            'GameServer/Bot/Population/PopulationMetrics': { recordPartyFormation() { formations++; }, recordPartyRecruit: noop },
            Database: { commitBackgroundPartyMembership: input => { assert.equal(input.canCommitHot(), true); commits++; return Promise.resolve({ ok: true }); } }
        };
        const Form = producer('GameServer/Bot/AI/HotCompetitionParty.js', controlled);
        publicationObserver = changed => [first, second].forEach(value => {
            assert.equal(changed.includes(value), true); assert.equal(value.plan, 'hunting');
            assert.equal(value.hotBackgroundPartyId, value.coldLifeState.party.partyId);
            assert.equal(value.hotCompetitionHold, null);
        });
        const formed = await Form.form([{ sessions: [first] }, { sessions: [second] }],
            { at: Date.now(), spotId: 'producer_spot', npcId: 1, mob: {} }, () => true);
        assert.equal(formed.ok, true); assert.equal(commits, 1); assert.equal(formations, 1); assert.equal(released, 1);
        published([first, second], 'autonomous form'); members(first, [first, second], 'new autonomous shared key');
        const newStates = [first, second].map(value => ({ ...value.coldLifeState, party: { partyId: 'producer_restored' } }));
        const restoredParty = { partyId: 'producer_restored', memberIds: newStates.map(value => value.characterId) };
        const Restore = producer('GameServer/Bot/AI/PlayerPartyTakeover.js', {
            'GameServer/Actor/PartyRewardMath': require(path.join(gameRoot, 'src/GameServer/Actor/PartyRewardMath')),
            'GameServer/Bot/Population/BotLifeState': life, 'GameServer/Bot/Population/BackgroundPartyState': parties,
            'GameServer/Bot/Population/ColdSimulationCoordinator': {}, 'GameServer/Bot/BotAI': ai,
            Database: { restoreTakenOverBackgroundParty: () => Promise.resolve({ ok: true, party: restoredParty, rows: newStates }) }
        });
        publications.length = 0;
        publicationObserver = changed => newStates.forEach(state => {
            const value = changed.find(candidate => candidate.actor.fetchId() === state.characterId);
            assert.equal(value.coldLifeState, state); assert.equal(value.hotBackgroundPartyId, 'producer_restored');
        });
        const restored = await Restore.restoreAutonomousParty({ partyId: formed.partyId, playerId: 1, companionSessions: [first, second] });
        assert.equal(restored.ok, true); published([first, second], 'autonomous restore');
        members(first, [first, second], 'restoration keeps original per-key order');
        assert.equal(first.hotCompetitionCommit, null); assert.equal(second.hotCompetitionCommit, null);
    });

    await check('actual merchant failure restores a new source object and retires only its old key', async () => {
        reset(); const oldOwner = session({ partyId: 'producer_before_restore' }), changed = session({ partyId: 'producer_before_restore' }),
            newOwner = session({ partyId: 'producer_after_restore' });
        const oldState = changed.coldLifeState;
        const newState = { characterId: changed.actor.fetchId(), phase: 'hot', party: { partyId: 'producer_after_restore' } };
        const Merchant = producer('GameServer/Bot/Economy/BotMerchantStoreService.js', { 'GameServer/Network/Response': response });
        const result = await Merchant.restoreAfterPartyFailure(changed, { rollback: { plan: 'hunting', coldLifeState: newState, store: null } });
        assert.equal(result.ok, true); assert.notEqual(changed.coldLifeState, oldState); assert.equal(changed.coldLifeState, newState);
        published([changed], 'fresh source restoration'); members(oldOwner, [oldOwner], 'old key removed');
        members(newOwner, [newOwner, changed], 'new original state key uses original registered order');
    });

    assert.equal(Database.isReady(), false, 'metadata producer controls never initialize Database');
    assert.equal(Object.values(databasePaths).some(file => fs.existsSync(file)), false, 'no world/history SQL file is created');
    if (failures.length) throw Error('producer contracts failed: ' + failures.join(', '));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    const databaseReady = Database.isReady();
    const databaseFilesCreated = Object.values(databasePaths).filter(file => fs.existsSync(file)).length;
    World.refreshPartyMemberships = originalRefresh; World.user = previousUser; Index.invalidate();
    fs.rmSync(directory, { recursive: true, force: true });
    console.log('CLEANUP', JSON.stringify({ databaseReady, databaseFilesCreated,
        disposableRemoved: !fs.existsSync(directory), worldRestored: World.user === previousUser,
        publicationsRestored: World.refreshPartyMemberships === originalRefresh, failures: failures.length }));
});
