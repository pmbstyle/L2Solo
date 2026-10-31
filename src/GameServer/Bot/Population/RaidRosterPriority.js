'use strict';

const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Buffs = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const F = invoke('GameServer/Formulas');
const Items = require('../../Item/ItemTemplateIndex');
const Supply = require('./RaidSupplyPolicy');
const Requirements = invoke('GameServer/Skills/SkillRequirements');
const Classes = invoke('GameServer/ClassProgression');
const Enchant = invoke('GameServer/Items/C4EnchantRules');
const Henna = invoke('GameServer/Henna/HennaRules');
const Capabilities = require('../../Clan/ClanCandidateCapabilities');
const Healing = require('./RaidHealingEstimate');
const Minions = require('../../../../data/Npcs/Minions/c4_raid_bosses.json');
const guardsByBoss = new Map();
for (const row of Minions) {
    const id = Number(row.bossId);
    if (!guardsByBoss.has(id)) guardsByBoss.set(id, []);
    guardsByBoss.get(id).push(row);
}

// Candidate ordering hints only: no profiles, simulation, market scans or social reads.
// Admission still hydrates all nine and runs the unchanged native forecast.
function facts(state, role) {
    let armor = 0, weapon, weaponAttack = 0;
    const armorKinds = [], worn = new Map();
    const data = invoke('GameServer/DataCache');
    for (const row of Object.values(state.inventory || {})) {
        if (!(row.amount > 0) || !(row.equipped || row.equippedCount > 0)) continue;
        const item = Items.find(data.items, row.selfId);
        const slots = Gear.equippedSlotsFor(row, item?.etc?.slot);
        const adapter = { ...row, rank: item?.etc?.rank, model: { kind: item?.template?.kind },
            isWeapon: () => String(item?.template?.kind).startsWith('Weapon.') };
        for (const slot of slots) worn.set(slot, item?.template?.kind);
        if (slots.some(slot => [0, 6, 9, 10, 11, 12, 13, 15].includes(slot)))
            armor += Number(item?.stats?.pDef || 0) + Enchant.statBonus(adapter, 'pDef');
        if (String(item?.template?.kind).startsWith('Armor.')) armorKinds.push(item.template.kind);
        if (slots.some(slot => [7, 14].includes(slot))) {
            weapon = item; weaponAttack = Number(item?.stats?.pAtk || 0) + Enchant.statBonus(adapter, 'pAtk');
        }
    }
    if (role === 'tank') return { score: armor * Math.max(1, Number(state.vitals?.maxHp) || 0) };
    if (role === 'damage') {
        const template = Classes.firstClassRow(data.classTemplates || [], Number(state.stats?.classId || state.classId)) || {};
        const base = { ...template.base, ...template.stats, ...state.stats?.coldCombat?.base };
        const henna = Henna.totals(state.stats?.hennas || []), captured = state.stats?.coldCombat?.henna || {};
        for (const key of ['STR', 'DEX']) base[key.toLowerCase()] = Number(base[key.toLowerCase()] || 20)
            + Number(henna[key] || 0) - Number(captured[key] || 0);
        let attackAdd = 0, attackMul = 1, speedMul = 1;
        const gear = { weaponKind: weapon?.template?.kind || '', armorKinds, shield: worn.has(8),
            setKind: Requirements.wornSetKind(worn.get(15), worn.get(10), worn.get(11)) };
        for (const skill of Combat.skillsFor(state)) {
            if (!skill.passive) continue;
            for (const stats of Requirements.passiveStats(Rules.resolveCached({ selfId: skill.selfId, level: skill.level }), gear,
                { hp: 1, maxHp: 1, moving: false, walking: false, seated: false, night: false })) {
                attackAdd += Number(stats.pAtkAdd || 0); attackMul *= Number(stats.pAtkMul || 1);
                speedMul *= Number(stats.pAtkSpdMul || 1);
            }
        }
        // Allow for party haste while ranking the wallet's shot duration.
        const speed = F.calcAtkSpd(Number(base.dex || 20), Number(weapon?.stats?.atkSpd || 300)) * speedMul * 1.5;
        const cycle = F.normalAttackMs(speed, { bow: weapon?.template?.kind === 'Weapon.Bow',
            reuseDelay: weapon?.stats?.reuseDelay || 1500 });
        const shot = Shots.planForState(state);
        const price = Number(invoke('GameServer/Bot/Economy/StaticMerchantPricing').botPurchasePrice(shot.selfId));
        const stock = Number(state.inventory?.[shot.selfId]?.amount || 0) + Shots.beginnerAmount(state, shot);
        const purchasable = price > 0 ? Supply.cash(state) / price : 0;
        const seconds = (stock + purchasable) * cycle / (1000 * Math.max(1, shot.perAction) * 1.3);
        const attack = F.calcPAtk(Number(state.level), Number(base.str || 20), weaponAttack) * attackMul + attackAdd;
        return { score: attack * 1000 / cycle
            * Math.min(1, seconds / 720) };
    }
    const buffs = new Map();
    let efficiency = 0;
    for (const skill of Combat.skillsFor(state)) {
        if (skill.passive) continue;
        efficiency = Math.max(efficiency, Healing.efficiency(skill, Math.max(0, Number(state.vitals?.maxHp) || 0)));
        const semantic = Rules.resolveCached(skill), stats = semantic?.stats || {};
        if (!Capabilities.mainBuffSkill(skill)) continue;
        const benefit = ['pAtkMul', 'pDefMul', 'maxHpMul', 'pAtkSpdMul'].reduce((sum, key) =>
            sum + Math.max(0, Number(stats[key] || 1) - 1) * 4, 0)
            + Math.max(0, Number(stats.pCritDamageMul || 1) - 1)
            + Math.max(0, Number(stats.pCritRateAdd || 0)) / 100;
        if (!benefit) continue;
        const family = Buffs.family(semantic.effect, semantic.stackFamily);
        buffs.set(family, Math.max(buffs.get(family) || 0, benefit));
    }
    return { score: efficiency * Math.max(0, Number(state.vitals?.maxMp) || 0) / 5000, buffs };
}

// Two linear scans favour complementary learned buffs over two copies of
// the same loadout. This never adds unlearned skills or bypasses composition.
function* supportPair(healers, scores) {
    const selected = [], supplied = new Map();
    for (let i = 0; i < 2; i++) {
        let best, value = -Infinity;
        for (const state of healers) {
            if (!selected.includes(state)) {
                const hint = scores.get(state.characterId);
                let score = hint.score;
                for (const [family, benefit] of hint.buffs)
                    score += Math.max(0, benefit - (supplied.get(family) || 0));
                if (score > value) { best = state; value = score; }
            }
            yield;
        }
        if (!best) return null;
        selected.push(best);
        for (const [family, benefit] of scores.get(best.characterId).buffs)
            supplied.set(family, Math.max(supplied.get(family) || 0, benefit));
    }
    return selected;
}

function targetScore(spot) {
    const templates = invoke('GameServer/DataCache').npcs;
    const npc = Items.find(templates, spot.raidBossTemplateId);
    if (!npc) return Infinity;
    const p = Combat.npcCombatStats(npc);
    let durability = p.maxHp * p.pDef, pressure = p.pAtk * p.atkSpd;
    // Cheap template-only hint: work to clear the encounter times its opening
    // attack pressure. Use the same maximum guard counts as admission. Exact
    // weapon matchups, regeneration and respawning waves stay in the forecast.
    for (const row of guardsByBoss.get(Number(npc.selfId)) || []) {
        const count = Number(row.max || row.min || 0);
        if (!count) continue;
        const guard = Items.find(templates, row.minionId);
        if (!guard) return Infinity;
        const g = Combat.npcCombatStats(guard);
        durability += g.maxHp * g.pDef * count;
        pressure += g.pAtk * g.atkSpd * count;
    }
    return durability * pressure;
}

module.exports = { facts, supportPair, targetScore };
