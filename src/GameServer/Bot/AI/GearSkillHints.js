const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');

const GRADE_BANDS = [
    { rank: 'none', min: 1, max: 19 },
    { rank: 'd', min: 20, max: 39 },
    { rank: 'c', min: 40, max: 51 },
    { rank: 'b', min: 52, max: 60 },
    { rank: 'a', min: 61, max: 75 },
    { rank: 's', min: 76, max: 99 }
];

const HINTS = {
    archer: {
        armor: 'light',
        weapon: 'bow',
        statPriority: ['pAtk', 'crit', 'range', 'shot_efficiency'],
        specialAbilities: {
            c: ['cheap_shot'],
            b: ['cheap_shot'],
            a: ['cheap_shot'],
            s: ['focus']
        },
        skills: [
            { minLevel: 5, name: 'Power Shot', intent: 'primary_damage' },
            { minLevel: 20, name: 'Stun Shot', intent: 'control_when_available' }
        ],
        consumables: ['arrows', 'soulshots'],
        partyNeed: 'buffer_or_recharger_for_downtime'
    },
    dagger: {
        armor: 'light',
        weapon: 'dagger',
        statPriority: ['pAtk', 'crit', 'evasion', 'backstab_windows'],
        specialAbilities: {
            c: ['focus', 'critical_damage'],
            b: ['focus', 'critical_damage'],
            a: ['focus', 'critical_damage'],
            s: ['critical_damage']
        },
        skills: [
            { minLevel: 5, name: 'Mortal Blow', intent: 'burst_damage' },
            { minLevel: 40, name: 'Backstab', intent: 'flank_damage' }
        ],
        consumables: ['soulshots'],
        partyNeed: 'tank_or_leader_positioning'
    },
    mage: {
        armor: 'robe',
        weapon: 'caster_blunt_or_sword',
        statPriority: ['mAtk', 'cast_speed', 'maxMp', 'spiritshot_efficiency'],
        specialAbilities: {
            c: ['empower', 'acumen'],
            b: ['acumen'],
            a: ['magic_power', 'acumen'],
            s: ['empower', 'acumen']
        },
        skills: [
            { minLevel: 7, name: 'main nuke', intent: 'two_or_three_shot_mobs' },
            { minLevel: 20, name: 'Sleep/slow/control', intent: 'avoid_extra_hits' }
        ],
        consumables: ['spiritshots'],
        partyNeed: 'recharger_or_buffer'
    },
    healer: {
        armor: 'robe',
        weapon: 'caster_blunt_or_sword',
        statPriority: ['maxMp', 'cast_speed', 'mAtk', 'mp_conservation'],
        specialAbilities: {
            c: ['acumen', 'conversion'],
            b: ['acumen'],
            a: ['acumen'],
            s: ['acumen']
        },
        skills: [
            { minLevel: 7, name: 'Heal', intent: 'efficient_healing' },
            { minLevel: 20, name: 'Battle Heal', intent: 'emergency_healing' },
            { minLevel: 40, name: 'Might of Heaven', intent: 'undead_solo_route' }
        ],
        consumables: ['spiritshots_for_emergency_heals'],
        partyNeed: 'frontline_to_protect_mp'
    },
    buffer: {
        armor: 'robe',
        weapon: 'caster_blunt_or_sword',
        statPriority: ['maxMp', 'cast_speed', 'buff_uptime', 'mp_conservation'],
        specialAbilities: {
            c: ['acumen', 'conversion'],
            b: ['acumen'],
            a: ['acumen'],
            s: ['acumen']
        },
        skills: [
            { minLevel: 7, name: 'Heal', intent: 'backup_heal_only' },
            { minLevel: 20, name: 'Might/Shield/Wind Walk', intent: 'core_support' },
            { minLevel: 40, name: 'Haste/Acumen/Focus package', intent: 'party_throughput' }
        ],
        consumables: ['spiritshots_for_backup_heals'],
        partyNeed: 'fighter_party'
    },
    tank: {
        armor: 'heavy',
        weapon: 'one_handed_sword_or_blunt',
        statPriority: ['pDef', 'shield_defense', 'hp', 'aggro_control'],
        specialAbilities: {
            c: ['health'],
            b: ['health', 'haste'],
            a: ['health'],
            s: ['health']
        },
        skills: [
            { minLevel: 20, name: 'Aggression', intent: 'protect_party' },
            { minLevel: 20, name: 'Shield Stun', intent: 'control_dangerous_mobs' }
        ],
        consumables: ['soulshots'],
        partyNeed: 'healer_and_damage_dealers'
    },
    spoiler: {
        armor: 'heavy',
        weapon: 'one_handed_blunt',
        statPriority: ['pAtk', 'pDef', 'spoil_value', 'carry_weight'],
        specialAbilities: {
            c: ['haste', 'health'],
            b: ['haste', 'health'],
            a: ['haste', 'health'],
            s: ['health']
        },
        skills: [
            { minLevel: 10, name: 'Spoil', intent: 'mark_mobs_before_kill' },
            { minLevel: 10, name: 'Sweeper', intent: 'collect_spoils_after_death' },
            { minLevel: 40, name: 'Hammer Crush', intent: 'stun_utility' }
        ],
        consumables: ['soulshots'],
        partyNeed: 'fast_kill_party_for_spoil_volume'
    },
    crafter: {
        armor: 'heavy',
        weapon: 'one_handed_blunt',
        statPriority: ['pAtk', 'pDef', 'craft_materials', 'carry_weight'],
        specialAbilities: {
            c: ['haste', 'health'],
            b: ['haste', 'health'],
            a: ['health'],
            s: ['health']
        },
        skills: [
            { minLevel: 5, name: 'Create Item', intent: 'crafting_identity' },
            { minLevel: 40, name: 'Summon Mechanic Golem', intent: 'utility_when_available' }
        ],
        consumables: ['soulshots'],
        partyNeed: 'material_supply'
    },
    dps: {
        armor: 'heavy',
        weapon: 'one_handed_sword_or_blunt',
        statPriority: ['pAtk', 'pDef', 'shot_efficiency'],
        specialAbilities: {
            c: ['focus', 'haste'],
            b: ['focus', 'haste'],
            a: ['focus', 'haste'],
            s: ['focus']
        },
        skills: [
            { minLevel: 5, name: 'Power Strike', intent: 'starter_damage' },
            { minLevel: 20, name: 'Stun/War Cry when available', intent: 'fighter_utility' }
        ],
        consumables: ['soulshots'],
        partyNeed: 'buffer_for_sustained_grind'
    }
};

const ROLE_TIERS = {
    archer: [
        { min: 1, max: 19, label: 'starter_bow', exampleGear: ['starter bow', 'no-grade light armor'], skillPriorities: ['Power Shot when MP allows', 'kite weak mobs'], playstyle: 'kite_solo', warnings: ['carry arrows before leaving town'] },
        { min: 20, max: 39, label: 'd_grade_bow', exampleGear: ['best affordable D bow', 'light armor', 'basic jewels'], skillPriorities: ['Power Shot opener', 'Stun Shot control'], playstyle: 'single_target_kiting', warnings: ['shots and arrows decide downtime'] },
        { min: 40, max: 51, label: 'c_grade_cheap_shot', exampleGear: ['Eminence Bow + Cheap Shot', 'Plated Leather or Composite fallback'], skillPriorities: ['Power Shot', 'Stun Shot', 'avoid melee trades'], playstyle: 'low_downtime_ranged_farm', warnings: ['without Cheap Shot this class burns adena fast'] },
        { min: 52, max: 60, label: 'b_grade_bow', exampleGear: ['Bow of Peril + Cheap Shot', 'Doom Light or Blue Wolf Light'], skillPriorities: ['range control', 'stun dangerous mobs'], playstyle: 'party_or_buffed_solo', warnings: ['needs buffs for sustained farming'] },
        { min: 61, max: 75, label: 'a_grade_bow', exampleGear: ['Soul Bow + Cheap Shot', 'Majestic Light'], skillPriorities: ['assist party target', 'hold distance'], playstyle: 'ranged_party_damage', warnings: ['avoid overpulling social mobs'] },
        { min: 76, max: 99, label: 's_grade_bow', exampleGear: ['Draconic Bow + Focus', 'Majestic or Draconic Light'], skillPriorities: ['focus fire', 'stay behind frontline'], playstyle: 'high_level_ranged_party', warnings: ['solo remains expensive without support'] }
    ],
    dagger: [
        { min: 1, max: 19, label: 'starter_dagger', exampleGear: ['starter dagger', 'no-grade light armor'], skillPriorities: ['Mortal Blow on tough mobs'], playstyle: 'short_solo_fights', warnings: ['avoid long trades with higher-level mobs'] },
        { min: 20, max: 39, label: 'd_grade_dagger', exampleGear: ['best affordable D dagger', 'light armor'], skillPriorities: ['Mortal Blow', 'move behind party target'], playstyle: 'flank_assist', warnings: ['bad solo sustain without buffs'] },
        { min: 40, max: 51, label: 'c_grade_focus_dagger', exampleGear: ['Dark Screamer + Focus', 'Plated Leather'], skillPriorities: ['Backstab/Mortal Blow', 'assist tank target'], playstyle: 'crit_burst_pve', warnings: ['needs positioning more than raw pDef'] },
        { min: 52, max: 60, label: 'b_grade_focus_dagger', exampleGear: ['Kris + Focus', 'Doom Light'], skillPriorities: ['burst from flank', 'do not pull first'], playstyle: 'party_burst_damage', warnings: ['fragile when tank loses aggro'] },
        { min: 61, max: 75, label: 'a_grade_dagger', exampleGear: ['Bloody Orchid + Focus', 'Nightmare Light or Dark Crystal Light'], skillPriorities: ['flank priority targets', 'save blows for openings'], playstyle: 'mobile_melee_damage', warnings: ['avoid stun-heavy mobs without support'] },
        { min: 76, max: 99, label: 's_grade_dagger', exampleGear: ['Angel Slayer + Critical Damage', 'Draconic or Dark Crystal Light'], skillPriorities: ['burst priority targets'], playstyle: 'high_level_flank_damage', warnings: ['poor unattended farming class'] }
    ],
    mage: [
        { min: 1, max: 19, label: 'starter_nuker', exampleGear: ['starter caster weapon', 'no-grade robe'], skillPriorities: ['main nuke', 'rest before empty MP'], playstyle: 'short_nuke_cycles', warnings: ['MP is the limiting resource'] },
        { min: 20, max: 39, label: 'd_grade_nuker', exampleGear: ['best affordable D caster weapon', 'robe set', 'basic jewels'], skillPriorities: ['main nuke', 'control if resisted'], playstyle: 'normal_hp_mob_farming', warnings: ['avoid high-HP mobs solo'] },
        { min: 40, max: 51, label: 'c_grade_damage_cast', exampleGear: ['Sword of Whispering Death + Empower', 'Demon Set', 'Homunkulus + Acumen as safe cast-speed option'], skillPriorities: ['two-shot normal HP mobs', 'Sleep/slow/control on adds'], playstyle: 'damage_over_cast_speed_pve', warnings: ['Demon Set is fragile; bad if taking hits'] },
        { min: 52, max: 60, label: 'b_grade_acumen', exampleGear: ['Sword of Valhalla + Acumen', 'Doom Robe or Avadon Robe'], skillPriorities: ['nuke efficiency', 'control adds'], playstyle: 'buffed_solo_or_small_party', warnings: ['needs recharger for long sessions'] },
        { min: 61, max: 75, label: 'a_grade_magic_power', exampleGear: ['Elemental Sword + Magic Power', 'Nightmare Robe', 'Sword of Miracles + Acumen for safer cast speed'], skillPriorities: ['burst normal HP mobs', 'avoid magic resistant targets'], playstyle: 'high_damage_field_farm', warnings: ['party route is usually better than high-HP solo'] },
        { min: 76, max: 99, label: 's_grade_nuker', exampleGear: ['Arcana Mace + Acumen or Imperial Staff + Empower', 'Dark Crystal Robe'], skillPriorities: ['high-level nuke rotation', 'party focus fire'], playstyle: 'mage_party_damage', warnings: ['solo farming stays support-dependent'] }
    ],
    healer: [
        { min: 1, max: 19, label: 'starter_healer', exampleGear: ['starter caster weapon', 'robe'], skillPriorities: ['Heal efficiently', 'use spiritshots only under pressure'], playstyle: 'support_or_undead_solo', warnings: ['low damage outside undead route'] },
        { min: 20, max: 39, label: 'd_grade_healer', exampleGear: ['D caster weapon', 'robe', 'MP jewels'], skillPriorities: ['Heal', 'Battle Heal emergency only'], playstyle: 'party_support', warnings: ['do not overheal; MP is party tempo'] },
        { min: 40, max: 51, label: 'c_grade_undead_healer', exampleGear: ['Homunkulus + Acumen or Conversion', 'Karmian/Divine robe'], skillPriorities: ['Might of Heaven on undead', 'efficient Heal', 'emergency Battle Heal'], playstyle: 'undead_solo_or_party_heal', warnings: ['spiritshot emergency heals, not every heal'] },
        { min: 52, max: 60, label: 'b_grade_party_healer', exampleGear: ['Sword of Valhalla + Acumen', 'Blue Wolf/Avadon robe'], skillPriorities: ['keep tank alive', 'conserve MP between pulls'], playstyle: 'main_party_support', warnings: ['bad groups drain MP fast'] },
        { min: 61, max: 75, label: 'a_grade_party_healer', exampleGear: ['Sword of Miracles + Acumen', 'Dark Crystal or Tallum robe'], skillPriorities: ['pre-heal dangerous pulls', 'clean emergency targets'], playstyle: 'deep_party_support', warnings: ['position behind frontline'] },
        { min: 76, max: 99, label: 's_grade_party_healer', exampleGear: ['Arcana Mace + Acumen', 'Dark Crystal/Major Arcana robe'], skillPriorities: ['high-level heals', 'party survival cooldowns'], playstyle: 'endgame_support', warnings: ['never pull aggro with panic heals'] }
    ],
    buffer: [
        { min: 1, max: 19, label: 'starter_buffer', exampleGear: ['starter caster weapon', 'robe'], skillPriorities: ['Heal as backup', 'starter buffs'], playstyle: 'support_learner', warnings: ['solo is slow'] },
        { min: 20, max: 39, label: 'd_grade_buffer', exampleGear: ['D caster weapon', 'robe'], skillPriorities: ['Might/Shield/Wind Walk', 'backup Heal'], playstyle: 'small_party_support', warnings: ['buff only useful targets when MP is low'] },
        { min: 40, max: 51, label: 'c_grade_buffer', exampleGear: ['Homunkulus + Acumen or Conversion', 'Karmian/Divine robe'], skillPriorities: ['full core buff package', 'spiritshot backup heals'], playstyle: 'fighter_party_enabler', warnings: ['Prophet-style bots should not pretend to be main healers'] },
        { min: 52, max: 60, label: 'b_grade_buffer', exampleGear: ['Sword of Valhalla + Acumen', 'Blue Wolf robe for support stats'], skillPriorities: ['rebuff before pulls', 'conserve MP'], playstyle: 'sustained_party_support', warnings: ['late parties expect buff uptime'] },
        { min: 61, max: 75, label: 'a_grade_buffer', exampleGear: ['Sword of Miracles + Acumen', 'Dark Crystal/Tallum robe'], skillPriorities: ['rebuff windows', 'backup heal only'], playstyle: 'high_level_party_support', warnings: ['standing idle after buffs feels fake'] },
        { min: 76, max: 99, label: 's_grade_buffer', exampleGear: ['Arcana Mace + Acumen', 'support robe set'], skillPriorities: ['full buff cycle', 'party sustain'], playstyle: 'endgame_support_rhythm', warnings: ['prioritize party over random buff beggars'] }
    ],
    tank: [
        { min: 1, max: 19, label: 'starter_tank', exampleGear: ['starter sword/blunt', 'no-grade heavy or light fallback'], skillPriorities: ['Power Strike', 'shield use'], playstyle: 'safe_solo', warnings: ['damage is slower than DPS'] },
        { min: 20, max: 39, label: 'd_grade_tank', exampleGear: ['D one-handed weapon', 'shield', 'heavy armor'], skillPriorities: ['Aggression', 'Shield Stun'], playstyle: 'small_party_frontline', warnings: ['do not overpull without healer'] },
        { min: 40, max: 51, label: 'c_grade_tank', exampleGear: ['one-handed sword/blunt + Health', 'Full Plate/Composite heavy', 'shield'], skillPriorities: ['hold aggro', 'stun dangerous mobs'], playstyle: 'party_frontline', warnings: ['solo is reliable but slow'] },
        { min: 52, max: 60, label: 'b_grade_tank', exampleGear: ['health weapon', 'Doom/Blue Wolf heavy', 'shield'], skillPriorities: ['protect healer', 'lead pulls'], playstyle: 'dungeon_party_frontline', warnings: ['needs damage dealers to be efficient'] },
        { min: 61, max: 75, label: 'a_grade_tank', exampleGear: ['Health weapon', 'Tallum/Nightmare/Majestic heavy'], skillPriorities: ['controlled pulls', 'protect low HP party members'], playstyle: 'deep_dungeon_tank', warnings: ['bad route choice gets party killed'] },
        { min: 76, max: 99, label: 's_grade_tank', exampleGear: ['Health weapon', 'Imperial Crusader heavy'], skillPriorities: ['endgame aggro control', 'positioning'], playstyle: 'endgame_frontline', warnings: ['never chase while healer is behind'] }
    ],
    spoiler: [
        { min: 1, max: 19, label: 'starter_spoil', exampleGear: ['starter blunt', 'no-grade heavy/light'], skillPriorities: ['learn Spoil and Sweeper at 10', 'spoil before kill'], playstyle: 'material_starter', warnings: ['save SP for Spoil/Sweeper'] },
        { min: 20, max: 39, label: 'd_grade_spoil', exampleGear: ['Tarbar-style D blunt', 'D heavy armor'], skillPriorities: ['Spoil every valuable mob', 'Sweep quickly'], playstyle: 'adena_material_route', warnings: ['XP-only spots are a waste for spoilers'] },
        { min: 40, max: 51, label: 'c_grade_spoil', exampleGear: ['Yaksa/Aoba-style blunt with Haste or Health', 'Full Plate or heavy set'], skillPriorities: ['Spoil/Sweeper loop', 'Hammer Crush utility'], playstyle: 'branded_cruma_material_farm', warnings: ['party kill speed matters more than personal DPS'] },
        { min: 52, max: 60, label: 'b_grade_spoil', exampleGear: ['Art of Battle Axe + Haste/Health', 'Doom Plate', 'BO jewels'], skillPriorities: ['high-value material targets', 'stun if party threatened'], playstyle: 'party_spoil_volume', warnings: ['carry capacity and return-to-town matter'] },
        { min: 61, max: 75, label: 'a_grade_spoil', exampleGear: ['A-grade blunt with Health/Haste', 'heavy armor', 'A/B jewels'], skillPriorities: ['SOP/recipe/material routes', 'avoid low-value XP grind'], playstyle: 'market_driven_farming', warnings: ['route should follow material demand'] },
        { min: 76, max: 99, label: 's_grade_spoil', exampleGear: ['S-grade blunt', 'heavy armor'], skillPriorities: ['high-grade spoil targets', 'party utility stuns'], playstyle: 'endgame_material_party', warnings: ['not every raid/party is worth spoiling'] }
    ],
    crafter: [
        { min: 1, max: 19, label: 'starter_crafter', exampleGear: ['starter blunt', 'no-grade armor'], skillPriorities: ['Create Item identity', 'basic combat'], playstyle: 'starter_material_gathering', warnings: ['craft role is economic, not pure combat'] },
        { min: 20, max: 39, label: 'd_grade_crafter', exampleGear: ['D blunt', 'D heavy armor'], skillPriorities: ['Create Item', 'material awareness'], playstyle: 'combat_with_crafting_goal', warnings: ['needs material supply'] },
        { min: 40, max: 51, label: 'c_grade_crafter', exampleGear: ['C blunt with Haste/Health', 'heavy armor'], skillPriorities: ['craft identity', 'party utility'], playstyle: 'economic_support_dps', warnings: ['do not evaluate only XP/hour'] },
        { min: 52, max: 60, label: 'b_grade_crafter', exampleGear: ['B blunt', 'Doom/Blue Wolf heavy'], skillPriorities: ['material routing', 'summon utility when available'], playstyle: 'craft_market_support', warnings: ['merchant/craft behavior should influence goals'] },
        { min: 61, max: 75, label: 'a_grade_crafter', exampleGear: ['A blunt', 'heavy armor'], skillPriorities: ['craft supply chain', 'party utility'], playstyle: 'market_driven_character', warnings: ['needs economy loop to feel real'] },
        { min: 76, max: 99, label: 's_grade_crafter', exampleGear: ['S blunt', 'heavy armor'], skillPriorities: ['endgame crafting identity'], playstyle: 'endgame_economic_role', warnings: ['combat alone undersells the class'] }
    ],
    dps: [
        { min: 1, max: 19, label: 'starter_fighter', exampleGear: ['starter sword/blunt', 'no-grade armor'], skillPriorities: ['Power Strike', 'rest only when needed'], playstyle: 'simple_solo', warnings: ['avoid red mobs'] },
        { min: 20, max: 39, label: 'd_grade_fighter', exampleGear: ['D weapon', 'D heavy/light by mastery'], skillPriorities: ['main damage skill', 'stun if available'], playstyle: 'solo_or_duo_grind', warnings: ['buffs change good spots'] },
        { min: 40, max: 51, label: 'c_grade_fighter', exampleGear: ['C weapon with Focus/Haste', 'Plated Leather for DD or heavy for bruiser'], skillPriorities: ['efficient single-target damage', 'avoid downtime'], playstyle: 'c_grade_progression', warnings: ['gear quality strongly affects route choice'] },
        { min: 52, max: 60, label: 'b_grade_fighter', exampleGear: ['B weapon with Focus/Haste', 'Doom/Blue Wolf set by role'], skillPriorities: ['assist party target', 'use shots'], playstyle: 'buffed_solo_or_party', warnings: ['unbuffed farming slows hard'] },
        { min: 61, max: 75, label: 'a_grade_fighter', exampleGear: ['A weapon with Focus/Haste/Health', 'A armor set by role'], skillPriorities: ['party assist', 'manage aggro'], playstyle: 'high_level_party_or_buffed_solo', warnings: ['do not fight like starter zone anymore'] },
        { min: 76, max: 99, label: 's_grade_fighter', exampleGear: ['S weapon with role SA', 'S/A armor set'], skillPriorities: ['endgame role rotation'], playstyle: 'endgame_party_damage', warnings: ['support composition matters'] }
    ]
};

function familyHint(classId, role) {
    const id = Number(classId || 0);

    if (role === 'mage') {
        if ([13, 27, 40].includes(id)) {
            return {
                family: 'necromancer',
                skillPriorities: ['Death Spike when bones are stocked', 'Curse/anchor control', 'manage summon cost when used'],
                warnings: ['consumable bones can become the real limiter']
            };
        }
        return {
            family: 'elemental_nuker',
            skillPriorities: ['main elemental nuke', 'control resisted or social pulls'],
            warnings: ['avoid mobs with bad resist profile']
        };
    }

    if (role === 'healer') {
        if ([15, 16].includes(id)) {
            return {
                family: 'bishop',
                skillPriorities: ['main heal first', 'Battle Heal only under pressure', 'resurrection duty'],
                warnings: ['best in real parties, weak as unattended solo']
            };
        }
        return {
            family: 'elder_recharger',
            skillPriorities: ['heal efficiently', 'recharge/support when available', 'undead route if solo'],
            warnings: ['party value is higher than solo damage']
        };
    }

    if (role === 'buffer') {
        if (id === 17) {
            return {
                family: 'prophet',
                skillPriorities: ['correct buffs for party role', 'backup heal with spiritshots', 'avoid main-healer behavior'],
                warnings: ['Prophet is a buffer first, not a Bishop']
            };
        }
        if ([49, 50, 51].includes(id)) {
            return {
                family: 'orc_buffer',
                skillPriorities: ['fighter-party buff rhythm', 'drain/sustain if solo', 'rebuff before pulls'],
                warnings: ['strong in fighter parties, less suited to mage parties']
            };
        }
    }

    if (role === 'spoiler') {
        return {
            family: 'bounty_hunter',
            skillPriorities: ['spoil before damage rotation finishes', 'sweep immediately after death', 'prefer material route over raw XP'],
            warnings: ['if the mob is not worth spoiling, the spot may be wrong']
        };
    }

    if (role === 'crafter') {
        return {
            family: 'warsmith',
            skillPriorities: ['track materials', 'craft identity', 'summon utility when useful'],
            warnings: ['needs economy behavior to feel like a real player']
        };
    }

    return null;
}

function gradeForLevel(level) {
    const value = Number(level || 1);
    return GRADE_BANDS.find((band) => value >= band.min && value <= band.max) || GRADE_BANDS[0];
}

function actorValue(value, key, fallback = null) {
    const fetcher = `fetch${key[0].toUpperCase()}${key.slice(1)}`;
    if (value && typeof value[fetcher] === 'function') return value[fetcher]();
    return value?.[key] ?? fallback;
}

function characterState(character = {}) {
    const classId = Number(actorValue(character, 'classId', character.stats?.classId || 0)) || null;
    const level = Number(actorValue(character, 'level', character.level || 1)) || 1;
    const role = LevelingRoutes.ECONOMIC_ROLES[classId] || BotRoles.inferRole(classId);
    return { classId, level, role };
}

function activeSkills(skills, level) {
    return skills
        .filter((skill) => Number(level || 1) >= Number(skill.minLevel || 1))
        .map((skill) => ({
            name: skill.name,
            intent: skill.intent,
            minLevel: skill.minLevel
        }));
}

function tierForRole(role, level) {
    const tiers = ROLE_TIERS[role] || ROLE_TIERS.dps;
    const value = Number(level || 1);
    return tiers.find((tier) => value >= tier.min && value <= tier.max) || tiers[tiers.length - 1];
}

function uniqueStrings(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function forCharacter(character = {}, options = {}) {
    const state = characterState(character);
    const role = options.role || state.role || 'dps';
    const base = HINTS[role] || HINTS.dps;
    const grade = gradeForLevel(state.level);
    const tier = tierForRole(role, state.level);
    const family = familyHint(state.classId, role);
    const specialAbilities = base.specialAbilities[grade.rank] || [];
    const skillHints = [
        ...activeSkills(base.skills, state.level),
        ...(tier.skillPriorities || []).map((name) => ({
            name,
            intent: 'tier_priority',
            minLevel: tier.min
        })),
        ...(family?.skillPriorities || []).map((name) => ({
            name,
            intent: 'class_family_priority',
            minLevel: tier.min
        }))
    ];

    return {
        role,
        classId: state.classId,
        level: state.level,
        grade: grade.rank,
        tier: tier.label,
        classFamily: family?.family || null,
        armor: base.armor,
        weapon: base.weapon,
        statPriority: [...base.statPriority],
        specialAbilities: [...specialAbilities],
        skills: skillHints,
        exampleGear: [...(tier.exampleGear || [])],
        consumables: [...base.consumables],
        partyNeed: base.partyNeed,
        playstyle: tier.playstyle || null,
        warnings: uniqueStrings([...(tier.warnings || []), ...(family?.warnings || [])]),
        source: 'c4_guide_hints'
    };
}

module.exports = {
    HINTS,
    gradeForLevel,
    forCharacter
};
