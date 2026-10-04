const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Clan = invoke('GameServer/Clan/ClanService');
const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const BotErrands = invoke('GameServer/Bot/Population/BotErrands');
const BUSY_FLAGS = ['partyMarketReturn', 'pvpEncounter', 'marketStore', 'craftShop',
    'warehouseWorkflow', 'warehouseErrand', 'supplyErrand'];

function eligible(state, objective) {
    const ownDuty = state?.stats?.clanPartyObjective;
    const planDuty = state?.stats?.equipmentPlan?.clanGoal;
    const party = state?.party?.partyId && Parties.find(state.party.partyId);
    return state?.phase === 'cold' && !BotErrands.busyWith(state, BUSY_FLAGS) && !Identity.isStaticService(state)
        && String(state.simulation?.ownerId || 'legacy_main') === 'legacy_main'
        && Number(state.vitals?.hp) > 0
        && ['hunting', 'resting', 'party_wait', 'grouped', 'shopping', 'traveling'].includes(state.activity)
        && (!state.stats?.travel || ['hunting', 'grouped'].includes(state.stats.travel.arrivalActivity))
        && !state.stats?.coldCompetition?.wait
        && (!ownDuty?.clanGoalKey || Number(ownDuty.clanId) === Number(objective.clanId))
        && (!planDuty?.goalKey || Number(planDuty.clanId) === Number(objective.clanId))
        && (!party || party.status === 'active'
            && (!party.stats?.objective?.clanGoalKey || party.stats.objective.clanGoalKey === objective.clanGoalKey));
}

async function rescue({ requester, objective, rows, entry, commit, create, release, listeners, now }) {
    if (!eligible(requester, objective)) return null;
    const clanId = Number(entry.clanId);
    const memberOfClan = state => Clan.findById(clanId)?.members?.some(member => Number(member.id) === Number(state.characterId));
    const sameDuty = party => party?.status === 'active' && party.stats?.objective?.clanGoalKey === objective.clanGoalKey;
    const target = Parties.active().find(party => sameDuty(party)
        && party.memberIds.includes(requester.characterId))
        || Parties.active().find(party => sameDuty(party));
    if (target && require('./PartyMarketBreak').pending(target, now).length) return null;
    const retained = target ? await Life.statesForParty(target.partyId) : [requester];
    if (target && (retained.length !== target.memberIds.length || !retained.every(state =>
        eligible(state, objective) && memberOfClan(state)))) return null;
    const maxSize = Math.max(2, Math.min(9, Number(objective.maxPartySize) || 9));
    const minSize = Math.max(2, Math.min(maxSize, Number(objective.minPartySize) || 3));
    const helpers = rows.filter(state => eligible(state, objective) && memberOfClan(state)
        && !retained.some(member => member.characterId === state.characterId))
        .sort((a, b) => Number(!!a.party?.partyId) - Number(!!b.party?.partyId)
            || Math.abs(a.level - requester.level) - Math.abs(b.level - requester.level));
    // Fix the requesting bot in the roster: a generic best-group selection
    // must not silently leave the very bot asking for help behind.
    const anchor = retained.some(state => state.characterId === requester.characterId)
        ? retained : [...retained, requester];
    if (anchor.length > maxSize) return null;
    const selected = [...anchor, ...Composition.selectRecruits(anchor, helpers.filter(state =>
        !anchor.some(member => member.characterId === state.characterId)),
    { maxSize, levelRange: 4 })];
    if (selected.length < minSize || target && selected.length === retained.length) return null;
    const helper = selected.find(state => state.characterId !== requester.characterId
        && (!target || !retained.includes(state))) || selected.find(state => state.characterId !== requester.characterId);
    if (!helper || !listeners(clanId) || !selected.every(memberOfClan)) return null;
    // Only after a complete roster is known may personal parties be interrupted.
    const moved = [];
    for (const state of selected) {
        const mustLeave = state.party?.partyId && state.party.partyId !== target?.partyId;
        const fresh = mustLeave ? await release?.(state) : state;
        if (!fresh) return null;
        moved.push({ ...fresh, activity: fresh.activity === 'resting' ? 'resting' : 'grouped', stats: { ...fresh.stats, travel: null,
            clanPartyObjective: { ...objective, status: 'open', requestedAt: now },
            partyRequest: { ...objective, status: 'open', requestedAt: now } } });
    }
    if (!listeners(clanId) || !moved.every(memberOfClan)) return null;
    const help = { until: now + 10 * 60000, memberIds: moved.map(state => state.characterId) };
    let party;
    if (target) {
        const result = await commit({ ...target, memberIds: help.memberIds,
            roleCoverage: Composition.roleCoverage(moved), stats: { ...target.stats, clanHelp: help,
                memberNames: moved.map(state => state.name), lastRecruitAt: now } }, moved, {
            characterId: target.leaderId, eventType: 'party_recruit', summary: `Clan reinforced the hunt for ${requester.name}`,
            meta: { partyId: target.partyId, reason: 'clan_rescue', memberIds: help.memberIds }, weight: 3, createdAt: now
        });
        if (result?.party && !result.failed?.length) party = result.party;
    } else {
        party = await create(moved, { ...objective, status: 'open', priority: 'required', rescue: true });
    }
    if (!party) return null;
    invoke('GameServer/Bot/AI/BotClanChat').onPartyHelp(helper, requester, party, clanId, now);
    return party;
}
module.exports = { rescue, eligible };
