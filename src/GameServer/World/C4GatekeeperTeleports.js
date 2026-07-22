const DESTINATIONS = {
    1: [-80826, 149775, -3043, 6400], 2: [-12672, 122776, -3116, 3700], 3: [46934, 51467, -2977, 3700], 4: [9745, 15606, -4574, 3700], 5: [-80826, 149775, -3043, 2900], 6: [15670, 142983, -2705, 4100], 7: [-44836, -112524, -235, 6000], 8: [115113, -178212, -901, 6000], 9: [-84318, 244579, -3730, 18000], 10: [46934, 51467, -2977, 6400], 11: [9745, 15606, -4574, 6400], 12: [-12672, 122776, -3116, 2900], 13: [-16730, 209417, -3664, 2400],
    15: [-80826, 149775, -3043, 18000], 16: [-80826, 149775, -3043, 3000], 17: [169008, -208272, -3504, 700], 18: [-12672, 122776, -3116, 4100], 19: [83400, 147943, -3404, 8100], 20: [47942, 186764, -3485, 6500], 25: [15670, 142983, -2705, 8100], 26: [82956, 53162, -1495, 11000], 27: [117088, 76931, -2696, 9400], 28: [105918, 109759, -3207, 5300],
    32: [85399, 16197, -3679, 0], 33: [85399, 16197, -2809, 0], 34: [85399, 16197, -2293, 0], 35: [85399, 16197, -1776, 0], 47: [83400, 147943, -3404, 11000], 48: [85348, 16142, -3699, 4400], 49: [117088, 76931, -2696, 4900], 50: [105918, 109759, -3207, 7300], 51: [146783, 25808, -2008, 13000],
    39: [85348, 16142, -3699, 12000], 40: [82956, 53162, -1495, 13000], 41: [117088, 76931, -2696, 11000], 76: [146440, 46723, -3432, 4100], 77: [-25472, 77728, -3440, 35000], 78: [-55385, 78667, -3012, 41000], 79: [79296, 209584, -3704, 39000], 80: [-23165, 13827, -3172, 33000], 81: [159455, -12931, -2872, 1400], 82: [185319, 20218, -3264, 1400], 83: [163341, 91374, -3320, 2400], 84: [167285, 37109, -4008, 840], 134: [43799, -47727, -798, 25000], 135: [147928, -55273, -2734, 16000],
    42: [83400, 147943, -3404, 9400], 43: [82956, 53162, -1495, 4900], 44: [85348, 16142, -3699, 8200], 45: [105918, 109759, -3207, 4100], 46: [146783, 25808, -2008, 11000], 99: [104426, 33746, -3800, 3700], 100: [124904, 61992, -3920, 1400], 101: [142065, 81300, -3000, 2100],
    108: [43799, -47727, -798, 20000], 109: [125543, -40953, -3724, 950], 110: [146954, -67390, -3660, 420], 111: [169178, -116244, -2421, 2300], 112: [115358, 132811, -3103, 38000], 113: [137480, 79641, -3701, 27000], 114: [-55385, 78667, -3012, 48000], 115: [110399, 84041, -4813, 29000], 116: [79296, 209584, -3704, 54000], 117: [-23165, 13827, -3172, 36000], 118: [168882, -18057, -3173, 8500], 119: [147928, -55273, -2734, 12000], 120: [83400, 147943, -3404, 23000], 121: [146783, 25808, -2008, 15000], 122: [38320, -48092, -1153, 150], 123: [38275, -48065, 896, 150], 124: [52112, -53939, -3159, 290], 125: [70006, -49902, -3251, 710], 126: [74379, 78887, -3397, 25000], 127: [-25472, 77728, -3440, 28000], 128: [115358, 132811, -3103, 38000], 129: [137480, 79641, -3701, 31000], 130: [-55385, 78667, -3012, 32000], 132: [146783, 25808, -2008, 16000],
    69: [122881, 110792, -3722, 6400], 70: [111409, 219364, -3545, 9200], 71: [-25472, 77728, -3440, 15500], 72: [-55385, 78667, -3012, 18600], 73: [79296, 209584, -3704, 9800], 74: [-23165, 13827, -3172, 20400], 85: [111409, 219364, -3545, 9800], 86: [46467, 126885, -3720, 1900], 87: [20505, 189036, -3344, 2500], 88: [-23789, 169683, -3424, 1000], 89: [-16730, 209417, -3664, 2400], 90: [-46932, 140883, -2936, 900], 91: [-70387, 115501, -3472, 1000], 92: [-45210, 202654, -3592, 1700], 93: [-8804, -114748, -3088, 410], 94: [-17870, -90980, -2528, 620], 96: [7603, -138871, -920, 720], 97: [87252, 85514, -3056, 2700], 98: [64328, 26803, -3768, 2700],
    418: [155535, -173560, 2495, 290], 419: [179039, -184080, -319, 680], 464: [-22224, 14168, -3232, 380], 465: [-56532, 78321, -2960, 1800], 466: [-30777, 49750, -3552, 480], 467: [-23520, 68688, -3640, 760], 468: [21362, 51122, -3688, 300], 469: [-10612, 75881, -3592, 740], 470: [29294, 74968, -3776, 2500], 471: [9340, -112509, -2536, 650],
    1001: [-99678, 237562, -3567, 200], 1002: [-101294, 212553, -3093, 3000], 1003: [-113329, 235327, -3653, 2500], 1004: [-107456, 242669, -3493, 2300], 136: [47942, 186764, -3485, 6300]
};

const LISTS = {
    7006: [[15, 'The Village of Gludin'], [1001, 'Obelisk of Victory'], [1002, 'Western Territory of Talking Island'], [1003, 'Elven Ruins'], [1004, 'Singing Waterfall']],
    7059: [[18, 'The Town of Gludio'], [19, 'The Town of Giran'], [20, 'Giran Harbor'], [85, 'Heine'], [86, 'Partisan Hideaway'], [87, 'Bee Hive']],
    7080: [[25, 'The Town of Dion'], [26, 'Oren Castle Town'], [27, "Hunter's Village"], [136, 'Giran Harbor'], [69, 'Dragon Valley'], [28, "Hardin's Private Academy"], [70, 'Heine'], [71, 'Patriots Necropolis'], [72, 'Ascetics Necropolis'], [73, 'Saints Necropolis'], [74, 'Catacomb of Dark Omens']],
    7134: [[1, 'The Village of Gludin'], [2, 'The Town of Gludio'], [464, 'Dark Forest'], [465, 'Spider Nest'], [466, 'Swampland'], [467, 'Neutral Zone']],
    7146: [[1, 'The Village of Gludin'], [2, 'The Town of Gludio'], [468, 'Elven Forest'], [469, 'Neutral Zone'], [470, 'Elven Fortress']],
    7162: [[32, 'Ground Floor Lobby'], [33, '1st Floor Human Wizard Guild'], [34, '2nd Floor Elven Wizard Guild'], [35, '3rd Floor Dark Wizard Guild']],
    7177: [[47, 'The Town of Giran'], [48, 'Ivory Tower'], [49, "Hunter's Village"], [50, "Hardin's Private Academy"], [51, 'Aden Castle Town'], [97, 'Plains of the Lizardmen'], [98, 'Sea of Spores']],
    7233: [[42, 'The Town of Giran'], [43, 'Oren Castle Town'], [44, 'Ivory Tower'], [45, "Hardin's Private Academy"], [46, 'Aden Castle Town'], [99, 'Northern Pathway of the Enchanted Valley'], [100, 'Southern Pathway of the Enchanted Valley'], [101, 'Entrance to the Forest of Mirrors']],
    7848: [[41, "Hunter's Village"], [40, 'Oren Castle Town'], [134, 'Rune Castle Town'], [135, 'Goddard Castle Town'], [39, 'Ivory Tower'], [76, 'Coliseum'], [84, 'Forsaken Plains'], [82, 'The Forbidden Gateway'], [81, 'Blazing Swamp'], [83, 'The Front of Anghell Waterfall'], [77, 'Patriots Necropolis'], [78, 'Ascetics Necropolis'], [79, 'Saints Necropolis'], [80, 'Catacomb of Dark Omens']],
    8275: [[132, 'Aden Castle Town'], [108, 'Rune Castle Town'], [109, 'Varka Silenos Stronghold'], [110, 'Ketra Orc Outpost'], [111, 'Entrance to the Forge of the Gods'], [112, 'Martyrs Necropolis'], [113, 'Catacomb of the Witch'], [114, 'Ascetics Necropolis'], [115, 'Catacomb of the Forbidden Path'], [116, 'Saints Necropolis'], [117, 'Catacomb of Dark Omens'], [118, 'Disciples Necropolis']],
    8320: [[119, 'Goddard Castle Town'], [120, 'The Town of Giran'], [121, 'Aden Castle Town'], [122, 'Rune Castle Town Guild'], [123, 'Rune Castle Town Temple'], [124, 'Entrance to the Forest of the Dead'], [125, 'Western Entrance to the Swamp of Screams'], [126, 'Catacomb of the Apostate'], [127, 'Patriots Necropolis'], [128, 'Martyrs Necropolis'], [129, 'Catacomb of the Witch'], [130, 'Ascetics Necropolis']],
    7256: [[3, 'The Elven Village'], [4, 'The Dark Elven Village'], [5, 'The Village of Gludin'], [6, 'The Town of Dion'], [7, 'Orc Village'], [8, 'Dwarven Village'], [88, 'Windawood Manor'], [89, 'Southern Pathway to the Wasteland']],
    7320: [[9, 'Talking Island Village'], [10, 'The Elven Village'], [11, 'The Dark Elven Village'], [12, 'The Town of Gludio'], [7, 'Orc Village'], [8, 'Dwarven Village'], [13, 'The Southern Entrance of the Wastelands'], [90, 'Abandoned Camp'], [91, 'Fellmere Harvest Grounds'], [92, 'Langk Lizardman Dwelling']],
    7540: [[16, 'The Village of Gludin'], [17, 'The Northeast Coast'], [418, 'Entrance to the Abandoned Coal Mines'], [419, 'Entrance to the Mithril Mines']],
    7576: [[16, 'The Village of Gludin'], [93, 'Immortal Plateau, Northern Region'], [94, 'Immortal Plateau, Southern Region'], [96, 'Frozen Waterfall'], [471, 'Entrance to the Cave of Trials']]
};

function destination(npcId, id) {
    if (!LISTS[npcId]?.some(([candidate]) => candidate === Number(id))) return null;
    const data = DESTINATIONS[id];
    if (!data) return null;
    const [locX, locY, locZ, price] = data;
    return { locX, locY, locZ, price };
}

function html(npcId) {
    const rows = LISTS[npcId];
    if (!rows) return null;
    const links = rows.map(([id, label]) => {
        const price = DESTINATIONS[id][3];
        const suffix = price > 0 ? ` - ${price} Adena` : '';
        return `<a action="bypass -h gatekeeper-teleport ${id}" msg="811;${label}">${label}${suffix}</a><br1>`;
    });
    return `<html><body>Region where teleporting is possible<br>${links.join('')}<br></body></html>`;
}

function menu(npcId, hasQuest) {
    if (!LISTS[npcId]) return null;
    const quest = hasQuest
        ? '<a action="bypass -h gatekeeper-quest">Quest</a><br1>'
        : '';
    return `<html><body>How can I help you?<br><br><a action="bypass -h gatekeeper-teleport">Teleport</a><br1>${quest}</body></html>`;
}

module.exports = { destination, html, menu, lists: LISTS };
