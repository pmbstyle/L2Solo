const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
require('../src/Global');
// Load native data before the first economic route or combat profile check.
invoke('GameServer/DataCache').init();
// U26 (user, 2026-10-05): can-I-win is a chance with one roll per decision. A fixed
// middle roll (0.49) makes each such decision the author's threshold (willing iff
// chance >= 0.5, i.e. ratio >= threshold); the chance itself is tested in test_visible_strength.
require('../src/GameServer/Bot/AI/TendencyRoll').roll = () => 0.49;
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Aggression = require('../src/GameServer/Social/PvpAggression');
const Resource = require('../src/GameServer/Social/ResourceCompetitionPolicy');
const Cold = require('../src/GameServer/Bot/Population/ColdCompetitionPolicy');
const Revenge = require('../src/GameServer/Social/RevengePolicy');
const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Claims = invoke('GameServer/Bot/AI/BotMobCompetition');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const MemoryPolicy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const neutral = { ready: true, personal: null };
const hostile = { ready: true, affiliation: 'stranger',
    personal: { hostility: 30, trust: -10, affinity: -10, fear: 0 } };
const persona = { traits: { assertiveness: 0.6, caution: 0.5, empathy: 0.3, resilience: 0.5 } };
const previous = Config.pvpAggression;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-aggression-'));
try {
    // Exercise the real INI loader in fresh processes, independent of local.ini.
    for (const [raw, expected, override] of [[undefined, 0.5], ['', 0.5], ['0', 0], ['0.25', 0.25], ['0.5', 0.5], ['0.75', 0.75], ['1', 1], ['-2', 0], ['99', 1], ['oops', 0.5], ['1', 0, '0'], ['0', 0.75, '0.75']]) {
        const file = path.join(temp, 'settings.ini');
        fs.writeFileSync(file, `[BotPopulation]\n${raw === undefined ? '' : `pvpAggression = ${raw}\n`}`);
        const env = { ...process.env, L2NODE_CONFIG_FILE: file };
        delete env.L2NODE_SHARED_CONFIG_FILE; delete env.BOT_PVP_AGGRESSION;
        if (override !== undefined) env.BOT_PVP_AGGRESSION = override;
        const run = spawnSync(process.execPath, ['-e', "require('./src/Global'); process.stdout.write(String(require('./src/GameServer/Bot/Population/PopulationConfig').pvpAggression))"],
            { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' });
        assert.strictEqual(run.status, 0, run.stderr);
        assert.strictEqual(Number(run.stdout), expected, `INI value ${raw}`);
    }
    Config.pvpAggression = 0.5;
    const base = Resource.escalationChance(persona, neutral);
    const revenge = Revenge.evaluate(hostile, persona).chance;
    assert(Math.abs(base - 0.499) < 1e-12, 'midpoint preserves the pre-setting resource balance');
    assert(revenge > 0);
    assert.strictEqual(Aggression.retreatMultiplier(0.5), 1, 'midpoint preserves retreat thresholds');
    assert.strictEqual(Risk.evaluate({ botLevel: 40, threatLevel: 40, hpRatio: 1, mpRatio: 1 }).score, 0);
    const decisions = [];
    const expectedEscalation = [0, base / 2, base, (base + 1) / 2, 1];
    const expectedRevenge = [0, revenge / 2, revenge, (revenge + 1) / 2, 1];
    for (const [index, level] of [0, 0.25, 0.5, 0.75, 1].entries()) {
        Config.pvpAggression = level;
        assert(Math.abs(Resource.escalationChance(persona, neutral) - expectedEscalation[index]) < 1e-12);
        assert(Math.abs(Revenge.evaluate(hostile, persona).chance - expectedRevenge[index]) < 1e-12);
        assert.strictEqual(Revenge.evaluate({ ...hostile, affiliation: 'own' }, persona).chance, 0);
        assert.strictEqual(Resource.escalationChance(persona, { ready: false }), 0);
        const input = { pressure: 3, actor: { level: 40, size: 3, partyId: 'a' },
            peer: { level: 40, size: 3, partyId: 'b' }, actorPersona: persona, peerPersona: persona,
            towardPeer: neutral, towardActor: neutral };
        const roll = () => { const values = [0.99, 0, 0.3]; return () => values.shift(); };
        const hot = Resource.decide({ ...input, rng: roll() });
        assert.deepStrictEqual(Cold.decide({ ...input, rng: roll() }), hot);
        assert.strictEqual(hot.action, 'contest', 'peaceful aggression does not erase resource competition');
        decisions.push(hot.pvpIntent);
    }
    assert.deepStrictEqual(decisions, [false, false, true, true, true]);
    Config.pvpAggression = 0;
    // U26: a visibly stronger bot (higher weapon grade), not a hidden level gap.
    const context = { ownLook: { weapon: 2, glow: 0, body: 0 }, threatLook: { weapon: 0, glow: 0, body: 0 }, hpRatio: 1, mpRatio: 1, role: 'dps' };
    assert.strictEqual(Risk.evaluate(context).action, 'flee', 'zero aggression cannot initiate PK pursuit');
    assert.strictEqual(Risk.evaluate({ ...context, targetedByThreat: true }).action, 'fight', 'self-defense remains possible');
    const actor = id => ({ fetchId: () => id, fetchLevel: () => 40, fetchClassId: () => 0,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchClanId: () => 0,
        fetchIsOnline: () => true, isDead: () => false, state: { fetchDead: () => false },
        backpack: { fetchItems: () => [] } });
    const a = actor(8801), b = actor(8802);
    a.session = { actor: a, accountId: 'bot_aggression', persona };
    Memory.accept(MemoryPolicy.empty(8801));
    const scores = [];
    for (const level of [0.25, 0.5, 1]) {
        Config.pvpAggression = level;
        assert.strictEqual(Claims.attackChance(a.session, b), Resource.escalationChance(persona, neutral), 'live mob-claim escalation uses the setting');
        scores.push(Risk.defenseDecision(a.session, [b]));
    }
    assert.deepStrictEqual(scores.map(s => s.action), ['flee', 'fight', 'fight']);
    assert(scores[0].requiredRatio > scores[1].requiredRatio && scores[1].requiredRatio > scores[2].requiredRatio);
    assert(scores[0].criticalFleeChance > scores[1].criticalFleeChance && scores[1].criticalFleeChance > scores[2].criticalFleeChance);
    assert(Aggression.retreatHp(0.25, 0.25) > 0.25 && Aggression.retreatHp(0.25, 1) < 0.25);
    Config.pvpAggression = 1;
    assert.strictEqual(Claims.attackChance(a.session, b), 1, 'maximum reaches guaranteed live escalation');
    assert.strictEqual(Resource.decide({ pressure: 3, actor: { level: 40, size: 3, partyId: 'a' },
        peer: { level: 40, size: 3, partyId: 'b' }, actorPersona: persona, peerPersona: persona,
        towardPeer: neutral, towardActor: neutral,
        rng: (() => { const values = [0.99, 0, 0.999999]; return () => values.shift(); })()
    }).pvpIntent, true, 'maximum escalates an eligible dispute even on the highest random roll');
    for (const chance of [0.001, 0.2, 0.8, 1]) {
        assert.strictEqual(Aggression.scaleChance(chance, 1), 1);
        let last = 0;
        for (let step = 0; step <= 100; step++) {
            const next = Aggression.scaleChance(chance, step / 100);
            assert(next >= last && next <= 1, 'escalation rises monotonically over the full scale');
            last = next;
        }
    }
    assert.strictEqual(Aggression.scaleChance(0, 1), 0);
    assert.strictEqual(Resource.escalationChance({ traits: {} }, { ready: true,
        personal: { affinity: 20, trust: 20, hostility: 0, fear: 0 } }), 0, 'aggression cannot invent hostility toward friends');
    console.log('PvP aggression INI, hot/cold escalation, revenge, risk and retreat checks passed');
} finally {
    Config.pvpAggression = previous;
    fs.rmSync(temp, { recursive: true, force: true });
}
