const Database = invoke('Database');

const Types = require('./BotPersonaTypes');
const TableChannel = require('../Population/ColdTableChannel');

const TABLE = 'bot_personas';
// 2: eleven types chosen by class and share, +-0.2 triangular spread,
// inclinations (step 3.1, N6a; migration 52 rewrote the v1 rows).
const VERSION = 2;
const TRAITS = Types.TRAITS;
const INCLINATIONS = Types.INCLINATIONS;
const PRIMARY_DRIVES = Object.freeze(['progression', 'wealth', 'social']);
const COLUMNS = 'characterId, version, seed, primaryDrive, archetype, traitsJson, inclinationsJson, textCard, createdAt, updatedAt';

// The one persona source (BotPersona.of): every stored row, loaded at boot on
// the main thread (loadAll); in the cold worker filled from the 'personas'
// table of ColdTableChannel (useRowSource).
const cache = new Map();
// Stored personas per type, for the share of a new bot's type.
let typeCounts = {};
let rowSource = null;
const pending = new Map();
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
    return String(idOf(subject) || '0');
}

function idOf(subject) {
    if (typeof subject === 'number' || typeof subject === 'string') return Number(subject) || 0;
    return Number(subject?.characterId || subject?.actor?.fetchId?.() || subject?.id || 0);
}

function classIdOf(subject = {}) {
    const classId = subject.classId ?? subject.stats?.classId ?? subject.actor?.fetchClassId?.();
    return classId === undefined || classId === null ? null : Number(classId);
}

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

function dialogueVoice(persona) {
    const voices = {
        steady_achiever: 'Understated and practical; enjoys figuring out builds and making progress. Can grumble about a grind without turning every chat into advice.',
        competitive_climber: 'Competitive and proud; enjoys challenges, playful trash talk, and arguing about builds. Can be salty after a real setback and respect a good rival. Do not fabricate PvP wins or enemies.',
        pragmatic_earner: 'Shrewd and dryly funny about prices and wasted effort. Warmth can be practical, but you can enjoy a conversation without pitching a sale. A hard bargain is not a completed deal.',
        patient_crafter: 'Patient, quietly opinionated, and proud of the craft. Appreciates regulars and a fair deal; can get annoyed by lowball offers without becoming a shop assistant.',
        steadfast_helper: 'Warm and loyal to familiar people, with personal opinions and limits. Can tease friends or say no; does not automatically offer help with everything.',
        party_regular: 'Sociable and informal; likes shared jokes, group gossip grounded in actual events, and hearing what others think. Leave room for short replies instead of interviewing the player.',
        brawler: 'Hot-headed and proud of a good scrap; likes talking about fights, contested spots, and who backed down. Can provoke or boast, and respects someone who stands their ground. Do not fabricate PvP wins or enemies.',
        lone_wolf: 'Self-reliant and terse; prefers hunting alone and talking about routes, pulls, and gear that keeps a solo run going. Can warm up slowly, but does not pretend to want a party.',
        speculator: 'Sharp-eyed about prices and timing; enjoys talk of what is cheap now and dear later, and is a little smug about a good buy. A price guess is not a promise, and a hard bargain is not a completed deal.',
        clan_loyalist: 'Proud of the clan and loyal to clanmates; talks about the clan standing, rivals, and shared fights. Can hold a grudge on the clan behalf, but does not invent wars or enemies.',
        justice_keeper: 'Principled and protective; dislikes players who prey on the weak and respects a fair fight. Can be stern about player killers without lecturing every conversation or inventing crimes.'
    };
    const traits = persona.traits;
    return [
        voices[persona.archetype] || 'Speak plainly with your own opinions and let your motivations show naturally.',
        traits.sociability <= 0.38 ? 'Usually terse; silence between messages is fine.' : traits.sociability >= 0.62 ? 'Comfortable with banter, but do not force a question into every reply.' : '',
        traits.empathy <= 0.38 ? 'More blunt than reassuring; disagree without needless cruelty.' : traits.empathy >= 0.62 ? 'Notice how the other player feels without sounding like a counselor.' : ''
    ].filter(Boolean).join(' ');
}

// Values derived from the stored traits when a persona is cached, never
// stored: the text card when the row has none, the dialogue voice, the
// combat talents (combat-skills brief B) and the market understanding (N45).
function withDerived(persona) {
    return {
        ...persona,
        talents: Types.talents(persona.traits),
        understanding: Types.understanding(persona.primaryDrive, persona.traits, persona.inclinations, persona.characterId),
        textCard: persona.textCard || buildTextCard(persona),
        dialogueVoice: dialogueVoice(persona)
    };
}

function numbers(values, names, fallback = {}) {
    return Object.fromEntries(names.map((name) => [name, clamp(values?.[name] ?? fallback[name])]));
}

function normalize(row) {
    const characterId = Number(row?.characterId || 0);
    const primaryDrive = PRIMARY_DRIVES.includes(row?.primaryDrive) ? row.primaryDrive : null;
    const archetype = text(row?.archetype);
    const traits = parseJson(row?.traitsJson, {});
    if (!characterId || !primaryDrive || !archetype || !TRAITS.every((trait) => Number.isFinite(Number(traits[trait])))) return null;
    return withDerived({
        characterId,
        version: Math.max(1, Number(row.version) || VERSION),
        seed: text(row.seed),
        primaryDrive,
        archetype,
        traits: numbers(traits, TRAITS),
        inclinations: numbers(parseJson(row.inclinationsJson, {}), INCLINATIONS, Types.TYPES[archetype]?.inclinations),
        textCard: text(row.textCard),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0)
    });
}

// The row the cold worker receives: [characterId, seed, drive, type, 7 traits, 3 inclinations].
function tableRow(persona) {
    return [persona.characterId, persona.seed, persona.primaryDrive, persona.archetype,
        ...TRAITS.map((trait) => persona.traits[trait]), ...INCLINATIONS.map((name) => persona.inclinations[name])];
}

function fromTableRow(row) {
    const [characterId, seed, primaryDrive, archetype] = row;
    return withDerived({
        characterId,
        version: VERSION,
        seed,
        primaryDrive,
        archetype,
        traits: Object.fromEntries(TRAITS.map((trait, index) => [trait, row[4 + index]])),
        inclinations: Object.fromEntries(INCLINATIONS.map((name, index) => [name, row[4 + TRAITS.length + index]])),
        textCard: ''
    });
}

// A persona for a new bot: its type by its class and the deficit of each type
// against its share (counts: stored personas per type; total: the population
// the shares are of), then traits and inclinations rolled by its seed.
function generated(subject = {}, { counts = {}, total = 1 } = {}) {
    const characterId = idOf(subject);
    if (!characterId) return null;
    const seed = seedFor(subject);
    const archetype = Types.chooseType(classIdOf(subject), seed, counts, total);
    return withDerived({
        characterId,
        version: VERSION,
        seed,
        primaryDrive: Types.TYPES[archetype].drive,
        archetype,
        traits: Types.rollTraits(archetype, seed),
        inclinations: Types.rollInclinations(archetype, seed),
        textCard: ''
    });
}

function remember(persona) {
    const known = cache.has(persona.characterId);
    cache.set(persona.characterId, persona);
    if (known) return;
    typeCounts[persona.archetype] = (typeCounts[persona.archetype] || 0) + 1;
    TableChannel.shared.changed('personas', tableRow(persona));
}

// Shares are of the configured population, or of the stored one once larger.
function populationTotal() {
    const configured = Number(invoke('GameServer/Bot/Population/PopulationConfig').maxPlayingPopulation) || 0;
    return Math.max(cache.size + 1, configured);
}

function save(persona) {
    return Database.execute([
        `INSERT INTO ${TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(characterId) DO NOTHING`,
        [persona.characterId, persona.version, persona.seed, persona.primaryDrive, persona.archetype,
            JSON.stringify(persona.traits), JSON.stringify(persona.inclinations), persona.textCard,
            persona.createdAt, persona.updatedAt]
    ]);
}

const BotPersona = {
    VERSION,
    TRAITS,
    INCLINATIONS,
    PRIMARY_DRIVES,
    TYPES: Types.TYPES,

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

    // Main thread, once at boot: every stored persona into the cache, the
    // counts per type, and the 'personas' table for the background workers.
    loadAll() {
        return Database.execute([`SELECT ${COLUMNS} FROM ${TABLE}`, []], 'bot-personas:load-all').then((rows) => {
            cache.clear();
            typeCounts = {};
            for (const row of rows || []) {
                const persona = normalize(row);
                if (persona) remember(persona);
            }
            TableChannel.shared.register('personas', {
                key: (row) => row[0],
                allRows: () => [...cache.values()].map(tableRow)
            });
            initialized = true;
            return cache.size;
        });
    },

    // Cold worker: where a persona missing from the cache comes from.
    useRowSource(source) {
        rowSource = source;
    },

    // The bot's stored persona: subject.persona, else the cache by character
    // id, else the row the worker received; null when the bot has none.
    // Never generated: a persona is chosen once, when the bot is created.
    of(subject) {
        if (subject?.persona && typeof subject.persona === 'object') return subject.persona;
        const id = idOf(subject);
        if (!id) return null;
        const cached = cache.get(id);
        if (cached) return cached;
        const row = rowSource?.(id);
        if (!row) return null;
        const persona = fromTableRow(row);
        cache.set(id, persona);
        return persona;
    },

    // A persona for a subject without a stored row (tests and tools; a new
    // bot's row is made by ensure). options: { counts, total }.
    generate: generated,
    tableRow,
    fromTableRow,
    textCardFor: buildTextCard,

    typeCounts() { return { ...typeCounts }; },

    snapshot(characterId) { return cache.get(Number(characterId || 0)) || null; },

    load(characterId) {
        const id = Number(characterId || 0);
        if (!id) return Promise.resolve(null);
        const cached = cache.get(id);
        if (cached) return Promise.resolve(cached);
        return this.init().then((ready) => {
            if (!ready) return null;
            return Database.execute([`SELECT ${COLUMNS} FROM ${TABLE} WHERE characterId = ? LIMIT 1`, [id]]).then((rows) => {
                const persona = normalize(rows?.[0]);
                if (persona) remember(persona);
                return persona;
            });
        }).catch((err) => {
            utils.infoWarn('BotPersona', 'failed to load persona for %d: %s', id, err.message);
            return null;
        });
    },

    // The stored persona, or a new bot's persona made and stored once.
    ensure(subject) {
        const id = idOf(subject);
        if (!id) return Promise.resolve(null);
        const cached = cache.get(id);
        if (cached) return Promise.resolve(cached);
        if (pending.has(id)) return pending.get(id);
        const work = this.load(id).then((existing) => {
            if (existing) return existing;
            const timestamp = now();
            const persona = { ...generated(subject, { counts: typeCounts, total: populationTotal() }), createdAt: timestamp, updatedAt: timestamp };
            return save(persona).then(() => {
                remember(persona);
                return persona;
            });
        }).catch((err) => {
            utils.infoWarn('BotPersona', 'failed to persist persona for %d: %s', id, err.message);
            return null;
        }).finally(() => pending.delete(id));
        pending.set(id, work);
        return work;
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
        pending.clear();
        typeCounts = {};
        rowSource = null;
        initialized = false;
        initPromise = null;
    }
};

module.exports = BotPersona;
