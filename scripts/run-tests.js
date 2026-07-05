const { spawnSync } = require('child_process');

const tests = [
    'tests/test_admin_tools.js',
    'tests/test_attack_hit_flags.js',
    'tests/test_armor_stats.js',
    'tests/test_bot_ai_visibility.js',
    'tests/test_bot_chat_text.js',
    'tests/test_bot_gear.js',
    'tests/test_bot_gear_skill_hints.js',
    'tests/test_bot_hunting_self_defense.js',
    'tests/test_bot_leveling_routes.js',
    'tests/test_c4_buff_modifiers.js',
    'tests/test_c4_protocol_packets.js',
    'tests/test_cast_interrupt.js',
    'tests/test_change_class.js',
    'tests/test_effect_restrictions.js',
    'tests/test_effect_ticker.js',
    'tests/test_geodata_regions.js',
    'tests/test_item_skill_use.js',
    'tests/test_npc_combat_range.js',
    'tests/test_npc_social_aggro.js',
    'tests/test_party_companion_rest_follow.js',
    'tests/test_path_obstacle.js',
    'tests/test_pathfinder_astar.js',
    'tests/test_progression_rates.js',
    'tests/test_private_tell_routing.js',
    'tests/test_shot_consumption.js',
    'tests/test_skill_area_semantics.js',
    'tests/test_skill_area_runtime.js',
    'tests/test_skill_semantics.js',
    'tests/test_skill_damage_formulas.js',
    'tests/test_town_pathfinder.js',
    'tests/test_ui_test_window.js'
];

for (const testFile of tests) {
    console.log(`\n> node ${testFile}`);
    const result = spawnSync(process.execPath, [testFile], {
        cwd: process.cwd(),
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}
