const Forecast = require('../Bot/Population/RaidCombatAssessment');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Items = require('../Item/ItemTemplateIndex');
const Expedition = require('./ClanRaidExpedition');
const Supply = require('../Bot/Population/RaidSupplyPolicy');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Offense = require('./ClanRaidOffense');

// Clan composition is owned by ClanRaidPolicy. Its healers and caster buffers
// spend mana on support; music fighters and the tank retain their native hits.
function combatRole(member) {
    if (Roles.isPartyMusicFighter(member)) return 'damage';
    const role = Roles.inferRole(member);
    return role === 'tank' ? 'tank' : ['healer', 'buffer'].includes(role) ? 'healer' : 'damage';
}

function estimate(members, spot, cache = new Map(), options = {}) {
    const timestamp = options.timestamp ?? cache.get('raid_timestamp') ?? Date.now();
    cache.set('raid_timestamp', timestamp);
    const coreIds = options.coreMemberIds;
    const npc = Items.find(invoke('GameServer/DataCache').npcs, spot.raidBossTemplateId);
    const core = member => !coreIds || coreIds.includes(Expedition.id(member));
    const key = `raid_preparation:${options.clanId || 0}:${members.map(s => s.characterId ?? s.id).join(',')}:${coreIds?.join(',') || ''}`;
    let entry = cache.get(key);
    // The job's roster snapshots are immutable. Repeated recruitment pages
    // and bosses share one preparation and its native fight profiles.
    if (!entry || !members.every((member, i) => entry.members[i] === member)) {
        entry = { members, preparation: null, roleFor: member => !core(member) && combatRole(member) === 'tank' ? 'damage' : combatRole(member) };
        cache.set(key, entry);
    }
    const equipment = Forecast.equipmentFailures(members.filter(core), entry.roleFor, cache);
    if (!equipment.length && !entry.preparation) {
        // Prospective recruits are evaluated as future clan members; original
        // snapshots/proof rows remain untouched and admission checks real joins.
        const future = options.clanId > 0 ? members.map(member => ({ ...member, clanId: options.clanId,
            stats: { ...member.stats, clanId: options.clanId } })) : members;
        const prepareGroup = group => {
            const groupKey = `raid_group:${options.clanId || 0}:${group.map(Expedition.id).join(',')}`;
            let held = cache.get(groupKey);
            if (!held || !group.every((member, i) => held.members[i] === member)) {
                held = { members: group, preparation: Forecast.prepared(group.map(member => future[members.indexOf(member)]), timestamp) };
                cache.set(groupKey, held);
            }
            return held.preparation;
        };
        if (coreIds) {
            const groups = [members.filter(core), members.filter(member => !core(member))].filter(group => group.length);
            const preparations = groups.map(prepareGroup);
            entry.preparation = { states: preparations.flatMap(p => p.states), at: Math.max(...preparations.map(p => p.at)),
                ready: preparations.every(p => p.ready) };
        } else entry.preparation = prepareGroup(members);
        entry.fighters = Forecast.fightersFor(entry.preparation, entry.roleFor).map(fighter => ({ ...fighter,
            ...(core(fighter.state) ? {} : { contribution: .65 }) }));
        entry.offenseFor = Offense.forRaid(entry.fighters, entry.preparation.at, Forecast.attack, { coldReuse: true });
        // Helpers without an affordable reserve still contribute ordinary
        // uncharged attacks. Their poverty never vetoes the main party.
        entry.helpers = entry.fighters.filter(f => !core(f.state) && f.role !== 'healer');
    }
    if (entry.helpers?.length && Array.isArray(options.unchargedHelperIds)) {
        entry.helpers.forEach(f => { f.charged = !options.unchargedHelperIds.includes(Expedition.id(f.state)); });
    } else if (entry.helpers?.length) {
        const supplyKey = `raid_helper_supply:${key}:${entry.helpers.some(Offense.isMage) ? npc?.selfId : ''}`;
        let held = cache.get(supplyKey);
        if (held?.entry !== entry) {
            const boss = npc && Combat.npcCombatStats(npc);
            const targets = boss ? [boss,...Forecast.guardProfiles(npc).map(guard=>guard.profile).filter(Boolean)] : [];
            const plans = entry.helpers.map(f => {
                const plan = Shots.planForState(f.state);
                const actions = Offense.isMage(f) && boss ? Math.max(...targets.map(target =>
                    Offense.attack(f, target, 720, entry.preparation.at, true).rate)) * 720
                    : 720000 / Combat.normalAttackMs(f.profile);
                return { id: Expedition.id(f.state), selfId: plan.selfId, perAction: plan.perAction,
                    stock: Number(f.state.inventory?.[plan.selfId]?.amount || 0) + Shots.beginnerAmount(f.state, plan),
                    required: Math.ceil(actions * plan.perAction * 1.3) };
            });
            held = { entry, plans, terms: Supply.supplies(members, plans, timestamp) };
            cache.set(supplyKey, held);
        }
        entry.helpers.forEach((f, index) => {
            const s = held.terms[index];
            f.charged = held.plans[index].perAction > 0 && (!s.missing || s.available >= s.missing && s.cash >= s.reserveCost);
        });
    }
    // Like random target selection, screen damage/duration before the full
    // defensive/healing/market pass. Reuse this exact offense on a viable boss.
    let offenseEstimate;
    if (!equipment.length && entry.preparation?.ready) {
        offenseEstimate = npc && Forecast.damageEstimate(
            entry.fighters.filter(f => f.role !== 'healer'), npc,
            { offenseFor: entry.offenseFor, maxFightSeconds: options.maxFightSeconds ?? 720 });
        if (offenseEstimate?.complete && Number.isFinite(offenseEstimate.grossDps) && Number.isFinite(offenseEstimate.regen)) {
            const { grossDps, regen, seconds } = offenseEstimate;
            const reason = grossDps <= regen * 1.5 ? 'raid_damage_below_regeneration'
                : !Number.isFinite(seconds) || seconds > (options.maxFightSeconds ?? 720) ? 'raid_fight_too_long' : null;
            if (reason) return { assessment: { ready:false, reason, reasons:[reason], grossDps, regen,
                ...(Number.isFinite(seconds) ? { seconds } : {}), unchecked:['defense','healing','supplies'] }, estimate:null };
        }
    }
    const assessment = Forecast.assessment(members, spot, { ...options, timestamp,
        preparation: entry.preparation, roleFor: entry.roleFor, readinessCache: cache, offenseEstimate,
        fundSupplies: options.fundSupplies !== false });
    if (!assessment.ready) return { assessment, estimate: null };
    const defense = assessment.defense;
    return { assessment, estimate: {
        fightSeconds: assessment.seconds,
        preparationSeconds: Math.max(90, (entry.preparation.at - timestamp) / 1000), recoverySeconds: 60,
        successChance: .95, damagePerSecond: assessment.grossDps, regenerationPerSecond: assessment.regen,
        healingBudget: assessment.healing, healingPerSecond: assessment.healing / assessment.seconds,
        tankSurvivalSeconds: defense.maxHp / Math.max(1, defense.bossDps + defense.guardDps),
        supplyCost: (assessment.supplies || []).reduce((sum, s) => sum + s.cost, 0),
        supplyReserveCost: (assessment.supplies || []).reduce((sum, s) => sum + s.reserveCost, 0)
    } };
}

module.exports = { estimate, combatRole };
