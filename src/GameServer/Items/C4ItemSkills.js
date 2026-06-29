const ITEM_SKILLS = {
    65: { skillId: 2001, level: 1, consume: true },
    725: { skillId: 2002, level: 1, consume: true },
    726: { skillId: 2003, level: 1, consume: true },
    727: { skillId: 2032, level: 1, consume: true },
    728: { skillId: 2005, level: 1, consume: true },
    734: { skillId: 2011, level: 1, consume: true },
    735: { skillId: 2012, level: 1, consume: true },
    736: { skillId: 2013, level: 1, consume: true, teleport: 'town' },
    1060: { skillId: 2031, level: 1, consume: true },
    1061: { skillId: 2032, level: 1, consume: true },
    1062: { skillId: 2033, level: 1, consume: true },
    1073: { skillId: 2031, level: 1, consume: true },
    1374: { skillId: 2034, level: 1, consume: true },
    1375: { skillId: 2035, level: 1, consume: true },
    1538: { skillId: 2036, level: 1, consume: true, teleport: 'town' },
    1539: { skillId: 2037, level: 1, consume: true },
    1540: { skillId: 2038, level: 1, consume: true },
    1831: { skillId: 2042, level: 1, consume: true },
    1832: { skillId: 2043, level: 1, consume: true },
    1833: { skillId: 2044, level: 1, consume: true },
    1834: { skillId: 2045, level: 1, consume: true },
    3889: { skillId: 2060, level: 1, consume: true },
    3926: { skillId: 2050, level: 1, consume: true },
    3927: { skillId: 2051, level: 1, consume: true },
    3928: { skillId: 2052, level: 1, consume: true },
    3929: { skillId: 2053, level: 1, consume: true },
    3930: { skillId: 2054, level: 1, consume: true },
    3931: { skillId: 2055, level: 1, consume: true },
    3932: { skillId: 2056, level: 1, consume: true },
    3933: { skillId: 2057, level: 1, consume: true },
    3934: { skillId: 2058, level: 1, consume: true },
    3935: { skillId: 2059, level: 1, consume: true },
    3958: { skillId: 2036, level: 2, consume: true, teleport: 'town' },
    4218: { skillId: 2064, level: 1, consume: true },
    4411: { skillId: 2069, level: 1, consume: true },
    4412: { skillId: 2068, level: 1, consume: true },
    4413: { skillId: 2070, level: 1, consume: true },
    4414: { skillId: 2072, level: 1, consume: true },
    4415: { skillId: 2071, level: 1, consume: true },
    4416: { skillId: 2073, level: 1, consume: true },
    4417: { skillId: 2067, level: 1, consume: true },
    5010: { skillId: 2066, level: 1, consume: true },
    6403: { skillId: 2023, level: 1, consume: true },
    6406: { skillId: 2024, level: 1, consume: true },
    6407: { skillId: 2025, level: 1, consume: true },
    7061: { skillId: 2073, level: 1, consume: true }
};

function resolve(selfId) {
    return ITEM_SKILLS[Number(selfId)] || null;
}

module.exports = {
    ITEM_SKILLS,
    resolve
};
