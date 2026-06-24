const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const ShotStock = invoke('GameServer/Inventory/ShotStock');

const SLOT_NAMES = {
    1: 'right_ear',
    2: 'left_ear',
    3: 'neck',
    4: 'right_finger',
    5: 'left_finger',
    6: 'head',
    7: 'weapon',
    8: 'shield',
    9: 'hands',
    10: 'chest',
    11: 'pants',
    12: 'feet',
    14: 'dual',
    15: 'armor'
};

function pct(value) {
    return Math.round((Number(value) || 0) * 100);
}

function safeNumber(read, fallback = 0) {
    try {
        const value = read();
        return Number.isFinite(Number(value)) ? Number(value) : fallback;
    } catch (_) {
        return fallback;
    }
}

function compactTarget(target) {
    if (!target) return null;
    return {
        type: target.type,
        name: target.name || null,
        level: target.level || null,
        dead: target.dead,
        distance: target.distance ? Math.round(target.distance) : null
    };
}

function compactParty(party) {
    if (!party) return null;
    return {
        leader: party.leader?.name || null,
        stance: party.stance,
        role: party.role,
        members: (party.members || []).map((member) => ({
            name: member.name,
            role: member.role,
            leader: !!member.leader,
            self: !!member.self,
            hpPct: pct(member.hpPct),
            mpPct: pct(member.mpPct),
            distance: member.distance ? Math.round(member.distance) : null,
            dead: !!member.dead,
            stance: member.stance || null
        })),
        threat: party.threat ? {
            type: party.threat.type,
            source: party.threat.source || null,
            targetId: party.threat.targetId || null,
            actor: compactTarget({
                type: party.threat.type,
                name: party.threat.actor?.name || null,
                level: party.threat.actor?.level || null,
                dead: party.threat.actor?.dead,
                distance: party.threat.actor?.distance
            })
        } : null
    };
}

function compactSpot(spot) {
    if (!spot) return null;
    return {
        id: spot.id,
        name: spot.name,
        minLevel: spot.minLevel,
        maxLevel: spot.maxLevel,
        density: spot.density
    };
}

function buffSnapshot(actor, status) {
    const snapshot = status?.buffs || BotBuffs.snapshot(actor);
    const active = Object.entries(BotBuffs.ALL_BUFFS)
        .map(([type, buff]) => ({
            type,
            key: buff.key,
            name: buff.name,
            remainingSec: Number(snapshot[buff.key] || 0)
        }))
        .filter((buff) => buff.remainingSec > 0);

    return {
        eligible: !!snapshot.eligible,
        needsRefresh: !!snapshot.needsRefresh,
        needsSupportRefresh: !!snapshot.needsSupportRefresh,
        active,
        missingNewbie: actor ? BotBuffs.missingNewbieBuffs(actor, BotBuffs.REFRESH_THRESHOLD_MS) : []
    };
}

function itemSummary(item, detailed = false) {
    if (!item) return null;

    const summary = {
        objectId: item.fetchId(),
        selfId: item.fetchSelfId(),
        name: item.fetchName(),
        kind: item.fetchKind(),
        amount: item.fetchAmount(),
        equipped: !!(item.fetchEquipped && item.fetchEquipped()),
        slot: item.fetchSlot ? SLOT_NAMES[item.fetchSlot()] || item.fetchSlot() : 0,
        stackable: !!(item.fetchStackable && item.fetchStackable()),
        consumable: !!(item.fetchConsumable && item.fetchConsumable())
    };

    if (item.fetchRank) {
        summary.rank = item.fetchRank();
    }

    if (detailed || summary.equipped) {
        if (item.isWeapon && item.isWeapon()) {
            summary.stats = {
                pAtk: item.fetchPAtk(),
                pAtkRnd: item.fetchPAtkRnd(),
                mAtk: item.fetchMAtk(),
                atkSpd: item.fetchAtkSpd(),
                critical: item.fetchCritical(),
                accuracy: item.fetchAccur(),
                soulshotCost: item.fetchSoulshot(),
                spiritshotCost: item.fetchSpiritshot()
            };
        } else if (item.isArmor && item.isArmor()) {
            summary.stats = {
                pDef: item.fetchPDef(),
                mDef: item.fetchMDef(),
                evasion: item.fetchEvasion(),
                bonusMp: item.fetchBonusMp()
            };
        }
    }

    return summary;
}

function equipmentSnapshot(actor) {
    const backpack = actor?.backpack;
    if (!backpack) return null;

    const equipped = backpack.fetchItems()
        .filter((item) => item.fetchEquipped && item.fetchEquipped())
        .map((item) => itemSummary(item, true));

    return {
        weapon: itemSummary(backpack.fetchEquippedWeapon?.(), true),
        equipped,
        totals: {
            pAtk: safeNumber(() => backpack.fetchTotalWeaponPAtk?.(), safeNumber(() => actor.fetchPAtk?.())),
            mAtk: safeNumber(() => backpack.fetchTotalWeaponMAtk?.(), safeNumber(() => actor.fetchMAtk?.())),
            pDef: safeNumber(() => backpack.fetchTotalArmorPDef?.(actor.isSpellcaster?.()), safeNumber(() => actor.fetchPDef?.())),
            mDef: safeNumber(() => backpack.fetchTotalArmorMDef?.(), safeNumber(() => actor.fetchMDef?.())),
            load: safeNumber(() => backpack.fetchTotalLoad?.())
        }
    };
}

function inventorySnapshot(actor, text = '') {
    const backpack = actor?.backpack;
    if (!backpack) return null;

    const items = backpack.fetchItems();
    const lower = String(text || '').toLowerCase();
    const wantsItems = /\b(item|items|inventory|gear|weapon|armor|adena|shot|trade|loot|give|sell|buy)\b/.test(lower) ||
        /(инвент|вещ|шмот|оруж|брон|аден|сос|трейд|лут|дай|прод)/.test(lower);
    const shotPlan = ShotStock.planForActor(actor);
    const shotItem = backpack.fetchItemFromSelfId(shotPlan.selfId);

    const notable = items
        .filter((item) =>
            (item.fetchEquipped && item.fetchEquipped()) ||
            (item.fetchConsumable && item.fetchConsumable()) ||
            item.fetchSelfId() === shotPlan.selfId ||
            item.fetchSelfId() === 57
        )
        .slice(0, wantsItems ? 24 : 12)
        .map((item) => itemSummary(item, wantsItems));

    return {
        adena: safeNumber(() => backpack.fetchTotalAdena()),
        totalItems: items.length,
        totalLoad: safeNumber(() => backpack.fetchTotalLoad()),
        shots: {
            kind: shotPlan.kind,
            rank: shotPlan.rank,
            selfId: shotPlan.selfId,
            name: shotPlan.name,
            amount: Number(shotItem?.fetchAmount?.() || 0),
            loaded: shotPlan.kind === 'spiritshot' ? !!actor.spiritshotLoaded : !!actor.soulshotLoaded
        },
        notable,
        truncated: notable.length < items.length
    };
}

function skillSummary(skill) {
    if (!skill) return null;
    return {
        selfId: skill.fetchSelfId(),
        name: skill.model?.name || '',
        level: skill.fetchLevel(),
        passive: !!skill.fetchPassive(),
        mpCost: skill.fetchConsumedMp() || 0,
        hpCost: skill.fetchConsumedHp() || 0,
        range: skill.fetchDistance() || 0,
        hitTime: skill.fetchHitTime() || 0,
        reuseMs: skill.fetchReuseTime() || 0,
        power: skill.fetchPower() || 0
    };
}

function skillsSnapshot(actor, text = '') {
    const skills = actor?.skillset?.fetchSkills ? actor.skillset.fetchSkills() : [];
    const lower = String(text || '').toLowerCase();
    const wantsSkills = /\b(skill|skills|heal|buff|haste|shield|might|wind walk|windwalk|spoil|sweep)\b/.test(lower) ||
        /(скилл|хил|баф|хаст|щит|майт|винд|спойл|свип)/.test(lower);
    const active = skills
        .filter((skill) => !skill.fetchPassive())
        .slice(0, wantsSkills ? 24 : 12)
        .map(skillSummary);

    return {
        active,
        passiveCount: skills.filter((skill) => skill.fetchPassive()).length,
        support: {
            canHeal: BotRoles.isHealer(actor),
            canBuff: BotRoles.canBuff(actor),
            availableBuffs: Object.keys(BotBuffs.SUPPORT_BUFFS)
        },
        truncated: active.length < skills.filter((skill) => !skill.fetchPassive()).length
    };
}

function compactStatus(session, status, text = '') {
    if (!status || !status.available) return status;

    const actor = session?.actor;
    return {
        name: status.name,
        level: status.level,
        classId: status.classId,
        mode: status.mode,
        intent: status.intent,
        role: status.role,
        vitals: {
            hpPct: pct(status.vitals.hpPct),
            mpPct: pct(status.vitals.mpPct)
        },
        target: compactTarget(status.target),
        party: compactParty(status.party),
        nearby: status.nearby,
        blockers: status.blockers,
        spot: compactSpot(status.spot),
        buffs: buffSnapshot(actor, status),
        equipment: equipmentSnapshot(actor),
        inventory: inventorySnapshot(actor, text),
        skills: skillsSnapshot(actor, text),
        roleDecision: status.roleDecision || null,
        social: status.social || null
    };
}

module.exports = {
    compactStatus
};
