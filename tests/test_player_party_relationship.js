const assert = require('assert');
require('../src/Global');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const Legacy = invoke('GameServer/Bot/AI/BotSocialMemory');
const Runtime = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Bridge = require('../src/GameServer/Social/PlayerPartyRelationship');
const Revenge = require('../src/GameServer/Social/RevengePolicy');
const original = { get: Legacy.getSnapshot, peek: Legacy.peekSnapshot, clans: Runtime.clanSocial };
const actor = (id, clanId = 0) => ({ fetchId: () => id, fetchName: () => `Actor${id}`,
    fetchLevel: () => 40, fetchClanId: () => clanId, fetchLocX: () => 0, fetchLocY: () => 0,
    fetchLocZ: () => 0, isDead: () => false });
let at = 1789068000000, legacy = { trust: 20, familiarity: 30, recentlyAbandonedAt: null };
const player = { actor: actor(501) }, botId = 502;
const persona = { primaryDrive: 'social', traits: { sociability: .8, empathy: .3, commitment: .6,
    assertiveness: .9, caution: .1, resilience: .1 } };
const hot = { actor: actor(botId), accountId: 'bot_relationship', plan: 'hunting', persona };
const cold = { characterId: botId, level: 40, phase: 'cold', activity: 'hunting',
    loc: { locX: 0, locY: 0, locZ: 0 }, vitals: { hp: 100 }, stats: {}, persona };
const assessBoth = () => [Availability.evaluate(player, hot, { timestamp: at, loadMemory: false }),
    Availability.evaluateState(player, cold, { timestamp: at, loadMemory: false })];
let snapshot = Policy.empty(botId);
const event = type => {
    snapshot = Policy.apply(snapshot, { key: `story:${type}:${at}`, sourceId: botId,
        targetId: 501, type, at }, at).snapshot;
    Runtime.accept(snapshot);
};
(async () => { try {
    Legacy.getSnapshot = Legacy.peekSnapshot = () => legacy;
    Runtime.clanSocial = null;
    for (const result of assessBoth()) assert.strictEqual(result.reason, 'relationship_unloaded',
        'unloaded field memory cannot silently turn a remembered killer into a stranger');
    Runtime.accept(snapshot);
    assert(assessBoth().every(r => r.available), 'known legacy partners remain eligible with loaded neutral field memory');
    event('killed'); at += 60000; event('killed'); at += 60000; event('killed');
    const angry = Runtime.assess({ id: botId }, { id: 501 }, {}, at);
    const angrySnapshot = structuredClone(snapshot);
    assert(Revenge.evaluate(angry, persona).chance > 0, 'the same grievance can motivate revenge');
    for (const result of assessBoth()) {
        assert.strictEqual(result.reason, 'relationship_hostile');
        assert.strictEqual(result.relationship, 'hostile');
    }
    hot.actor = actor(botId, 77); player.actor = actor(501, 77); cold.stats.clanId = 77;
    assert(assessBoth().every(r => r.reason === 'relationship_hostile'), 'clan membership cannot erase personal harm');
    assert(Availability.evaluate(player, hot, { timestamp: at, forceFriend: true }).available,
        'the explicit const-friend override remains authoritative');
    hot.actor = actor(botId); player.actor = actor(501); cold.stats.clanId = 0;
    at += 14 * 86400000; event('resurrected');
    assert(assessBoth().every(r => r.available), 'real reconciliation repairs admission without rewriting legacy history');
    assert.strictEqual(Revenge.evaluate(Runtime.assess({ id: botId }, { id: 501 }, {}, at), persona).chance, 0);
    hot.pvpAggressors = new Map([[501, { at }]]);
    assert.strictEqual(Availability.evaluate(player, hot, { timestamp: at }).reason, 'relationship_hostile',
        'a current attacker cannot invite before its queued memory is persisted');
    delete hot.pvpAggressors;
    const partial = { ready: true, personal: { trust: 4, familiarity: 1, hostility: 0 } };
    assert.strictEqual(Bridge.combine({ trust: 4, familiarity: 1 }, partial).memory.trust, 4,
        'overlapping positive evidence is not double credited');
    legacy = { trust: 0, familiarity: 0, recentlyAbandonedAt: at };
    assert(assessBoth().every(r => r.reason === 'recently_abandoned'), 'legacy party-specific facts remain actionable');
    const hostileClan = Bridge.combine({ trust: 20 }, { ready: true, personal: null,
        effective: { trust: -8, hostility: 20, familiarity: 1 } });
    assert.strictEqual(hostileClan.reason, 'relationship_hostile', 'shared clan reputation reaches player party admission too');
    assert.strictEqual(legacy.trust, 0, 'combining views never rewrites legacy records');
    // Exercise the actual remote-invite entry point with an initially unloaded
    // owner. A stale neutral preview must not activate a remembered killer's bot.
    const World = invoke('GameServer/World/World');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Manager = invoke('GameServer/Bot/BotManager');
    const saved = { find: Life.findByName, hot: Manager.findSessionByName,
        load: Runtime.repository.loadMany, event: Legacy.recordEvent };
    Runtime.views.delete(botId); Runtime.snapshots.delete(botId);
    let loaded = 0;
    try {
        legacy = { trust: 20, familiarity: 30 };
        Life.findByName = async () => ({ ...cold, name: 'ColdPartner' });
        Manager.findSessionByName = () => null;
        Runtime.repository.loadMany = async ids => {
            assert.deepStrictEqual(ids, [botId]); loaded++;
            // Preserve a fresh offense relative to the live request clock.
            const now = Date.now();
            return [{ ...angrySnapshot, relations: angrySnapshot.relations.map(r => ({ ...r, at: now,
                reasons: r.reasons.map(e => ({ ...e, at: now })) })), recent: [] }];
        };
        Legacy.recordEvent = async () => null;
        player.dataSendToMe = () => {};
        assert.strictEqual(await World.inviteBotByName(player, player.actor, 'ColdPartner', 1), false,
            'loaded hostile history must refuse before remote activation');
        assert.strictEqual(loaded, 1);
    } finally {
        Life.findByName = saved.find; Manager.findSessionByName = saved.hot;
        Runtime.repository.loadMany = saved.load; Legacy.recordEvent = saved.event;
    }
    console.log('Player party relationship: hot/cold parity, revenge, reconciliation, clan context, pending memory and no duplicate credit passed');
} finally {
    Legacy.getSnapshot = original.get; Legacy.peekSnapshot = original.peek; Runtime.clanSocial = original.clans;
    Runtime.views.delete(botId); Runtime.snapshots.delete(botId);
} })().catch(error => { console.error(error); process.exitCode = 1; });
