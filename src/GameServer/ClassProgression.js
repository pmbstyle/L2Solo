const thirdClasses = {
    88: { parentClassId: 2, name: 'Duelist', cp: { baseCpMax: 2755.6, lvlCpAdd: 56.77, lvlCpMod: 0.22 } },
    89: { parentClassId: 3, name: 'Dreadnought', cp: { baseCpMax: 2619.3, lvlCpAdd: 55.78, lvlCpMod: 0.22 } },
    90: { parentClassId: 5, name: 'Phoenix Knight', cp: { baseCpMax: 1730.3, lvlCpAdd: 35.86, lvlCpMod: 0.22 } },
    91: { parentClassId: 6, name: 'Hell Knight', cp: { baseCpMax: 1730.3, lvlCpAdd: 35.86, lvlCpMod: 0.22 } },
    92: { parentClassId: 9, name: 'Sagittarius', cp: { baseCpMax: 1910.9, lvlCpAdd: 39.51, lvlCpMod: 0.22 } },
    93: { parentClassId: 8, name: 'Adventurer', cp: { baseCpMax: 1049.4, lvlCpAdd: 21.25, lvlCpMod: 0.22 } },
    94: { parentClassId: 12, name: 'Archmage', cp: { baseCpMax: 1440, lvlCpAdd: 29.05, lvlCpMod: 0.22 } },
    95: { parentClassId: 13, name: 'Soultaker', cp: { baseCpMax: 1440, lvlCpAdd: 29.05, lvlCpMod: 0.22 } },
    96: { parentClassId: 14, name: 'Arcana Lord', cp: { baseCpMax: 1823.5, lvlCpAdd: 37.85, lvlCpMod: 0.22 } },
    97: { parentClassId: 16, name: 'Cardinal', cp: { baseCpMax: 2227.8, lvlCpAdd: 44.16, lvlCpMod: 0.22 } },
    98: { parentClassId: 17, name: 'Hierophant', cp: { baseCpMax: 1671, lvlCpAdd: 34.03, lvlCpMod: 0.22 } },
    99: { parentClassId: 20, name: "Eva's Templar", cp: { baseCpMax: 1917.6, lvlCpAdd: 39.84, lvlCpMod: 0.22 } },
    100: { parentClassId: 21, name: 'Sword Muse', cp: { baseCpMax: 1651.1, lvlCpAdd: 34.86, lvlCpMod: 0.22 } },
    101: { parentClassId: 23, name: 'Wind Rider', cp: { baseCpMax: 1174.3, lvlCpAdd: 23.9, lvlCpMod: 0.22 } },
    102: { parentClassId: 24, name: 'Moonlight Sentinel', cp: { baseCpMax: 1521, lvlCpAdd: 31.54, lvlCpMod: 0.22 } },
    103: { parentClassId: 27, name: 'Mystic Muse', cp: { baseCpMax: 1506.5, lvlCpAdd: 30.71, lvlCpMod: 0.22 } },
    104: { parentClassId: 28, name: 'Elemental Master', cp: { baseCpMax: 1871.5, lvlCpAdd: 38.84, lvlCpMod: 0.22 } },
    105: { parentClassId: 30, name: "Eva's Saint", cp: { baseCpMax: 1711, lvlCpAdd: 34.86, lvlCpMod: 0.22 } },
    106: { parentClassId: 33, name: 'Shillien Templar', cp: { baseCpMax: 2024.4, lvlCpAdd: 41.83, lvlCpMod: 0.22 } },
    107: { parentClassId: 34, name: 'Spectral Dancer', cp: { baseCpMax: 1766.6, lvlCpAdd: 37.35, lvlCpMod: 0.22 } },
    108: { parentClassId: 36, name: 'Ghost Hunter', cp: { baseCpMax: 1245.5, lvlCpAdd: 25.23, lvlCpMod: 0.22 } },
    109: { parentClassId: 37, name: 'Ghost Sentinel', cp: { baseCpMax: 1610, lvlCpAdd: 33.2, lvlCpMod: 0.22 } },
    110: { parentClassId: 40, name: 'Storm Screamer', cp: { baseCpMax: 1519.5, lvlCpAdd: 30.71, lvlCpMod: 0.22 } },
    111: { parentClassId: 41, name: 'Spectral Master', cp: { baseCpMax: 1918.9, lvlCpAdd: 39.84, lvlCpMod: 0.22 } },
    112: { parentClassId: 43, name: 'Shillien Saint', cp: { baseCpMax: 1723.9, lvlCpAdd: 34.86, lvlCpMod: 0.22 } },
    113: { parentClassId: 46, name: 'Titan', cp: { baseCpMax: 2413, lvlCpAdd: 51.03, lvlCpMod: 0.22 } },
    114: { parentClassId: 48, name: 'Grand Khavatari', cp: { baseCpMax: 1646.6, lvlCpAdd: 34.76, lvlCpMod: 0.22 } },
    115: { parentClassId: 51, name: 'Dominator', cp: { baseCpMax: 2687.9, lvlCpAdd: 54.35, lvlCpMod: 0.22 } },
    116: { parentClassId: 52, name: 'Doomcryer', cp: { baseCpMax: 1679.9, lvlCpAdd: 33.93, lvlCpMod: 0.22 } },
    117: { parentClassId: 55, name: 'Fortune Seeker', cp: { baseCpMax: 2413, lvlCpAdd: 51.03, lvlCpMod: 0.22 } },
    118: { parentClassId: 57, name: 'Maestro', cp: { baseCpMax: 2634.5, lvlCpAdd: 55.68, lvlCpMod: 0.22 } }
};

function getThirdClass(classId) {
    return thirdClasses[Number(classId)] || null;
}

function expandTemplates(templates) {
    Object.entries(thirdClasses).forEach(([classId, thirdClass]) => {
        if (templates.some((template) => template.classId === Number(classId))) return;

        const parent = templates.find((template) => template.classId === thirdClass.parentClassId);
        if (!parent) throw new Error(`third-class parent template ${thirdClass.parentClassId} is missing`);

        templates.push({
            ...structuredClone(parent),
            classId: Number(classId),
            template: { ...parent.template, class: thirdClass.name }
        });
    });
}

module.exports = { thirdClasses, getThirdClass, expandTemplates };
