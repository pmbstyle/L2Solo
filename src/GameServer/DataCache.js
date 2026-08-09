const validateSchema = require('jsonschema').validate;
const ClassProgression = invoke('GameServer/ClassProgression');

const DataCache = {
    init: () => {
        const path = '../data/';

        DataCache.classTemplates  = validateModel(path + 'Templates/templates');
        ClassProgression.expandTemplates(DataCache.classTemplates);
        DataCache.newbieItems     = validateModel(path + 'Templates/Items/items');
        DataCache.newbieShortcuts = validateModel(path + 'Templates/Shortcuts/shortcuts');
        DataCache.newbieSpawns    = validateModel(path + 'Templates/Spawns/spawns');
        DataCache.experience      = validateModel(path + 'Templates/Experience/experience');
        DataCache.revitalize      = validateModel(path + 'Templates/Revitalize/revitalize');
        DataCache.skillTree       = validateModel(path + 'Skills/Tree/tree');
        const C4LateTownGatekeepers = invoke('GameServer/World/C4LateTownGatekeepers');
        const C4SevenSignsDungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');
        DataCache.npcs            = [
            ...validateModel(path + 'Npcs/npcs'),
            ...validateModel(path + 'Npcs/c4_swamp_of_screams'),
            ...validateModel(path + 'Npcs/c4_garden_of_beasts'),
            ...validateModel(path + 'Npcs/c4_valley_of_saints'),
            ...validateModel(path + 'Npcs/c4_forest_of_the_dead'),
            ...validateModel(path + 'Npcs/c4_devils_isle'),
            ...validateModel(path + 'Npcs/c4_elmore_northeast_coast'),
            ...validateModel(path + 'Npcs/c4_devastated_castle'),
            ...validateModel(path + 'Npcs/c4_ketra_orc_outpost'),
            ...validateModel(path + 'Npcs/c4_hot_springs'),
            ...validateModel(path + 'Npcs/c4_wall_of_argos'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_sacrifice'),
            ...validateModel(path + 'Npcs/c4_catacomb_of_the_branded'),
            ...validateModel(path + 'Npcs/c4_catacomb_of_the_witch'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_the_disciples'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_saints'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_patriots'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_ascetics'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_pilgrims'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_worshipers'),
            ...validateModel(path + 'Npcs/c4_necropolis_of_martyrs'),
            ...validateModel(path + 'Npcs/c4_catacomb_of_dark_omen'),
            ...validateModel(path + 'Npcs/c4_catacomb_of_the_apostate'),
            ...validateModel(path + 'Npcs/c4_catacomb_of_the_heretics'),
            ...validateModel(path + 'Npcs/c4_catacomb_of_the_forbidden_path'),
            ...C4LateTownGatekeepers.npcs,
            ...C4SevenSignsDungeonTeleports.npcs
        ];
        DataCache.npcSpawns       = [
            ...validateModel(path + 'Npcs/Spawns/spawns'),
            ...validateModel(path + 'Npcs/Spawns/c4_swamp_of_screams'),
            ...validateModel(path + 'Npcs/Spawns/c4_garden_of_beasts'),
            ...validateModel(path + 'Npcs/Spawns/c4_valley_of_saints'),
            ...validateModel(path + 'Npcs/Spawns/c4_forest_of_the_dead'),
            ...validateModel(path + 'Npcs/Spawns/c4_devils_isle'),
            ...validateModel(path + 'Npcs/Spawns/c4_elmore_northeast_coast'),
            ...validateModel(path + 'Npcs/Spawns/c4_devastated_castle'),
            ...validateModel(path + 'Npcs/Spawns/c4_ketra_orc_outpost'),
            ...validateModel(path + 'Npcs/Spawns/c4_hot_springs'),
            ...validateModel(path + 'Npcs/Spawns/c4_wall_of_argos'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_sacrifice'),
            ...validateModel(path + 'Npcs/Spawns/c4_catacomb_of_the_branded'),
            ...validateModel(path + 'Npcs/Spawns/c4_catacomb_of_the_witch'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_the_disciples'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_saints'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_patriots'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_ascetics'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_pilgrims'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_worshipers'),
            ...validateModel(path + 'Npcs/Spawns/c4_necropolis_of_martyrs'),
            ...validateModel(path + 'Npcs/Spawns/c4_catacomb_of_dark_omen'),
            ...validateModel(path + 'Npcs/Spawns/c4_catacomb_of_the_apostate'),
            ...validateModel(path + 'Npcs/Spawns/c4_catacomb_of_the_heretics'),
            ...validateModel(path + 'Npcs/Spawns/c4_catacomb_of_the_forbidden_path'),
            ...C4LateTownGatekeepers.spawns,
            ...C4SevenSignsDungeonTeleports.spawns
        ];
        DataCache.npcRewards      = [
            ...validateModel(path + 'Npcs/Rewards/rewards'),
            ...validateModel(path + 'Npcs/Rewards/c4_swamp_of_screams'),
            ...validateModel(path + 'Npcs/Rewards/c4_garden_of_beasts'),
            ...validateModel(path + 'Npcs/Rewards/c4_valley_of_saints'),
            ...validateModel(path + 'Npcs/Rewards/c4_forest_of_the_dead'),
            ...validateModel(path + 'Npcs/Rewards/c4_devils_isle'),
            ...validateModel(path + 'Npcs/Rewards/c4_elmore_northeast_coast'),
            ...validateModel(path + 'Npcs/Rewards/c4_devastated_castle'),
            ...validateModel(path + 'Npcs/Rewards/c4_ketra_orc_outpost'),
            ...validateModel(path + 'Npcs/Rewards/c4_hot_springs'),
            ...validateModel(path + 'Npcs/Rewards/c4_wall_of_argos'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_sacrifice'),
            ...validateModel(path + 'Npcs/Rewards/c4_catacomb_of_the_branded'),
            ...validateModel(path + 'Npcs/Rewards/c4_catacomb_of_the_witch'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_the_disciples'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_saints'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_patriots'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_ascetics'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_pilgrims'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_worshipers'),
            ...validateModel(path + 'Npcs/Rewards/c4_necropolis_of_martyrs'),
            ...validateModel(path + 'Npcs/Rewards/c4_catacomb_of_dark_omen'),
            ...validateModel(path + 'Npcs/Rewards/c4_catacomb_of_the_apostate'),
            ...validateModel(path + 'Npcs/Rewards/c4_catacomb_of_the_heretics'),
            ...validateModel(path + 'Npcs/Rewards/c4_catacomb_of_the_forbidden_path')
        ];
        DataCache.teleports       = validateModel(path + 'Teleports/teleports');
        DataCache.adminShop       = validateModel(path + 'Admin/Shop/shop');

        DataCache.items = [
            ...validateModel(path + 'Items/Armors/armors'),
            ...validateModel(path + 'Items/Armors/c4_a_grade'),
            ...validateModel(path + 'Items/Armors/c4_sealed_a_grade'),
            ...validateModel(path + 'Items/Armors/c4_s_grade'),
            ...validateModel(path + 'Items/Weapons/weapons'),
            ...validateModel(path + 'Items/Weapons/c4_s_grade'),
            ...validateModel(path + 'Items/Weapons/c4_necropolis_of_sacrifice'),
            ...validateModel(path + 'Items/Others/others'),
            ...validateModel(path + 'Items/Others/c4_a_grade'),
            ...validateModel(path + 'Items/Others/c4_sealed_a_grade'),
            ...validateModel(path + 'Items/Others/c4_s_grade'),
            ...validateModel(path + 'Items/Others/c4_swamp_of_screams'),
            ...validateModel(path + 'Items/Others/c4_garden_of_beasts'),
            ...validateModel(path + 'Items/Others/c4_valley_of_saints'),
            ...validateModel(path + 'Items/Others/c4_forest_of_the_dead'),
            ...validateModel(path + 'Items/Others/c4_devils_isle'),
            ...validateModel(path + 'Items/Others/c4_elmore_northeast_coast'),
            ...validateModel(path + 'Items/Others/c4_devastated_castle'),
            ...validateModel(path + 'Items/Others/c4_ketra_orc_outpost'),
            ...validateModel(path + 'Items/Others/c4_hot_springs'),
            ...validateModel(path + 'Items/Others/c4_wall_of_argos'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_sacrifice'),
            ...validateModel(path + 'Items/Others/c4_catacomb_of_the_branded'),
            ...validateModel(path + 'Items/Others/c4_catacomb_of_the_witch'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_the_disciples'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_saints'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_patriots'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_ascetics'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_pilgrims'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_worshipers'),
            ...validateModel(path + 'Items/Others/c4_necropolis_of_martyrs'),
            ...validateModel(path + 'Items/Others/c4_catacomb_of_dark_omen'),
            ...validateModel(path + 'Items/Others/c4_catacomb_of_the_apostate'),
            ...validateModel(path + 'Items/Others/c4_catacomb_of_the_heretics'),
            ...validateModel(path + 'Items/Others/c4_catacomb_of_the_forbidden_path')
        ];

        DataCache.skills = [
            ...validateModel(path + 'Skills/Active/active'),
            ...validateModel(path + 'Skills/Passive/passive'),
            ...validateModel(path + 'Skills/Switch/switch')
        ];

        utils.infoSuccess('Datapack', 'cached');
    },

    fetchNpcFromSelfId(selfId, callback) {
        const item = structuredClone(DataCache.npcs.find((ob) => ob.selfId === selfId));
        item ? callback(item) : utils.infoWarn('Datapack', 'unknown Npc SelfId %d', selfId);
    },

    fetchNpcRewardsFromSelfId(selfId, callback) {
        const item = structuredClone(DataCache.npcRewards.find((ob) => ob.selfId === selfId));
        item ? callback(item) : utils.infoWarn('Datapack', 'unknown NpcRewards SelfId %d', selfId);
    },

    fetchItemFromSelfId(selfId, callback) {
        const item = structuredClone(DataCache.items.find((ob) => ob.selfId === selfId));
        item ? callback(item) : utils.infoWarn('Datapack', 'unknown Item SelfId %d', selfId);
    },

    fetchSkillFromSelfId(selfId, callback) {
        const item = structuredClone(DataCache.skills.find((ob) => ob.selfId === selfId));
        item ? callback(item) : utils.infoWarn('Datapack', 'unknown Skill SelfId %d', selfId);
    },

    fetchSkillTreeFromClassId(classId, callback) {
        const item = structuredClone(DataCache.skillTree.find((ob) => ob.classId === classId));
        item ? callback(item) : utils.infoWarn('Datapack', 'unknown SkillTree ClassId %d', classId);
    }
};

function validateModel(filepath) {
    const path   = require('path').dirname(filepath);
    const model  = invoke(filepath);
    const result = validateSchema(model, invoke(path + '/.schema'));

    if (!result.valid) {
        utils.infoWarn('Cache', 'failed to parse "%s" -> %s', filepath, result.errors[0].stack);
    }
    
    return model;
}

module.exports = DataCache;
