const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const ECONOMIC_ROLES = {
    54: 'spoiler',
    55: 'spoiler',
    56: 'crafter',
    57: 'crafter'
};

const ROUTES = [
    {
        id: 'starter_local',
        name: 'starter village hunting',
        minLevel: 1,
        maxLevel: 20,
        modes: ['solo', 'duo', 'party'],
        roles: ['dps', 'tank', 'dagger', 'archer', 'mage', 'healer', 'buffer', 'spoiler', 'crafter'],
        preferredTags: ['starter', 'local'],
        reason: 'starter_leveling'
    },
    {
        id: 'ruins_undead_20_30',
        name: 'Ruins of Agony/Despair',
        minLevel: 18,
        maxLevel: 30,
        modes: ['solo', 'duo', 'party'],
        roles: ['dps', 'tank', 'dagger', 'archer', 'healer', 'buffer', 'spoiler', 'crafter'],
        preferredTags: ['undead', 'ruins'],
        reason: 'early_undead_and_ruins'
    },
    {
        id: 'execution_wasteland_25_35',
        name: 'Execution Ground/Wasteland',
        minLevel: 25,
        maxLevel: 35,
        modes: ['solo', 'duo', 'party'],
        roles: ['dps', 'tank', 'dagger', 'archer', 'mage', 'healer', 'buffer', 'spoiler', 'crafter'],
        preferredTags: ['undead', 'lizardman', 'insect'],
        reason: 'mid_d_grade_grind'
    },
    {
        id: 'spoiler_lizardmen_35_40',
        name: 'Plains of the Lizardmen material route',
        minLevel: 35,
        maxLevel: 40,
        modes: ['solo', 'duo'],
        roles: ['spoiler'],
        requiredTags: ['lizardman'],
        preferredTags: ['material'],
        reason: 'spoiler_materials'
    },
    {
        id: 'cruma_construct_spoil_40_45',
        name: 'Cruma construct spoil route',
        minLevel: 40,
        maxLevel: 45,
        modes: ['solo', 'duo', 'party'],
        roles: ['spoiler', 'crafter'],
        requiredTags: ['construct'],
        preferredTags: ['material'],
        reason: 'spoiler_construct_materials'
    },
    {
        id: 'death_pass_dv_40_52',
        name: 'Death Pass/Dragon Valley',
        minLevel: 38,
        maxLevel: 54,
        modes: ['solo', 'duo', 'party'],
        roles: ['dps', 'tank', 'dagger', 'archer', 'mage', 'buffer', 'spoiler', 'crafter'],
        preferredTags: ['dragon', 'undead', 'beast'],
        reason: 'c_grade_transition'
    },
    {
        id: 'cleric_undead_40_74',
        name: 'cleric undead route',
        minLevel: 40,
        maxLevel: 74,
        modes: ['solo', 'duo', 'party'],
        roles: ['healer'],
        requiredTags: ['undead'],
        preferredTags: ['cemetery', 'forest_dead', 'devils_isle'],
        reason: 'cleric_might_of_heaven'
    },
    {
        id: 'normal_hp_mage_52_70',
        name: 'normal HP mage fields',
        minLevel: 52,
        maxLevel: 70,
        modes: ['solo', 'duo'],
        roles: ['mage'],
        preferredTags: ['normal_hp', 'forest_dead', 'blazing_swamp', 'valley_saints'],
        avoidTags: ['catacomb', 'high_hp'],
        reason: 'mage_low_downtime'
    },
    {
        id: 'fighter_cata_60_75',
        name: 'catacomb fighter farm',
        minLevel: 58,
        maxLevel: 75,
        modes: ['duo', 'party'],
        roles: ['dps', 'tank', 'dagger', 'archer', 'spoiler'],
        requiredTags: ['catacomb'],
        preferredRoles: ['buffer', 'healer'],
        reason: 'fighter_party_catacomb'
    },
    {
        id: 'mage_party_65_78',
        name: 'mage party route',
        minLevel: 65,
        maxLevel: 78,
        modes: ['party'],
        roles: ['mage', 'buffer', 'healer'],
        preferredTags: ['tower', 'wall_argos', 'varka', 'ketra', 'forest_dead'],
        avoidTags: ['high_magic_resist'],
        reason: 'mage_party_damage'
    },
    {
        id: 'tank_deep_party_60_78',
        name: 'deep dungeon tank route',
        minLevel: 60,
        maxLevel: 78,
        modes: ['party'],
        roles: ['tank'],
        preferredTags: ['dvc', 'forbidden_gateway', 'imperial_tomb', 'lair'],
        reason: 'tank_needed_deep'
    },
    {
        id: 'varka_ketra_70_85',
        name: 'Varka/Ketra high level route',
        minLevel: 70,
        maxLevel: 85,
        modes: ['solo', 'duo', 'party'],
        roles: ['dps', 'tank', 'dagger', 'archer', 'mage', 'healer', 'buffer', 'spoiler', 'crafter'],
        preferredTags: ['varka', 'ketra'],
        reason: 'high_level_c4_route'
    }
];

const TAG_PATTERNS = [
    ['undead', /\b(zombie|skeleton|ghoul|ghost|corpse|bone|undead|doom|shade|specter|spirit)\b/],
    ['ruins', /\b(ruin|agony|despair)\b/],
    ['lizardman', /\b(lizard|leto|langk|delu)\b/],
    ['insect', /\b(ant|spider|scarab|stakato|bug|wasp)\b/],
    ['construct', /\b(porta|excuro|catherok|mordeo|krator|golem|construct|guardian)\b/],
    ['dragon', /\b(drake|wyrm|dragon|malruk)\b/],
    ['beast', /\b(beast|buffalo|kookaburra|cougar|antelope|wolf|bear)\b/],
    ['catacomb', /\b(nephilim|lilim|seal|branded|apostate|witch|forbidden path|catacomb|necropolis)\b/],
    ['forest_dead', /\b(forest of the dead|bone|skull|vampire|undead)\b/],
    ['blazing_swamp', /\b(blazing|lava|ash|swamp)\b/],
    ['valley_saints', /\b(saint|shine|pilgrim|judge)\b/],
    ['tower', /\b(tower|angel|platinum|toi)\b/],
    ['wall_argos', /\b(argos|tomb guardian|guardian of the grave)\b/],
    ['varka', /\b(varka|silenos)\b/],
    ['ketra', /\b(ketra|orc outpost)\b/],
    ['dvc', /\b(dvc|antharas|karik|cave servant|malruk)\b/],
    ['lair', /\b(lair|antharas|karik)\b/],
    ['imperial_tomb', /\b(imperial|tomb|scarab)\b/],
    ['forbidden_gateway', /\b(forbidden gateway|grave|doom knight)\b/],
    ['material', /\b(lizard|lizardman|porta|excuro|catherok|mordeo|krator|gargoyle|bone|ore)\b/],
    ['starter', /\b(keltir|gremlin|wolf|orc|goblin|imp)\b/],
    ['normal_hp', /\b(alligator|silenos|orc|beast|buffalo|antelope|shine|bone|vampire)\b/]
];

function uniq(values) {
    return [...new Set(values.filter(Boolean))];
}

function classIdOf(state = {}) {
    return Number(state.classId || state.stats?.classId || state.template?.classId || 0) || null;
}

function roleForState(state = {}) {
    const classId = classIdOf(state);
    if (classId && ECONOMIC_ROLES[classId]) return ECONOMIC_ROLES[classId];
    if (state.party?.role) return state.party.role;
    if (state.stats?.routeRole) return state.stats.routeRole;
    if (state.stats?.role) return state.stats.role;
    if (classId) return BotRoles.inferRole(classId);
    return 'dps';
}

function modeForState(state = {}, options = {}) {
    if (options.mode) return options.mode;
    if (state.party?.partyId) return 'party';
    if (state.stats?.routeMode) return state.stats.routeMode;
    if (state.activity === 'grouped') return 'party';
    return 'solo';
}

function targetLevelForState(state = {}) {
    if (Number(state.level || 0) > 0) return Number(state.level);

    const parts = String(state.levelBand || '').split('-').map((part) => Number(part));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        return Math.round((parts[0] + parts[1]) / 2);
    }

    return Number(parts[0]) || 1;
}

function textForSpot(spot = {}) {
    return [
        spot.id,
        spot.name,
        ...(spot.npcNames || [])
    ].join(' ').toLowerCase();
}

function tagsForSpot(spot = {}) {
    const text = textForSpot(spot);
    const tags = TAG_PATTERNS
        .filter(([, pattern]) => pattern.test(text))
        .map(([tag]) => tag);

    if (Number(spot.minLevel || 0) <= 18) tags.push('starter');
    if (Number(spot.maxLevel || 0) - Number(spot.minLevel || 0) <= 5) tags.push('normal_hp');

    return uniq(tags);
}

function hasAll(tags, required = []) {
    return required.every((tag) => tags.includes(tag));
}

function overlapCount(tags, wanted = []) {
    return wanted.filter((tag) => tags.includes(tag)).length;
}

function routeApplies(route, context, tags) {
    const { level, mode, role } = context;
    if (level < route.minLevel - 3 || level > route.maxLevel + 3) return false;
    if (route.modes && !route.modes.includes(mode)) return false;
    if (route.roles && !route.roles.includes(role)) return false;
    if (route.requiredTags && !hasAll(tags, route.requiredTags)) return false;
    if (route.avoidTags && overlapCount(tags, route.avoidTags) > 0) return false;
    return true;
}

function scoreRoute(route, spot, context, tags) {
    const levelGap = Math.abs(Number(spot.avgLevel || spot.minLevel || 1) - context.level);
    const routeMid = (route.minLevel + route.maxLevel) / 2;
    const routeGap = Math.abs(routeMid - context.level);
    const preferredTagCount = overlapCount(tags, route.preferredTags || []);
    const modeBonus = route.modes?.includes(context.mode) ? 16 : 0;
    const roleBonus = route.roles?.includes(context.role) ? 28 : 0;
    const requiredTagBonus = Number(route.requiredTags?.length || 0) * 30;
    const narrowRoleBonus = route.roles && route.roles.length <= 3 ? 18 : 0;

    return 70 + modeBonus + roleBonus + requiredTagBonus + narrowRoleBonus + preferredTagCount * 22 - levelGap * 12 - routeGap * 1.5;
}

function baseScore(spot, context) {
    const levelGap = Math.abs(Number(spot.avgLevel || spot.minLevel || 1) - context.level);
    const density = Number(spot.density || 1);
    const peacePenalty = utils.isInPeaceZone?.(spot.center?.locX, spot.center?.locY) ? 40 : 0;
    return density * 3 - levelGap * 18 - peacePenalty;
}

function scoreSpot(spot, state = {}, options = {}) {
    const tags = tagsForSpot(spot);
    const context = {
        level: Number(options.level || targetLevelForState(state)),
        role: options.role || roleForState(state),
        mode: modeForState(state, options)
    };
    const matchingRoutes = ROUTES
        .filter((route) => routeApplies(route, context, tags))
        .map((route) => ({
            route,
            score: scoreRoute(route, spot, context, tags)
        }))
        .sort((a, b) => b.score - a.score);

    const routeMatch = matchingRoutes[0] || null;
    const score = baseScore(spot, context) + (routeMatch ? routeMatch.score : 0);

    return {
        score,
        route: routeMatch?.route || null,
        routeScore: routeMatch?.score || 0,
        tags,
        role: context.role,
        mode: context.mode,
        level: context.level,
        levelGap: Math.abs(Number(spot.avgLevel || spot.minLevel || 1) - context.level)
    };
}

function routeSummary(match) {
    if (!match?.route) return null;
    return {
        id: match.route.id,
        name: match.route.name,
        reason: match.route.reason,
        role: match.role,
        mode: match.mode,
        tags: match.tags,
        source: 'c4_leveling_guides'
    };
}

function decorateSpot(spot, match) {
    if (!spot || !match?.route) return spot;
    return {
        ...spot,
        route: routeSummary(match)
    };
}

function rankedSpots(spots, state = {}, options = {}) {
    return (spots || [])
        .map((spot) => {
            const match = scoreSpot(spot, state, options);
            return {
                spot: decorateSpot(spot, match),
                score: match.score,
                routeScore: match.routeScore,
                route: routeSummary(match),
                tags: match.tags,
                levelGap: match.levelGap
            };
        })
        .sort((a, b) => b.score - a.score);
}

function bestSpot(spots, state = {}, options = {}) {
    return rankedSpots(spots, state, options)[0] || null;
}

module.exports = {
    ROUTES,
    ECONOMIC_ROLES,
    roleForState,
    modeForState,
    targetLevelForState,
    tagsForSpot,
    scoreSpot,
    rankedSpots,
    bestSpot,
    decorateSpot
};
