'use strict';
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Loadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const Policy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const BUYER_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_RECIPIENTS = 16, MAX_OFFER_BYTES = 512;

function available(state) {
    return state?.phase === 'cold' && ['hunting', 'resting'].includes(state.activity)
        && !!state.spotId && !state.party?.partyId && !state.partyId
        && !state.stats?.backgroundPartyId && !state.stats?.pveEncounter && !state.stats?.pvpEncounter
        && Number(state.vitals?.hp || 0) > 0;
}

function skillAdapter(record) {
    const resolved = Profile.skillSnapshotsFromRecords([record])[0] || record;
    const semantic = Rules.resolve({ selfId: Number(record.selfId), level: Number(record.level || 1) });
    return {
        record, semantic,
        fetchSelfId: () => Number(record.selfId),
        fetchLevel: () => Number(record.level || 1),
        fetchSemantic: () => semantic,
        fetchTargetKind: () => semantic.target,
        fetchConsumedMp: () => Math.max(0, Number(resolved.mp ?? semantic.mpConsume ?? 0)),
        fetchBuffTime: () => Math.max(0, Number(resolved.buffTime ?? semantic.durationMs ?? 0))
    };
}

function select(provider, recipient, timestamp = Date.now()) {
    if (!available(provider) || !available(recipient) || provider.spotId !== recipient.spotId
        || provider.characterId === recipient.characterId || !Policy.serviceClass(provider)) return null;
    if (timestamp - Number(recipient.stats?.lastBuffServicePurchase?.at || 0) < BUYER_COOLDOWN_MS) return null;
    const active = (recipient.stats?.coldCombat?.effects || [])
        .filter(effect => Number(effect.expiresAt || 0) > timestamp + Policy.REFRESH_MS);
    const byFamily = new Map();
    (Profile.profileFor(provider, timestamp).skills || [])
        .filter(record => !record.passive)
        .map(skillAdapter)
        .filter(Policy.eligibleSkill)
        .filter(skill => Loadout.useful(recipient, skill))
        .forEach(skill => {
            const semantic = skill.fetchSemantic();
            const family = Loadout.family(semantic.effect);
            if (active.some(effect => Loadout.family(effect.key) === family
                && Number(effect.level || 0) >= skill.fetchLevel())) return;
            const previous = byFamily.get(family);
            if (!previous || previous.fetchLevel() < skill.fetchLevel()) byFamily.set(family, skill);
        });
    const selected = [];
    let mpCost = 0;
    const mpBudget = Math.max(0, Number(provider.vitals?.mp || 0) - Number(provider.vitals?.maxMp || 0) * 0.2);
    for (const skill of byFamily.values()) {
        const cost = skill.fetchConsumedMp();
        if (selected.length >= 12 || mpCost + cost > mpBudget) continue;
        selected.push(skill);
        mpCost += cost;
    }
    if (!selected.length) return null;
    return { selected, mpCost };
}

function effectsFor(selected, timestamp) {
    return selected.map(skill => {
        const semantic = skill.fetchSemantic();
        const durationMs = Math.max(60000, Number(semantic.durationMs ?? skill.fetchBuffTime()) || 20 * 60000);
        const key = Loadout.normalize(semantic.effect);
        return { key, id: skill.fetchSelfId(), level: skill.fetchLevel(), name: semantic.effect,
            type: 'buff', durationMs, expiresAt: timestamp + durationMs,
            stackFamily: semantic.stackFamily || Loadout.family(key),
            stackOrder: semantic.stackOrder ?? null, stats: { ...(semantic.stats || {}) } };
    });
}

function project(provider, recipients, timestamp = Date.now()) {
    if (!available(provider) || !Policy.serviceClass(provider)
        || timestamp - Number(provider.stats?.lastBuffService?.at || 0) < BUYER_COOLDOWN_MS) return null;
    let inspected = 0;
    const iterator = recipients[Symbol.iterator]();
    while (inspected++ < MAX_RECIPIENTS) {
        const next = iterator.next();
        if (next.done) break;
        const entry = next.value;
        const recipient = Array.isArray(entry) ? entry[1] : entry;
        const choice = select(provider, recipient, timestamp);
        if (!choice) continue;
        // ARCH-NOTE: Full effect objects exceed 0.5 KB. Native id/rank tuples
        // restore the identical static effects on main without a combat review.
        const offer = { providerId: Number(provider.characterId), recipientId: Number(recipient.characterId),
            providerRevision: Number(provider.simulation?.revision || 0), recipientRevision: Number(recipient.simulation?.revision || 0),
            spotId: provider.spotId, mpCost: choice.mpCost,
            effects: choice.selected.map(skill => [skill.fetchSelfId(), skill.fetchLevel()]), timestamp };
        if (Buffer.byteLength(JSON.stringify(offer), 'utf8') <= MAX_OFFER_BYTES) return offer;
    }
    return null;
}
function expand(effects, timestamp) {
    return effectsFor(effects.map(([selfId, level]) => skillAdapter({ selfId, level })), timestamp);
}
module.exports = { available, skillAdapter, select, effectsFor, project, expand,
    BUYER_COOLDOWN_MS, MAX_RECIPIENTS, MAX_OFFER_BYTES };
