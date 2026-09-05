const Persona = invoke('GameServer/Bot/AI/BotPersona');
const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');

const CACHE_LIMIT = 2048;
const generated = new Map();
const recent = new Map();

function profile(source = {}) {
    if (source.persona?.traits) return source.persona;
    const characterId = Number(source.actor?.fetchId?.() || source.characterId || 0);
    const saved = Persona.snapshot(characterId);
    if (saved) return saved;
    if (!characterId) return null;
    const stats = source.coldLifeState?.stats || source.stats || {};
    const key = `${characterId}:${stats.generatedIndex ?? ''}`;
    if (!generated.has(key)) {
        if (generated.size >= CACHE_LIMIT) generated.delete(generated.keys().next().value);
        generated.set(key, Persona.generate({ characterId, stats }));
    }
    return generated.get(key);
}

function trait(source, key) {
    const value = profile(source)?.traits?.[key];
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function styleWeight(source, style) {
    const t = key => trait(source, key);
    const drive = profile(source)?.primaryDrive;
    const score = {
        social: () => t('sociability'), reserved: () => 1 - t('sociability'),
        warm: () => t('empathy'), direct: () => t('assertiveness') * (1 - 0.4 * t('empathy')),
        careful: () => t('caution'), daring: () => 1 - t('caution'),
        driven: () => t('ambition'), calm: () => t('resilience'),
        weary: () => 1 - t('resilience'), loyal: () => t('commitment'),
        thrifty: () => drive === 'wealth' ? 1 : 0.35
    }[style]?.() ?? 0.5;
    return 0.08 + 6 * score ** 3;
}

function topicWeight(source, topic) {
    const t = key => trait(source, key);
    const drive = profile(source)?.primaryDrive;
    switch (topic) {
        case 'company': case 'party': return 0.5 + 2 * t('sociability') + t('commitment') + (drive === 'social' ? 3 : 0);
        case 'patience': case 'gear': case 'trade': return 0.5 + t('ambition') + (drive === 'wealth' ? 3 : drive === 'progression' ? 2 : 0);
        case 'hunting': return 0.5 + t('ambition') + (drive === 'progression' ? 3 : 0);
        case 'rest': case 'break': case 'recovery': return 0.5 + t('caution') + (1 - t('resilience'));
        case 'roads': return 0.5 + t('resilience') + (drive === 'wealth' ? 1 : 0);
        default: return 1;
    }
}

function pick(values, weight) {
    let roll = Math.random() * values.reduce((sum, value) => sum + weight(value), 0);
    return values.find(value => (roll -= weight(value)) < 0) || values[values.length - 1];
}

function line(key, source, values = {}, excluded = []) {
    const templates = Speech.voices[key] || [];
    const rendered = templates.map(([style, template]) => {
        let complete = true;
        const text = template.replace(/\{(\w+)\}/g, (_match, name) => {
            if (values[name] === undefined || values[name] === null || values[name] === '') complete = false;
            return String(values[name] ?? '').replace(/\s+/g, ' ').trim();
        });
        return { style, template, text: complete ? text.slice(0, 120) : '' };
    }).filter(entry => entry.text && !excluded.includes(entry.text));
    const previous = recent.get(key) || [];
    const fresh = rendered.filter(entry => !previous.includes(entry.template));
    const chosen = pick(fresh.length ? fresh : rendered, entry => styleWeight(source, entry.style));
    if (!chosen) return '';
    // Catalogue keys and four lines per key bound this history independently
    // of population size. Names are ignored when detecting repeated replies.
    recent.set(key, [chosen.template, ...previous].slice(0, Math.min(4, templates.length - 1)));
    return chosen.text;
}

function initiation(source) { return 0.35 + 1.3 * trait(source, 'sociability') + 0.35 * trait(source, 'assertiveness'); }
function closeChance(source) { return 0.2 + 0.55 * trait(source, 'sociability') + 0.15 * trait(source, 'assertiveness'); }

function willingToReply(source, scene) {
    const characterId = Number(source.actor?.fetchId?.() || source.characterId || 0);
    // Stable for this speaker and scene: more hot ticks do not buy more rolls.
    const seed = `${characterId}:${scene.openerId}:${scene.startedAt}:${scene.channel}:${scene.topic}`;
    let hash = 2166136261;
    for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
    hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d); hash ^= hash >>> 15;
    const supportive = ['death', 'revived', 'rest'].includes(scene.topic);
    const chance = 0.12 + 0.48 * trait(source, 'sociability') +
        0.25 * trait(source, supportive ? 'empathy' : 'assertiveness');
    return (hash >>> 0) / 4294967296 < chance;
}

module.exports = {
    profile, trait, styleWeight, topicWeight, pick, line, initiation, closeChance, willingToReply,
    CACHE_LIMIT, snapshot() { return { profiles: generated.size, histories: recent.size }; },
    reset() { generated.clear(); recent.clear(); }
};
