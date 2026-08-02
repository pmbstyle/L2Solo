const assert = require('assert');

require('../src/Global');

const BotAmbientDirector = invoke('GameServer/Bot/AI/BotAmbientDirector');
const BotConversation = invoke('GameServer/Bot/AI/BotConversation');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');

function actor(id, name, overrides = {}) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchIsOnline: () => true,
        fetchHp: () => overrides.hp ?? 100,
        fetchMaxHp: () => 100,
        fetchMp: () => overrides.mp ?? 100,
        fetchMaxMp: () => 100,
        fetchLocX: () => overrides.x ?? -84318,
        fetchLocY: () => overrides.y ?? 244579,
        fetchLocZ: () => -3730,
        state: {
            fetchDead: () => !!overrides.dead
        }
    };
}

function bot(id, name, overrides = {}) {
    return {
        accountId: `bot_${id}`,
        actor: actor(id, name, overrides),
        plan: 'resting',
        persona: overrides.persona || {
            primaryDrive: 'social',
            traits: { sociability: 0.9, restlessness: 0.2 }
        },
        botStatus: { home: { region: 'Talking Island' }, role: overrides.role || 'fighter' },
        ...overrides
    };
}

const now = 1_000_000;
const aria = bot(2000101, 'Aria', { role: 'tank' });
const belen = bot(2000102, 'Belen', { role: 'healer' });
const clara = bot(2000109, 'Clara', { role: 'dps' });

BotAmbientDirector.reset();
assert.strictEqual(BotAmbientDirector.enabled(), true, 'ambient director should be enabled by default');
assert.strictEqual(BotAmbientDirector.deriveMood(aria).mood, 'sociable', 'social persona should become sociable mood');

const started = BotAmbientDirector.start(aria, belen, now);
assert.strictEqual(started.ok, true, 'two resting hot bots should start one bounded ambient scene');
assert.ok(['rest', 'party'].includes(started.conversation.topic), 'ambient scene should use a native bounded conversation topic');
assert.strictEqual(aria.inConversation, true);
assert.strictEqual(BotAmbientDirector.snapshot(aria).scene.id, started.scene.id);
assert.strictEqual(BotAmbientDirector.eligible(aria, belen, now + 1).reason, 'scene_active');

assert.strictEqual(BotAmbientDirector.finish(started.scene, 'test_complete'), true);
assert.strictEqual(aria.inConversation, false);
assert.strictEqual(belen.inConversation, false);
assert.strictEqual(
    BotAmbientDirector.eligible(aria, belen, now + 1000).reason,
    'pair_cooldown',
    'a finished scene must protect both bots from immediate ambient spam'
);
assert.strictEqual(
    BotAmbientDirector.eligible(aria, belen, now + 180000).ok,
    true,
    'the per-bot cooldown should eventually expire'
);
assert.strictEqual(
    BotAmbientDirector.eligible(aria, clara, now + 100000).reason,
    'bot_cooldown',
    'a bot cooldown must apply even when the next scene uses a different pair'
);

const player = bot(2000103, 'VisiblePlayer', { accountId: 'player_1' });
assert.strictEqual(BotAmbientDirector.eligible(aria, player, now + 180000).reason, 'bot_only_scene');

const companion = bot(2000104, 'Companion', { partyCompanion: true });
assert.strictEqual(BotAmbientDirector.eligible(aria, companion, now + 180000).reason, 'player_companion');

const lowVitals = bot(2000105, 'Tired', { persona: { primaryDrive: 'progression', traits: {} }, hp: 20 });
assert.strictEqual(BotAmbientDirector.deriveMood(lowVitals).mood, 'tired', 'low HP should dominate personality mood');

const commerce = bot(2000106, 'Merchant', { plan: 'merchant', activeTrade: { id: 'trade-1' } });
assert.strictEqual(BotAmbientDirector.deriveMood(commerce).mood, 'focused', 'commerce should keep mood focused');

const staleAmbient = bot(2000110, 'FreshMood');
staleAmbient.ambientState = { mood: 'tired', intent: 'recover', reason: 'old_snapshot', updatedAt: now };
const refreshedAmbient = BotAmbientDirector.snapshot(staleAmbient, now + BotAmbientDirector.DEFAULT_STATE_TTL_MS + 1);
assert.strictEqual(refreshedAmbient.mood, 'sociable', 'ambient mood must refresh after its TTL');
assert.strictEqual(refreshedAmbient.reason, 'social_persona');

const staleA = bot(2000107, 'StaleA');
const staleB = bot(2000108, 'StaleB');
const stale = BotAmbientDirector.start(staleA, staleB, now + 400000);
assert.strictEqual(stale.ok, true);
assert.strictEqual(
    BotAmbientDirector.eligible(staleA, staleB, stale.scene.expiresAt + 1).reason,
    'pair_cooldown',
    'expired scenes must be finished and then remain cooldown-protected'
);
assert.strictEqual(staleA.inConversation, false, 'TTL expiry must release the native conversation lock');

const compact = BotBrainContext.compactStatus({ actor: null }, {
    available: true,
    name: 'ContextBot',
    level: 20,
    classId: 31,
    mode: 'resting',
    intent: 'recover',
    role: 'dps',
    vitals: { hpPct: 0.8, mpPct: 0.8 },
    target: null,
    party: null,
    nearby: {},
    blockers: [],
    spot: null,
    ambient: { mood: 'sociable', intent: 'seek_company', scene: null },
    trade: null,
    persona: null,
    social: null
});
assert.strictEqual(compact.ambient.mood, 'sociable', 'compact LLM context must expose the bounded mood snapshot');

BotConversation.finish({ lines: [] });
BotAmbientDirector.reset();
console.log('Bot ambient director checks passed');
