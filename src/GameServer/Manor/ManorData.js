const SEEDS = {
    5016: { level: 10, cropId: 5073, alternative: false },
    5017: { level: 13, cropId: 5068, alternative: false },
    5018: { level: 16, cropId: 5065, alternative: false },
    5019: { level: 19, cropId: 5067, alternative: false },
    5020: { level: 22, cropId: 5069, alternative: false },
    5021: { level: 25, cropId: 5071, alternative: false },
    5022: { level: 28, cropId: 5070, alternative: false },
    5023: { level: 37, cropId: 5077, alternative: false },
    5024: { level: 19, cropId: 5067, alternative: false },
    5025: { level: 22, cropId: 5069, alternative: false },
    5026: { level: 25, cropId: 5071, alternative: false },
    5027: { level: 28, cropId: 5070, alternative: false },
    5028: { level: 31, cropId: 5078, alternative: false },
    5029: { level: 34, cropId: 5075, alternative: false },
    5030: { level: 40, cropId: 5082, alternative: false },
    5031: { level: 43, cropId: 5079, alternative: false },
    5032: { level: 46, cropId: 5084, alternative: false },
    5033: { level: 31, cropId: 5078, alternative: false },
    5034: { level: 34, cropId: 5075, alternative: false },
    5035: { level: 37, cropId: 5077, alternative: false },
    5036: { level: 40, cropId: 5082, alternative: false },
    5037: { level: 43, cropId: 5079, alternative: false },
    5038: { level: 46, cropId: 5084, alternative: false },
    5039: { level: 49, cropId: 5088, alternative: false },
    5040: { level: 58, cropId: 5092, alternative: false },
    5041: { level: 64, cropId: 5090, alternative: false },
    5042: { level: 10, cropId: 5073, alternative: false },
    5043: { level: 13, cropId: 5068, alternative: false },
    5044: { level: 19, cropId: 5067, alternative: false },
    5045: { level: 31, cropId: 5078, alternative: false },
    5046: { level: 34, cropId: 5075, alternative: false },
    5047: { level: 37, cropId: 5077, alternative: false },
    5048: { level: 40, cropId: 5082, alternative: false },
    5049: { level: 50, cropId: 5091, alternative: false },
    5050: { level: 52, cropId: 5085, alternative: false },
    5051: { level: 55, cropId: 5087, alternative: false },
    5052: { level: 58, cropId: 5092, alternative: false },
    5053: { level: 40, cropId: 5082, alternative: false },
    5054: { level: 43, cropId: 5079, alternative: false },
    5055: { level: 46, cropId: 5084, alternative: false },
    5056: { level: 49, cropId: 5088, alternative: false },
    5057: { level: 52, cropId: 5085, alternative: false },
    5058: { level: 55, cropId: 5087, alternative: false },
    5059: { level: 58, cropId: 5092, alternative: false },
    5060: { level: 61, cropId: 5094, alternative: false },
    5061: { level: 64, cropId: 5090, alternative: false },
    5221: { level: 34, cropId: 5075, alternative: false },
    5222: { level: 37, cropId: 5077, alternative: false },
    5223: { level: 40, cropId: 5082, alternative: false },
    5224: { level: 43, cropId: 5079, alternative: false },
    5225: { level: 46, cropId: 5084, alternative: false },
    5226: { level: 49, cropId: 5088, alternative: false },
    5227: { level: 50, cropId: 5091, alternative: false },
    5650: { level: 10, cropId: 5818, alternative: true },
    5651: { level: 13, cropId: 5819, alternative: true },
    5652: { level: 16, cropId: 5820, alternative: true },
    5653: { level: 19, cropId: 5821, alternative: true },
    5654: { level: 22, cropId: 5822, alternative: true },
    5655: { level: 25, cropId: 5823, alternative: true },
    5656: { level: 28, cropId: 5824, alternative: true },
    5657: { level: 37, cropId: 5827, alternative: true },
    5658: { level: 19, cropId: 5821, alternative: true },
    5659: { level: 22, cropId: 5822, alternative: true },
    5660: { level: 25, cropId: 5823, alternative: true },
    5661: { level: 28, cropId: 5824, alternative: true },
    5662: { level: 31, cropId: 5825, alternative: true },
    5663: { level: 34, cropId: 5826, alternative: true },
    5664: { level: 40, cropId: 5828, alternative: true },
    5665: { level: 43, cropId: 5829, alternative: true },
    5666: { level: 46, cropId: 5830, alternative: true },
    5667: { level: 31, cropId: 5825, alternative: true },
    5668: { level: 34, cropId: 5826, alternative: true },
    5669: { level: 37, cropId: 5827, alternative: true },
    5670: { level: 40, cropId: 5828, alternative: true },
    5671: { level: 43, cropId: 5829, alternative: true },
    5672: { level: 46, cropId: 5830, alternative: true },
    5673: { level: 49, cropId: 5831, alternative: true },
    5674: { level: 58, cropId: 5835, alternative: true },
    5675: { level: 64, cropId: 5837, alternative: true },
    5676: { level: 10, cropId: 5818, alternative: true },
    5677: { level: 13, cropId: 5819, alternative: true },
    5678: { level: 19, cropId: 5821, alternative: true },
    5679: { level: 31, cropId: 5825, alternative: true },
    5680: { level: 34, cropId: 5826, alternative: true },
    5681: { level: 37, cropId: 5827, alternative: true },
    5682: { level: 40, cropId: 5828, alternative: true },
    5683: { level: 50, cropId: 5832, alternative: true },
    5684: { level: 52, cropId: 5833, alternative: true },
    5685: { level: 55, cropId: 5834, alternative: true },
    5686: { level: 58, cropId: 5835, alternative: true },
    5687: { level: 40, cropId: 5828, alternative: true },
    5688: { level: 43, cropId: 5829, alternative: true },
    5689: { level: 46, cropId: 5830, alternative: true },
    5690: { level: 49, cropId: 5831, alternative: true },
    5691: { level: 52, cropId: 5833, alternative: true },
    5692: { level: 55, cropId: 5834, alternative: true },
    5693: { level: 58, cropId: 5835, alternative: true },
    5694: { level: 61, cropId: 5836, alternative: true },
    5695: { level: 64, cropId: 5837, alternative: true },
    5696: { level: 34, cropId: 5826, alternative: true },
    5697: { level: 37, cropId: 5827, alternative: true },
    5698: { level: 40, cropId: 5828, alternative: true },
    5699: { level: 43, cropId: 5829, alternative: true },
    5700: { level: 46, cropId: 5830, alternative: true },
    5701: { level: 49, cropId: 5831, alternative: true },
    5702: { level: 50, cropId: 5832, alternative: true },
    6727: { level: 85, cropId: 6554, alternative: true },
    6728: { level: 79, cropId: 6552, alternative: true },
    6729: { level: 79, cropId: 6552, alternative: true },
    6730: { level: 79, cropId: 6552, alternative: true },
    6731: { level: 70, cropId: 6549, alternative: true },
    6732: { level: 70, cropId: 6549, alternative: true },
    6733: { level: 70, cropId: 6549, alternative: true },
    6736: { level: 76, cropId: 6551, alternative: true },
    6737: { level: 76, cropId: 6551, alternative: true },
    6738: { level: 76, cropId: 6551, alternative: true },
    6739: { level: 76, cropId: 6551, alternative: true },
    6741: { level: 82, cropId: 6553, alternative: true },
    6742: { level: 67, cropId: 6548, alternative: true },
    6743: { level: 67, cropId: 6548, alternative: true },
    6744: { level: 67, cropId: 6548, alternative: true },
    6745: { level: 67, cropId: 6548, alternative: true },
    6747: { level: 73, cropId: 6550, alternative: true },
    6748: { level: 73, cropId: 6550, alternative: true },
    6749: { level: 73, cropId: 6550, alternative: true },
    6750: { level: 73, cropId: 6550, alternative: true },
    6751: { level: 73, cropId: 6550, alternative: true },
    6753: { level: 85, cropId: 6547, alternative: false },
    6754: { level: 79, cropId: 6545, alternative: false },
    6755: { level: 79, cropId: 6545, alternative: false },
    6756: { level: 79, cropId: 6545, alternative: false },
    6757: { level: 70, cropId: 6542, alternative: false },
    6758: { level: 70, cropId: 6542, alternative: false },
    6759: { level: 70, cropId: 6542, alternative: false },
    6760: { level: 70, cropId: 6542, alternative: false },
    6762: { level: 76, cropId: 6544, alternative: false },
    6763: { level: 76, cropId: 6544, alternative: false },
    6764: { level: 76, cropId: 6544, alternative: false },
    6765: { level: 76, cropId: 6544, alternative: false },
    6767: { level: 82, cropId: 6546, alternative: false },
    6768: { level: 67, cropId: 6541, alternative: false },
    6769: { level: 67, cropId: 6541, alternative: false },
    6770: { level: 67, cropId: 6541, alternative: false },
    6771: { level: 67, cropId: 6541, alternative: false },
    6773: { level: 73, cropId: 6543, alternative: false },
    6774: { level: 73, cropId: 6543, alternative: false },
    6775: { level: 73, cropId: 6543, alternative: false },
    6776: { level: 73, cropId: 6543, alternative: false },
    6777: { level: 73, cropId: 6543, alternative: false },
    7016: { level: 37, cropId: 5077, alternative: false },
    7017: { level: 55, cropId: 5087, alternative: false },
    7018: { level: 55, cropId: 5087, alternative: false },
    7019: { level: 34, cropId: 5075, alternative: false },
    7020: { level: 16, cropId: 5065, alternative: false },
    7021: { level: 52, cropId: 5085, alternative: false },
    7022: { level: 52, cropId: 5085, alternative: false },
    7023: { level: 64, cropId: 5090, alternative: false },
    7024: { level: 64, cropId: 5090, alternative: false },
    7025: { level: 43, cropId: 5079, alternative: false },
    7026: { level: 22, cropId: 5069, alternative: false },
    7027: { level: 46, cropId: 5084, alternative: false },
    7028: { level: 61, cropId: 5094, alternative: false },
    7029: { level: 61, cropId: 5094, alternative: false },
    7030: { level: 37, cropId: 5827, alternative: true },
    7031: { level: 55, cropId: 5834, alternative: true },
    7032: { level: 55, cropId: 5834, alternative: true },
    7033: { level: 34, cropId: 5826, alternative: true },
    7034: { level: 16, cropId: 5820, alternative: true },
    7035: { level: 52, cropId: 5833, alternative: true },
    7036: { level: 52, cropId: 5833, alternative: true },
    7037: { level: 64, cropId: 5837, alternative: true },
    7038: { level: 64, cropId: 5837, alternative: true },
    7039: { level: 43, cropId: 5829, alternative: true },
    7040: { level: 22, cropId: 5822, alternative: true },
    7041: { level: 46, cropId: 5830, alternative: true },
    7042: { level: 61, cropId: 5836, alternative: true },
    7043: { level: 61, cropId: 5836, alternative: true },
    7044: { level: 31, cropId: 5825, alternative: true },
    7045: { level: 49, cropId: 5831, alternative: true },
    7046: { level: 49, cropId: 5831, alternative: true },
    7047: { level: 50, cropId: 5832, alternative: true },
    7048: { level: 50, cropId: 5832, alternative: true },
    7049: { level: 50, cropId: 5832, alternative: true },
    7050: { level: 58, cropId: 5835, alternative: true },
    7051: { level: 31, cropId: 5078, alternative: false },
    7052: { level: 49, cropId: 5088, alternative: false },
    7053: { level: 49, cropId: 5088, alternative: false },
    7054: { level: 50, cropId: 5091, alternative: false },
    7055: { level: 50, cropId: 5091, alternative: false },
    7056: { level: 50, cropId: 5091, alternative: false },
    7057: { level: 58, cropId: 5092, alternative: false }
};

function seedById(seedId) {
    return SEEDS[Number(seedId)] || null;
}

function sowSuccessChance(seedId, playerLevel, targetLevel) {
    const seed = seedById(seedId);
    if (!seed) {
        return 0;
    }

    let chance = seed.alternative ? 20 : 90;
    if (targetLevel < seed.level - 5) {
        chance -= 5;
    }
    if (targetLevel > seed.level + 5) {
        chance -= 5;
    }

    const diff = Math.abs((Number(playerLevel) || 1) - (Number(targetLevel) || 1));
    if (diff > 5) {
        chance -= 5 * (diff - 5);
    }

    return Math.max(1, chance);
}

function harvestSuccessChance(playerLevel, targetLevel) {
    const diff = Math.abs((Number(playerLevel) || 1) - (Number(targetLevel) || 1));
    return Math.max(1, 100 - (diff > 5 ? (diff - 5) * 5 : 0));
}

function strongMultiplier(npc) {
    const skills = npc?.model?.skills || npc?.model?.template?.skills || {};
    const ids = Array.isArray(skills)
        ? skills.map((entry) => Number(entry.id ?? entry.selfId ?? entry))
        : Object.keys(skills).map(Number);

    return ids.reduce((multiplier, skillId) => {
        if (skillId >= 4303 && skillId <= 4310) {
            return multiplier * (skillId - 4301);
        }
        return multiplier;
    }, 1);
}

function harvestItems(seedId, targetLevel, npc) {
    const seed = seedById(seedId);
    if (!seed) {
        return [];
    }

    let count = strongMultiplier(npc);
    const diff = (Number(targetLevel) || 1) - (seed.level - 5);
    if (diff > 0) {
        count += diff;
    }

    return [{ selfId: seed.cropId, amount: count }];
}

module.exports = {
    seedById,
    sowSuccessChance,
    harvestSuccessChance,
    harvestItems,
    seeds: SEEDS
};
