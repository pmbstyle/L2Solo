const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Loadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const Effects = invoke('GameServer/Effects/EffectStore');
const HuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');

const EXCLUDED_CLASSES = new Set([21, 34, 49, 50, 51, 52]);
const REFRESH_MS = 2 * 60 * 1000;

function serviceClass(provider) {
    const classId = Roles.roleClassId(provider);
    return classId !== null && !EXCLUDED_CLASSES.has(classId)
        && ['buffer', 'healer'].includes(Roles.inferRole(provider));
}

function eligibleSkill(skill) {
    const semantic = skill?.fetchSemantic?.() || {};
    const effect = String(semantic.effect || '').toLowerCase();
    return semantic.effectType === 'buff'
        && (semantic.target || skill.fetchTargetKind?.()) === 'friendly'
        && effect && !effect.startsWith('song_of_') && !effect.startsWith('dance_of_')
        && !['kiss_of_eva', 'decrease_weight'].includes(effect);
}

function sameClan(provider, recipient) {
    const first = Number(provider?.fetchClanId?.() ?? provider?.stats?.clanId ?? 0);
    const second = Number(recipient?.fetchClanId?.() ?? recipient?.stats?.clanId ?? 0);
    return first > 0 && first === second;
}

// A hot actor's hour value comes from its life state (its cold samples); a
// player or an actor without one is valued at its level band.
function lifeStateOf(entity) {
    if (entity?.stats) return entity;
    const id = Number(entity?.fetchId?.() || 0);
    return (id && invoke('GameServer/Bot/Population/BotLifeState').cachedState(id))
        || { level: Math.max(1, Number(entity?.fetchLevel?.() ?? entity?.level ?? 1)) };
}

// What ten minutes of the bot's hunting earn: its hour value / 6.
function incomeForTenMinutes(entity) {
    return Math.round(HuntEfficiency.hourValue(lifeStateOf(entity)).perHour / 6);
}

function priceFor({ provider, recipient, skills, town, trust = 0 }) {
    if (sameClan(provider, recipient)) return 0;
    const mp = skills.reduce((sum, skill) => sum + Math.max(0, Number(skill.fetchConsumedMp?.() || 0)), 0);
    const opportunity = incomeForTenMinutes(provider);
    const mpCost = Math.ceil(opportunity * Math.min(1, mp / Math.max(1, Number(provider?.fetchMaxMp?.() || provider?.vitals?.maxMp || 500))) * 0.22);
    const townPrice = Math.ceil(opportunity * 1.25 / 2 + mpCost);
    const base = town ? townPrice : Math.max(mpCost + skills.length * 8, Math.ceil(townPrice * 0.55));
    const relation = trust >= 8 ? 0.9 : trust >= 3 ? 0.96 : trust <= -5 ? 1.1 : 1;
    return Math.max(1, Math.ceil(base * relation));
}

function needsPaidBuff(recipient, skill) {
    const skillId = Number(skill.fetchSelfId());
    const effectKey = Loadout.normalize(skill.fetchSemantic?.()?.effect);
    const level = Number(skill.fetchLevel?.() || 1);
    const current = Effects.list(recipient).filter(effect => effect.type !== 'debuff'
        && (Number(effect.id) === skillId || Loadout.normalize(effect.key) === effectKey
            || Loadout.normalize(effect.category) === effectKey));
    if (current.some(effect => Number(effect.level || 0) > level)) return false;
    const durationMs = Number(skill.fetchBuffTime?.() ?? skill.fetchSemantic?.()?.durationMs ?? 0);
    const refreshMs = Number.isFinite(durationMs) && durationMs > 0
        ? Math.min(REFRESH_MS, Math.floor(durationMs * 0.25)) : REFRESH_MS;
    return !current.some(effect => Number(effect.level || 0) === level
        && Effects.remainingMs(recipient, effect.key) > refreshMs);
}

function hotSkills(provider, recipient) {
    if (!serviceClass(provider) || !recipient) return [];
    const Planner = invoke('GameServer/Bot/AI/BotSupportPlanner');
    const known = Planner.supportSkills(provider)
        .filter(eligibleSkill)
        .filter((skill) => Loadout.useful(recipient, skill))
        .filter((skill) => needsPaidBuff(recipient, skill))
        .filter((skill) => Planner.canPlanSupportAction(recipient, provider, skill, [{ actor: recipient, leader: true }]));
    const byFamily = new Map();
    known.forEach((skill) => {
        const family = Loadout.family(skill.fetchSemantic().effect);
        const previous = byFamily.get(family);
        if (!previous || Number(skill.fetchLevel?.() || 0) > Number(previous.fetchLevel?.() || 0)) byFamily.set(family, skill);
    });
    return [...byFamily.values()].sort((a, b) => Number(a.fetchSelfId()) - Number(b.fetchSelfId()));
}

module.exports = { EXCLUDED_CLASSES, REFRESH_MS, serviceClass, eligibleSkill, sameClan,
    incomeForTenMinutes, priceFor, needsPaidBuff, hotSkills };
