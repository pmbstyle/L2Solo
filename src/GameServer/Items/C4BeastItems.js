const BEAST_ITEMS = {
    6643: {
        handler: 'BeastSpice',
        skillId: 2188,
        level: 1,
        consumeCount: 1,
        target: 'feedableBeast'
    },
    6644: {
        handler: 'BeastSpice',
        skillId: 2189,
        level: 1,
        consumeCount: 1,
        target: 'feedableBeast'
    },
    6645: {
        handler: 'BeastSoulShot',
        skillId: 2033,
        level: 1,
        charge: 'soulshot'
    },
    6646: {
        handler: 'BeastSpiritShot',
        skillId: 2008,
        level: 1,
        charge: 'spiritshot',
        blessed: false
    },
    6647: {
        handler: 'BeastSpiritShot',
        skillId: 2009,
        level: 1,
        charge: 'spiritshot',
        blessed: true
    }
};

function resolve(selfId) {
    return BEAST_ITEMS[Number(selfId)] || null;
}

module.exports = {
    BEAST_ITEMS,
    resolve
};
