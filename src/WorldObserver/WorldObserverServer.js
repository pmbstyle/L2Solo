const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const DataCache = invoke('GameServer/DataCache');
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8'
};

const WORLD_BOUNDS = {
    minX: -131072,
    maxX: 229376,
    minY: -262144,
    maxY: 262144
};

const MAP_TILES = {
    source: 'https://github.com/npetrovski/l2-world-map',
    rawBaseUrl: 'https://raw.githubusercontent.com/npetrovski/l2-world-map/main/Maps',
    blockSize: 32768,
    blockPx: 900,
    x: { min: 16, max: 26, mid: 20 },
    y: { min: 10, max: 25, mid: 18 },
    missingTiles: [
        '17_14',
        '18_13',
        '26_13',
        '26_15',
        '26_16',
        '26_17',
        '26_18',
        '26_19'
    ],
    alternatives: [
        {
            name: 'L2J C4 common map',
            url: 'https://l2j.ru/img/maps/c4_all.jpg',
            note: 'large C4 poster map; needs manual coordinate calibration'
        },
        {
            name: 'PMfun Aden World Map C4 (big)',
            url: 'https://lineage.pmfun.com/data/maps/world/Aden%20World%20Map%20C4%20%28big%29.jpg',
            note: 'large C4 poster map; useful as a visual reference'
        }
    ]
};

const REGION_LABELS = [
    { name: 'Talking Island', locX: -84318, locY: 244579, kind: 'town' },
    { name: 'Gludin', locX: -80826, locY: 149775, kind: 'town' },
    { name: 'Gludio', locX: -12672, locY: 122776, kind: 'town' },
    { name: 'Dion', locX: 15664, locY: 142979, kind: 'town' },
    { name: 'Giran', locX: 83400, locY: 147943, kind: 'town' },
    { name: 'Oren', locX: 82960, locY: 53177, kind: 'town' },
    { name: 'Aden', locX: 146785, locY: 25813, kind: 'town' },
    { name: "Hunter's Village", locX: 117110, locY: 76883, kind: 'town' },
    { name: 'Heine', locX: 111395, locY: 219000, kind: 'town' },
    { name: 'Goddard', locX: 147725, locY: -56517, kind: 'town' },
    { name: 'Rune', locX: 43835, locY: -47749, kind: 'town' },
    { name: 'Elven Village', locX: 46934, locY: 51467, kind: 'starter' },
    { name: 'Dark Elven Village', locX: 9745, locY: 15606, kind: 'starter' },
    { name: 'Orc Village', locX: -44133, locY: -113911, kind: 'starter' },
    { name: 'Dwarven Village', locX: 115120, locY: -178212, kind: 'starter' }
];

function isEnabled() {
    const config = options.default.WorldObserver || {};
    return config.enabled !== false && String(config.enabled || 'true').toLowerCase() !== 'false';
}

function safePercent(value) {
    const number = Number(value || 0);
    return Math.max(0, Math.min(100, Math.round(number * 100)));
}

function actorLoc(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function actorVitals(actor) {
    return {
        hp: actor.fetchHp(),
        maxHp: actor.fetchMaxHp(),
        hpPct: safePercent(actor.fetchHp() / Math.max(1, actor.fetchMaxHp())),
        mp: actor.fetchMp(),
        maxMp: actor.fetchMaxMp(),
        mpPct: safePercent(actor.fetchMp() / Math.max(1, actor.fetchMaxMp()))
    };
}

function normalizedClassId(value) {
    if (value === null || value === undefined || value === '') return null;
    const classId = Number(value);
    return Number.isInteger(classId) && classId >= 0 ? classId : null;
}

function className(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return null;
    return (DataCache.classTemplates || [])
        .find((template) => Number(template.classId) === classId)
        ?.template?.class || null;
}

function isPkActor(actor) {
    return Number(actor?.fetchKarma?.() || 0) > 0;
}

function realPlayerSessions() {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).filter((session) => (
        session.actor &&
        session.accountId &&
        !String(session.accountId).startsWith('bot_')
    ));
}

function compactPlayer(session) {
    const actor = session.actor;
    const classId = normalizedClassId(actor.fetchClassId?.());
    return {
        id: actor.fetchId(),
        name: actor.fetchName(),
        level: actor.fetchLevel(),
        classId,
        className: className(classId),
        loc: actorLoc(actor),
        vitals: actorVitals(actor),
        online: !!actor.fetchIsOnline(),
        isPk: isPkActor(actor)
    };
}

function compactHotBot(status, pkIds = new Set()) {
    const classId = normalizedClassId(status.classId);
    return {
        id: status.id,
        name: status.name,
        phase: 'hot',
        level: status.level,
        classId,
        className: className(classId),
        mode: status.mode,
        intent: status.intent,
        role: status.role,
        home: status.home,
        loc: status.loc,
        vitals: {
            hpPct: safePercent(status.vitals?.hpPct),
            mpPct: safePercent(status.vitals?.mpPct)
        },
        target: status.target ? {
            type: status.target.type,
            name: status.target.name || null,
            distance: status.target.distance ? Math.round(status.target.distance) : null
        } : null,
        party: status.party ? {
            leader: compactPartyLeader(status.party.leader),
            leaderId: Number(status.party.leader?.id || 0) || null,
            stance: status.party.stance,
            role: status.party.role
        } : null,
        spot: status.spot ? {
            id: status.spot.id,
            name: status.spot.name,
            minLevel: status.spot.minLevel,
            maxLevel: status.spot.maxLevel,
            density: status.spot.density
        } : null,
        movement: status.movement,
        nearby: status.nearby,
        trade: status.trade,
        blockers: status.blockers || [],
        lastSocialEvent: status.lastSocialEvent || null,
        roleDecision: status.roleDecision || null,
        isPk: pkIds.has(Number(status.id))
    };
}

function compactStateBot(state, hotIds, leaderState = null) {
    if (hotIds.has(Number(state.characterId))) return null;
    const stats = state.stats || {};
    const classId = normalizedClassId(stats.classId ?? stats.classProgressionClassId);
    const leaderId = Number(state.party?.leaderId || stats.leaderId || 0) || null;
    return {
        id: Number(state.characterId),
        name: state.name || 'Bot',
        phase: state.phase || 'cold',
        level: Number(state.level || 1),
        classId,
        className: className(classId),
        mode: state.activity || 'hunting',
        intent: state.phase === 'warm' ? 'background_active' : 'background_resolve',
        role: state.party?.role || stats.role || 'dps',
        home: {
            region: state.currentRegion || state.homeRegion || null,
            visitor: false
        },
        loc: state.loc || { locX: 0, locY: 0, locZ: 0 },
        vitals: {
            hpPct: safePercent(Number(state.vitals?.hp || 0) / Math.max(1, Number(state.vitals?.maxHp || 1))),
            mpPct: safePercent(Number(state.vitals?.mp || 0) / Math.max(1, Number(state.vitals?.maxMp || 1)))
        },
        target: null,
        party: state.party?.partyId ? {
            id: state.party.partyId,
            role: state.party.role || state.stats?.role || 'dps',
            leaderId,
            leader: coldPartyLeader(state, leaderState)
        } : null,
        spot: state.spotId ? { id: state.spotId, name: state.spotId } : null,
        movement: { moving: false, towards: false, stuckTicks: 0 },
        nearby: null,
        trade: null,
        blockers: state.activity === 'dead' ? ['dead'] : [],
        updatedAt: state.updatedAt || 0,
        isPk: state.activity === 'pk_hunting'
    };
}

const EQUIPMENT_SLOTS = {
    1: 'earring',
    2: 'earring',
    3: 'necklace',
    4: 'ring',
    5: 'ring',
    6: 'head',
    7: 'weapon',
    8: 'shield',
    9: 'gloves',
    10: 'chest',
    11: 'legs',
    12: 'feet',
    14: 'two-handed weapon',
    15: 'full armor'
};

function equipmentSlot(slot) {
    if (typeof slot === 'string' && slot.trim() && !/^\d+$/.test(slot.trim())) return slot;
    return EQUIPMENT_SLOTS[Number(slot)] || (slot ? `slot ${slot}` : 'other');
}

function itemTemplate(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function equipmentRank(value) {
    const rank = String(value || 'none').trim().toLowerCase().replaceAll('_', '-');
    return ['none', 'no-grade', 'nograde', '0'].includes(rank) ? 'no-grade' : rank;
}

function compactItem(item) {
    if (!item) return null;
    const template = itemTemplate(item.selfId || item.objectId);
    const stats = item.stats || template?.stats || null;
    return {
        selfId: Number(item.selfId || item.objectId || 0) || null,
        name: item.name || template?.template?.name || 'Unknown item',
        slot: item.slot?.name || equipmentSlot(item.slot || template?.etc?.slot),
        rank: equipmentRank(item.rank || template?.etc?.rank),
        kind: item.kind || template?.template?.kind || '',
        stats: stats ? {
            pAtk: Number(stats.pAtk || 0),
            mAtk: Number(stats.mAtk || 0),
            pDef: Number(stats.pDef || 0),
            mDef: Number(stats.mDef || 0),
            evasion: Number(stats.evasion || 0),
            critical: Number(stats.critical || stats.crit || 0),
            accuracy: Number(stats.accuracy || stats.accur || 0),
            bonusMp: Number(stats.bonusMp || stats.maxMp || 0)
        } : null
    };
}

function compactEquipment(equipment) {
    if (!equipment) return null;
    const equipped = Array.isArray(equipment.equipped)
        ? equipment.equipped.map(compactItem).filter(Boolean)
        : [];
    const weapon = compactItem(equipment.weapon) || equipped.find((item) => item.kind.startsWith('Weapon.')) || null;
    const totals = equipment.totals || null;
    return {
        weapon,
        equipped,
        totals: {
            pAtk: totals ? Number(totals.pAtk || 0) : null,
            mAtk: totals ? Number(totals.mAtk || 0) : null,
            pDef: totals ? Number(totals.pDef || 0) : null,
            mDef: totals ? Number(totals.mDef || 0) : null,
            load: totals ? Number(totals.load || 0) : null
        }
    };
}

function compactBuild(build) {
    if (!build) return null;
    const classId = normalizedClassId(build.classId);
    return {
        role: build.role || null,
        classId,
        className: className(classId),
        classFamily: build.classFamily || null,
        grade: build.grade || null,
        tier: build.tier || null,
        armor: build.armor || null,
        weapon: build.weapon || null,
        playstyle: build.playstyle || null,
        partyNeed: build.partyNeed || null,
        statPriority: Array.isArray(build.statPriority) ? build.statPriority.slice(0, 5) : [],
        exampleGear: Array.isArray(build.exampleGear) ? build.exampleGear.slice(0, 4) : [],
        skills: Array.isArray(build.skills) ? build.skills.slice(0, 6) : [],
        warnings: Array.isArray(build.warnings) ? build.warnings.slice(0, 3) : []
    };
}

function compactDecision(decision) {
    if (!decision) return null;
    return {
        action: decision.action || null,
        reason: decision.reason || null,
        targetId: Number(decision.targetId || 0) || null,
        targetName: decision.targetName || null,
        skillId: Number(decision.skillId || 0) || null,
        skillName: decision.skillName || null,
        score: Number.isFinite(Number(decision.score)) ? Number(decision.score) : null,
        reasons: Array.isArray(decision.reasons) ? decision.reasons.slice(0, 4) : []
    };
}

function fullVitals(vitals = {}) {
    return {
        hp: Number(vitals.hp || 0),
        maxHp: Number(vitals.maxHp || 0),
        hpPct: safePercent(vitals.hpPct ?? (Number(vitals.hp || 0) / Math.max(1, Number(vitals.maxHp || 1)))),
        mp: Number(vitals.mp || 0),
        maxMp: Number(vitals.maxMp || 0),
        mpPct: safePercent(vitals.mpPct ?? (Number(vitals.mp || 0) / Math.max(1, Number(vitals.maxMp || 1))))
    };
}

function effectiveColdCombat(state) {
    const combat = state.stats?.coldCombat || {};
    const inventoryItems = Object.values(state.inventory || {});
    const hasEquippedInventory = inventoryItems.some((item) => item?.equipped);
    const hasPersistedEquipment = (Array.isArray(state.stats?.equipment) && state.stats.equipment.length > 0)
        || hasEquippedInventory;
    if (!combat.base && !combat.equipment && !hasPersistedEquipment) return null;

    // Some generated/legacy cold rows have a skills-only coldCombat snapshot.
    // Rebuild the authoritative profile from the equipped inventory instead of
    // exposing an empty equipment block in the observer.
    const inventory = hasEquippedInventory
        ? state.inventory
        : combat.equipment
            ? {}
            : Object.fromEntries((state.stats?.equipment || []).map((item) => [
                String(item.selfId), { ...item, equipped: true }
            ]));
    const profile = ColdCombatProfile.profileFor({ ...state, inventory });
    return {
        pAtk: Number(profile.pAtk || 0),
        mAtk: Number(profile.mAtk || 0),
        pDef: Number(profile.pDef || 0),
        mDef: Number(profile.mDef || 0),
        critical: Number(profile.critical || 0),
        accuracy: Number(profile.accur || 0),
        evasion: Number(profile.evasion || 0),
        atkSpd: Number(profile.atkSpd || 0),
        castSpd: Number(profile.castSpd || 0),
        maxMp: Number(profile.maxMp || 0)
    };
}

function compactPartyLeader(leader) {
    if (!leader) return null;
    const id = Number(leader.id || leader.characterId || 0) || null;
    if (!id) return null;
    const classId = normalizedClassId(leader.classId);
    return {
        id,
        name: leader.name || null,
        level: Number(leader.level || 0) || null,
        classId,
        className: className(classId),
        role: leader.role || null,
        phase: leader.phase || null
    };
}

function coldPartyLeader(state, leaderState = null) {
    const leaderId = Number(state.party?.leaderId || state.stats?.leaderId || 0) || null;
    if (!leaderId) return null;
    if (leaderState) {
        return compactPartyLeader({
            id: leaderState.characterId,
            name: leaderState.name,
            level: leaderState.level,
            classId: leaderState.stats?.classId || leaderState.stats?.classProgressionClassId,
            role: leaderState.party?.role || leaderState.stats?.role,
            phase: leaderState.phase
        });
    }
    if (leaderId === Number(state.characterId)) {
        return compactPartyLeader({
            id: state.characterId,
            name: state.name,
            level: state.level,
            classId: state.stats?.classId || state.stats?.classProgressionClassId,
            role: state.party?.role || state.stats?.role,
            phase: state.phase
        });
    }
    return { id: leaderId, name: null, level: null, classId: null, role: null, phase: null };
}

function compactColdEquipment(state) {
    const items = Array.isArray(state.stats?.equipment) ? state.stats.equipment : [];
    const combat = effectiveColdCombat(state);
    return compactEquipment({
        weapon: items.find((item) => String(item.kind || '').startsWith('Weapon.')) || null,
        equipped: items,
        totals: combat
    });
}

function coldIntent(state) {
    const activity = state.activity || 'hunting';
    if (activity === 'dead') return 'dead';
    if (activity === 'resting') return 'recover';
    if (activity === 'traveling') return 'travel';
    if (activity === 'party_wait') return 'find_party';
    if (activity === 'merchant') return 'trade';
    if (activity === 'crafting') return 'craft';
    if (state.stats?.equipmentPlan?.next) return 'progress_gear';
    return 'background_hunting';
}

function compactColdPlan(state) {
    const plan = state.stats?.equipmentPlan;
    if (!plan) return null;
    return {
        status: plan.status || null,
        phase: plan.phase || null,
        grade: plan.grade || null,
        target: plan.target ? {
            name: plan.target.name || null,
            slot: equipmentSlot(plan.target.slot),
            selfId: Number(plan.target.selfId || 0) || null
        } : null,
        next: plan.next ? {
            spotId: plan.next.spotId || null,
            npcName: plan.next.npcName || null,
            itemId: Number(plan.next.itemId || 0) || null,
            kind: plan.next.kind || null
        } : null,
        expectedKills: Number(plan.expectedKills || 0) || null,
        requiresParty: !!plan.requiresParty,
        partyNeed: plan.partyNeed || null
    };
}

function compactHotDetail(status, session) {
    const context = BotBrainContext.compactStatus(session, status, '', {
        includeInventory: false,
        includeSkills: false
    });
    const pkIds = isPkActor(session?.actor) ? new Set([Number(status.id)]) : new Set();
    return {
        ...compactHotBot(status, pkIds),
        kind: 'bot',
        vitals: fullVitals(status.vitals),
        movement: status.movement || null,
        nearby: status.nearby || null,
        target: status.target || null,
        party: status.party || null,
        trade: status.trade || null,
        buffs: context?.buffs || status.buffs || null,
        debuffs: status.debuffs || [],
        timers: status.timers || {},
        decisions: Object.fromEntries(Object.entries(status.decisions || {}).map(([key, value]) => [key, compactDecision(value)])),
        build: compactBuild(status.build),
        equipment: compactEquipment(context?.equipment),
        persona: status.persona || null,
        social: status.social || null,
        ambient: status.ambient || null,
        inference: status.inference || null,
        updatedAt: Date.now()
    };
}

function compactColdDetail(state, leaderState = null) {
    const stats = state.stats || {};
    const classId = normalizedClassId(stats.classId ?? stats.classProgressionClassId);
    const lastResolve = stats.lastResolveDebug || null;
    return {
        ...compactStateBot(state, new Set(), leaderState),
        kind: 'bot',
        classId,
        className: className(classId),
        phase: state.phase || 'cold',
        mode: state.activity || 'hunting',
        intent: coldIntent(state),
        region: state.currentRegion || state.homeRegion || null,
        home: {
            region: state.homeRegion || state.currentRegion || null,
            visitor: false
        },
        vitals: fullVitals(state.vitals),
        party: state.party?.partyId ? {
            id: state.party.partyId,
            role: state.party.role || stats.role || 'dps',
            leaderId: Number(state.party.leaderId || stats.leaderId || 0) || null,
            leader: coldPartyLeader(state, leaderState)
        } : null,
        build: compactBuild(stats.build),
        equipment: compactColdEquipment(state),
        combat: effectiveColdCombat(state),
        adena: Number(state.adena || 0),
        exp: Number(state.exp || 0),
        sp: Number(state.sp || 0),
        timing: state.timing || {},
        counters: {
            fightsWon: Number(stats.fightsWon || 0),
            fightsResolved: Number(stats.fightsResolved || 0),
            deaths: Number(stats.deaths || 0),
            expEarned: Number(stats.expEarned || 0),
            spEarned: Number(stats.spEarned || 0),
            adenaEarned: Number(stats.adenaEarned || 0),
            partyGearReceived: Number(stats.partyGearReceived || 0)
        },
        lastResolve: lastResolve ? {
            route: lastResolve.route || null,
            targetNpcId: Number(lastResolve.targetNpcId || 0) || null,
            fights: Number(lastResolve.fights || 0),
            wins: Number(lastResolve.wins || 0),
            at: lastResolve.at || null
        } : null,
        plan: compactColdPlan(state),
        travel: stats.travel || null,
        goal: stats.goal || null,
        persona: BotPersona.generate(state),
        updatedAt: state.updatedAt || 0
    };
}

function countBy(items, field) {
    return items.reduce((counts, item) => {
        const value = item[field] || 'unknown';
        counts[value] = (counts[value] || 0) + 1;
        return counts;
    }, {});
}

function buildSyntheticEvents(bots) {
    return bots
        .filter((bot) => bot.phase === 'hot')
        .slice(0, 8)
        .map((bot) => {
            const detail = bot.target?.name ? `targeting ${bot.target.name}` :
                bot.spot?.name ? `near ${bot.spot.name}` :
                bot.party?.leader?.name ? `following ${bot.party.leader.name}` :
                bot.intent;
            return {
                type: bot.mode || 'bot',
                summary: `${bot.name} is ${detail}`,
                createdAt: Date.now(),
                weight: 1
            };
        });
}

function snapshot() {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
    const PopulationStatus = invoke('GameServer/Bot/Population/PopulationStatus');

    const pkHotIds = new Set(BotManager.sessions
        .filter((session) => isPkActor(session.actor))
        .map((session) => Number(session.actor.fetchId())));
    const hotBots = BotManager.getAllBotStatuses()
        .filter((status) => status && status.available)
        .map((status) => compactHotBot(status, pkHotIds));
    const hotIds = new Set(hotBots.map((bot) => Number(bot.id)));
    // The previous 700-item cap made the observer silently report 735 bots
    // (35 hot + 700 cold) while PopulationStatus already knew about the full
    // persisted population. Keep the payload bounded by the cache contract,
    // but do not hide the rest of the world from the map.
    const states = LifeState.allStates(2000);
    const stateById = new Map(states.map((state) => [Number(state.characterId), state]));
    const stateBots = states
        .map((state) => compactStateBot(state, hotIds, stateById.get(Number(state.party?.leaderId || state.stats?.leaderId))))
        .filter(Boolean);
    const bots = [...hotBots, ...stateBots];
    const players = realPlayerSessions().map(compactPlayer);
    const memory = process.memoryUsage();

    return LifeEvents.recent(18).then((events) => ({
        generatedAt: Date.now(),
        uptimeMs: Math.round(process.uptime() * 1000),
        bounds: WORLD_BOUNDS,
        mapTiles: MAP_TILES,
        labels: REGION_LABELS,
        population: PopulationStatus.counts(),
        runtime: {
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            rssMb: Math.round(memory.rss / 1024 / 1024)
        },
        players,
        bots,
        stats: {
            botsByPhase: countBy(bots, 'phase'),
            botsByMode: countBy(bots, 'mode'),
            botsByRole: countBy(bots, 'role'),
            activeTargets: hotBots.filter((bot) => bot.target).length,
            moving: hotBots.filter((bot) => bot.movement?.moving).length,
            blockers: hotBots.filter((bot) => bot.blockers?.length).length
        },
        events: events.length > 0 ? events : buildSyntheticEvents(bots)
    }));
}

async function botDetail(characterId) {
    const id = Number(characterId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    const BotManager = invoke('GameServer/Bot/BotManager');
    const hotSession = BotManager.findSessionById(id);
    if (hotSession?.actor) {
        const status = BotManager.getBotStatus(hotSession);
        return status?.available ? compactHotDetail(status, hotSession) : null;
    }

    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const state = await LifeState.findByCharacterId(id);
    if (!state) return null;

    const leaderId = Number(state.party?.leaderId || state.stats?.leaderId || 0) || null;
    let leaderState = leaderId === id ? state : null;
    if (leaderId && !leaderState) {
        const leaderSession = BotManager.findSessionById(leaderId);
        if (leaderSession?.actor) {
            const leaderStatus = BotManager.getBotStatus(leaderSession);
            leaderState = {
                characterId: leaderId,
                name: leaderSession.actor.fetchName(),
                level: leaderSession.actor.fetchLevel(),
                phase: 'hot',
                party: { role: leaderStatus?.role || null },
                stats: { classId: leaderSession.actor.fetchClassId?.(), role: leaderStatus?.role || null }
            };
        } else {
            leaderState = await LifeState.findByCharacterId(leaderId);
        }
    }
    return compactColdDetail(state, leaderState);
}

function sendJson(response, data, statusCode = 200) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(data));
}

function sendFile(response, filePath) {
    fs.readFile(filePath, (err, body) => {
        if (err) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        response.end(body);
    });
}

function route(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/observer') {
        response.writeHead(302, { Location: '/observer/' });
        response.end();
        return;
    }

    if (url.pathname === '/observer/api/snapshot') {
        snapshot()
            .then((data) => sendJson(response, data))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    const botMatch = url.pathname.match(/^\/observer\/api\/bot\/(\d+)$/);
    if (botMatch) {
        botDetail(botMatch[1])
            .then((data) => data
                ? sendJson(response, data)
                : sendJson(response, { error: 'Bot not found' }, 404))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    if (url.pathname.startsWith('/observer/')) {
        const relative = url.pathname.replace(/^\/observer\/?/, '') || 'index.html';
        const safeRelative = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(PUBLIC_DIR, safeRelative);
        if (!filePath.startsWith(PUBLIC_DIR)) {
            response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Forbidden');
            return;
        }
        sendFile(response, filePath);
        return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
}

const WorldObserverServer = {
    server: null,
    compactPlayer,
    compactHotBot,
    compactStateBot,
    compactColdDetail,
    compactHotDetail,

    init() {
        if (!isEnabled() || this.server) return;

        const config = options.default.WorldObserver || {};
        const hostname = config.hostname || '127.0.0.1';
        const port = Number(config.port || 8088);

        this.server = http.createServer(route);
        this.server.listen(port, hostname, () => {
            utils.infoSuccess('Observer', 'world observer ready at http://%s:%d/observer/', hostname, port);
        });

        this.server.on('error', (err) => {
            utils.infoWarn('Observer', 'world observer failed: %s', err.message);
        });
    }
};

module.exports = WorldObserverServer;
