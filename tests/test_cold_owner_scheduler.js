const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

function state(characterId, activity = 'hunting', stats = {}) {
    return {
        characterId,
        accountName: `owner_${characterId}`,
        name: `Owner${characterId}`,
        level: 20,
        exp: 1000,
        sp: 100,
        adena: 500,
        phase: 'cold',
        activity,
        spotId: 'owner_spot',
        loc: { locX: 1, locY: 2, locZ: 3 },
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 },
        timing: { activityStartedAt: 100, nextResolveAt: 1000, lastResolvedAt: 500, lastHotAt: null },
        party: { partyId: null },
        stats,
        inventory: {},
        simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: 0, leaseId: null, leaseUntil: 0 },
        updatedAt: 1000
    };
}

const originals = {
    prepareResolve: LifeState.prepareResolve,
    cachedState: LifeState.cachedState,
    syncResolvedState: LifeState.syncResolvedState,
    recordMany: LifeEvents.recordMany,
    claim: Owner.claim,
    commit: Owner.commit,
    release: Owner.release,
    resolveSolo: BackgroundResolver.resolveSolo,
    findForState: SpotProfiles.findForState,
    pressureForState: Director.pressureForState,
    maybeAnnounce: GlobalChat.maybeAnnounce,
    resolveColdState: PopulationService.resolveColdState,
    timeoutMs: Config.coldOwnerResolveTimeoutMs
};

(async () => {
    let cached = null;
    let claims = 0;
    let commits = 0;
    let releases = 0;
    let legacyResolves = 0;

    Owner.claim = async (candidate) => {
        claims += 1;
        return { ok: true, characterId: candidate.characterId, ownerId: Owner.OWNER_ID, revision: 1, leaseId: `lease-${candidate.characterId}`, leaseUntil: Date.now() + 30000 };
    };
    Owner.commit = async (token, nextState) => {
        commits += 1;
        cached = { ...nextState, simulation: { ownerId: Owner.OWNER_ID, revision: token.revision + 1, leaseId: token.leaseId, leaseUntil: Date.now() + 30000 } };
        return { ok: true, characterId: token.characterId, ownerId: Owner.OWNER_ID, revision: token.revision + 1, leaseId: token.leaseId, leaseUntil: Date.now() + 30000 };
    };
    Owner.release = async (token) => {
        releases += 1;
        if (cached) cached = { ...cached, simulation: { ownerId: Owner.LEGACY_OWNER_ID, revision: token.revision + 1, leaseId: null, leaseUntil: 0 } };
        return { ok: true, characterId: token.characterId, ownerId: Owner.LEGACY_OWNER_ID, revision: token.revision + 1, leaseId: null, leaseUntil: 0 };
    };
    LifeState.prepareResolve = async (candidate) => ({
        ...candidate,
        exp: candidate.exp + 10,
        timing: { ...candidate.timing, lastResolvedAt: Date.now(), nextResolveAt: Date.now() + 30000 }
    });
    LifeState.cachedState = () => cached;
    LifeState.syncResolvedState = async (candidate) => candidate;
    LifeEvents.recordMany = async () => [];
    BackgroundResolver.resolveSolo = () => ({
        patch: { activity: 'hunting' },
        events: [],
        materialize: { exp: 10, sp: 1, adena: 2, items: [] },
        nextResolveAt: Date.now() + 30000,
        debug: { fights: 1, wins: 1 }
    });
    SpotProfiles.findForState = () => ({ id: 'owner_spot' });
    Director.pressureForState = () => ({});
    GlobalChat.maybeAnnounce = () => false;
    PopulationService.resolveColdState = async (candidate) => {
        legacyResolves += 1;
        return { ok: true, state: candidate, legacy: true };
    };

    const ownerResult = await PopulationService.resolveOwnedColdState(state(1));
    assert.strictEqual(ownerResult.ok, true, 'owner-capable state must complete the owner pipeline');
    assert.strictEqual(claims, 1);
    assert.strictEqual(commits, 1);
    assert.strictEqual(releases, 1);
    assert.strictEqual(legacyResolves, 0, 'owner-capable state must not call legacy apply');
    assert.strictEqual(ownerResult.state.simulation.ownerId, Owner.LEGACY_OWNER_ID, 'successful work must release ownership');

    const legacyResult = await PopulationService.resolveOwnedColdState(state(2, 'merchant', { marketStore: {} }));
    assert.strictEqual(legacyResult.legacy, true, 'market state must remain explicitly legacy-main');
    assert.strictEqual(claims, 1, 'legacy state must not be claimed');
    assert.strictEqual(legacyResolves, 1);

    LifeState.prepareResolve = async () => { throw new Error('resolver_probe_failure'); };
    const failed = await PopulationService.resolveOwnedColdState(state(3));
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(releases, 2, 'resolver error must release its active claim');

    Config.coldOwnerResolveTimeoutMs = 1;
    LifeState.prepareResolve = () => new Promise(() => {});
    const timedOut = await PopulationService.resolveOwnedColdState(state(4));
    assert.strictEqual(timedOut.ok, false);
    assert.strictEqual(timedOut.reason, 'cold_owner_resolve_timeout');
    assert.strictEqual(releases, 3, 'timeout must release its active claim');

    LifeState.prepareResolve = async (candidate) => ({ ...candidate, exp: candidate.exp + 1 });
    const retiredScheduler = await PopulationService.tickBudgeted();
    assert.deepStrictEqual(retiredScheduler, [], 'the retired main-thread scheduler must not resolve a mixed batch');
    assert.strictEqual(legacyResolves, 1, 'legacy-main fallback remains available only through an explicit resolve call');

    console.log('Cold owner and legacy fallback checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    LifeState.prepareResolve = originals.prepareResolve;
    LifeState.cachedState = originals.cachedState;
    LifeState.syncResolvedState = originals.syncResolvedState;
    LifeEvents.recordMany = originals.recordMany;
    Owner.claim = originals.claim;
    Owner.commit = originals.commit;
    Owner.release = originals.release;
    BackgroundResolver.resolveSolo = originals.resolveSolo;
    SpotProfiles.findForState = originals.findForState;
    Director.pressureForState = originals.pressureForState;
    GlobalChat.maybeAnnounce = originals.maybeAnnounce;
    PopulationService.resolveColdState = originals.resolveColdState;
    Config.coldOwnerResolveTimeoutMs = originals.timeoutMs;
});
