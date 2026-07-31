const Database = invoke('Database');

const TABLE = 'bot_personas';
const VERSION = 1;
const TRAITS = Object.freeze(['sociability', 'commitment', 'caution', 'ambition', 'assertiveness', 'empathy', 'resilience']);
const PRIMARY_DRIVES = Object.freeze(['progression', 'wealth', 'social']);

// Archetypes provide coherent starting clusters. Small deterministic variance
// keeps a population from looking like copied templates.
const ARCHETYPES = Object.freeze({
    progression: [
        { id: 'steady_achiever', traits: { sociability: 0.48, commitment: 0.65, caution: 0.60, ambition: 0.78, assertiveness: 0.53, empathy: 0.55, resilience: 0.68 } },
        { id: 'competitive_climber', traits: { sociability: 0.60, commitment: 0.40, caution: 0.38, ambition: 0.88, assertiveness: 0.80, empathy: 0.35, resilience: 0.68 } }
    ],
    wealth: [
        { id: 'pragmatic_earner', traits: { sociability: 0.36, commitment: 0.45, caution: 0.62, ambition: 0.78, assertiveness: 0.48, empathy: 0.38, resilience: 0.72 } },
        { id: 'patient_crafter', traits: { sociability: 0.42, commitment: 0.62, caution: 0.72, ambition: 0.60, assertiveness: 0.33, empathy: 0.64, resilience: 0.75 } }
    ],
    social: [
        { id: 'steadfast_helper', traits: { sociability: 0.72, commitment: 0.86, caution: 0.64, ambition: 0.56, assertiveness: 0.46, empathy: 0.90, resilience: 0.75 } },
        { id: 'party_regular', traits: { sociability: 0.82, commitment: 0.66, caution: 0.48, ambition: 0.58, assertiveness: 0.55, empathy: 0.66, resilience: 0.62 } }
    ]
});

const cache = new Map();
let initialized = false;
let initPromise = null;

function now() { return Date.now(); }

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function seedFor(subject = {}) {
    const generated = subject?.stats?.generatedIndex;
    if (generated !== undefined && generated !== null && generated !== '') return String(generated);
    return String(subject.characterId || subject.id || '0');
}

function hash(seed, salt = '') {
    let value = 2166136261;
    const source = `${seed}:${salt}`;
    for (let index = 0; index < source.length; index++) {
        value ^= source.charCodeAt(index);
        value = Math.imul(value, 16777619);
    }
    value += value << 13;
    value ^= value >>> 7;
    value += value << 3;
    value ^= value >>> 17;
    value += value << 5;
    return value >>> 0;
}

function random(seed, salt) { return hash(seed, salt) / 4294967296; }
function pick(seed, salt, values) { return values[Math.min(values.length - 1, Math.floor(random(seed, salt) * values.length))]; }

function driveLabel(drive) {
    return ({
        progression: 'character progression',
        wealth: 'building wealth through practical opportunities',
        social: 'lasting party bonds and reliable cooperation'
    })[drive] || 'a steady life in Aden';
}

function traitLabel(value, low, high) {
    return value >= 0.62 ? high : value <= 0.38 ? low : '';
}

function buildTextCard(persona) {
    const traits = persona.traits;
    const style = [
        traitLabel(traits.sociability, 'reserved in conversation', 'comfortable starting a conversation'),
        traitLabel(traits.assertiveness - traits.empathy + 0.5, 'careful not to impose', 'direct when making a point'),
        traitLabel(traits.resilience, 'easily shaken by setbacks', 'calm after setbacks')
    ].filter(Boolean).join(', ');
    const group = traits.commitment >= 0.62
        ? 'prefers to keep faith with familiar companions'
        : traits.sociability <= 0.38 ? 'is comfortable working alone' : 'will choose a group when it clearly helps';
    const risk = traits.caution >= 0.62
        ? 'avoids needless danger'
        : traits.caution <= 0.38 ? 'will take a calculated chance' : 'weighs danger against the reward';
    return `${persona.archetype.replace(/_/g, ' ')} focused on ${driveLabel(persona.primaryDrive)}. ${group}; ${risk}. ${style || 'Speaks plainly and stays in character.'}.`;
}

function normalize(row) {
    const characterId = Number(row?.characterId || 0);
    const primaryDrive = PRIMARY_DRIVES.includes(row?.primaryDrive) ? row.primaryDrive : null;
    const archetype = text(row?.archetype);
    const traits = parseJson(row?.traitsJson, {});
    if (!characterId || !primaryDrive || !archetype || !TRAITS.every((trait) => Number.isFinite(Number(traits[trait])))) return null;
    const normalizedTraits = Object.fromEntries(TRAITS.map((trait) => [trait, clamp(traits[trait])]));
    const persona = {
        characterId,
        version: Math.max(1, Number(row.version) || VERSION),
        seed: text(row.seed),
        primaryDrive,
        archetype,
        traits: normalizedTraits,
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0)
    };
    return { ...persona, textCard: text(row.textCard) || buildTextCard(persona) };
}

function generated(subject = {}) {
    const characterId = Number(subject.characterId || subject.id || 0);
    if (!characterId) return null;
    const seed = seedFor(subject);
    const primaryDrive = pick(seed, 'drive', PRIMARY_DRIVES);
    const archetype = pick(seed, 'archetype', ARCHETYPES[primaryDrive]);
    const traits = Object.fromEntries(TRAITS.map((trait) => {
        const variance = (random(seed, `trait:${trait}`) - 0.5) * 0.22;
        return [trait, Math.round(clamp(archetype.traits[trait] + variance) * 100) / 100];
    }));
    const persona = { characterId, version: VERSION, seed, primaryDrive, archetype: archetype.id, traits };
    return { ...persona, textCard: buildTextCard(persona) };
}

function save(persona) {
    return Database.execute([
        `INSERT INTO ${TABLE} (
            characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(characterId) DO NOTHING`,
        [persona.characterId, persona.version, persona.seed, persona.primaryDrive, persona.archetype,
            JSON.stringify(persona.traits), persona.textCard, persona.createdAt, persona.updatedAt]
    ]);
}

const BotPersona = {
    VERSION,
    TRAITS,
    PRIMARY_DRIVES,
    ARCHETYPES,

    init() {
        if (initialized) return Promise.resolve(true);
        if (initPromise) return initPromise;
        initPromise = Database.execute(['SELECT 1', []], 'schema:bot-personas').then(() => {
            initialized = true;
            return true;
        }).catch((err) => {
            utils.infoWarn('BotPersona', 'persona table unavailable: %s', err.message);
            initPromise = null;
            return false;
        });
        return initPromise;
    },

    generate: generated,

    snapshot(characterId) { return cache.get(Number(characterId || 0)) || null; },

    load(characterId) {
        const id = Number(characterId || 0);
        if (!id) return Promise.resolve(null);
        const cached = cache.get(id);
        if (cached) return Promise.resolve(cached);
        return this.init().then((ready) => {
            if (!ready) return null;
            return Database.execute([
                `SELECT characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt
                FROM ${TABLE} WHERE characterId = ? LIMIT 1`, [id]
            ]).then((rows) => {
                const persona = normalize(rows?.[0]);
                if (persona) cache.set(id, persona);
                return persona;
            });
        }).catch((err) => {
            utils.infoWarn('BotPersona', 'failed to load persona for %d: %s', id, err.message);
            return null;
        });
    },

    ensure(subject) {
        const candidate = generated(subject);
        if (!candidate) return Promise.resolve(null);
        const cached = cache.get(candidate.characterId);
        if (cached) return Promise.resolve(cached);
        return this.load(candidate.characterId).then((existing) => {
            if (existing) return existing;
            const timestamp = now();
            const persisted = { ...candidate, createdAt: timestamp, updatedAt: timestamp };
            return save(persisted).then(() => {
                cache.set(persisted.characterId, persisted);
                return persisted;
            });
        }).catch((err) => {
            utils.infoWarn('BotPersona', 'failed to persist persona for %d: %s', candidate.characterId, err.message);
            return null;
        });
    },

    // Generated cold bots are the only population currently eligible here.
    // Static merchant/craft services have different account prefixes and do
    // not receive a simulated player persona.
    backfillGenerated(limit = 100) {
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
        return this.init().then((ready) => {
            if (!ready) return { created: 0, exhausted: false };
            return Database.execute([
                `SELECT states.characterId, states.statsJson
                FROM bot_life_state states
                LEFT JOIN ${TABLE} personas ON personas.characterId = states.characterId
                WHERE personas.characterId IS NULL
                AND states.accountName LIKE 'bot_pop_%'
                AND json_extract(COALESCE(states.statsJson, '{}'), '$.generatedCold') = 1
                LIMIT ${safeLimit}`,
                []
            ]).then((rows) => {
                const candidates = rows || [];
                return candidates.reduce((chain, row) => chain.then((result) => (
                    this.ensure({ characterId: row.characterId, stats: parseJson(row.statsJson, {}) })
                        .then((persona) => ({
                            created: result.created + (persona ? 1 : 0),
                            failed: result.failed + (persona ? 0 : 1)
                        }))
                )), Promise.resolve({ created: 0, failed: 0 })).then((result) => ({
                    created: result.created,
                    // Do not confuse a failed save with the end of the
                    // migration; transient database errors need another pass.
                    exhausted: candidates.length < safeLimit && result.failed === 0
                }));
            });
        }).catch((err) => {
            utils.infoWarn('BotPersona', 'generated persona backfill failed: %s', err.message);
            return { created: 0, exhausted: false };
        });
    },

    reset() {
        cache.clear();
        initialized = false;
        initPromise = null;
    }
};

module.exports = BotPersona;
