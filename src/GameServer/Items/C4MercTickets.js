const NPC_IDS = [12301, 12302, 12303, 12304, 12305, 12306, 12307, 12308, 12309, 12310];

const MERC_MESSAGES = [
    'To arms!.',
    'I am ready to serve you my lord when the time comes.',
    'You summon me.'
];

const CASTLE_GROUPS = [
    { castleId: 1, firstItemId: 3960, typeLimit: 10, castleLimit: 50 },
    { castleId: 2, firstItemId: 3973, typeLimit: 15, castleLimit: 75 },
    { castleId: 3, firstItemId: 3986, typeLimit: 10, castleLimit: 100 },
    { castleId: 4, firstItemId: 3999, typeLimit: 10, castleLimit: 150 },
    { castleId: 5, firstItemId: 4012, typeLimit: 20, castleLimit: 200 },
    { castleId: 6, firstItemId: 5205, typeLimit: 20, castleLimit: 200 },
    { castleId: 7, firstItemId: 6779, typeLimit: 20, castleLimit: 200 }
];

const MERC_TICKETS = {};

CASTLE_GROUPS.forEach((group) => {
    NPC_IDS.forEach((npcId, typeIndex) => {
        const selfId = group.firstItemId + typeIndex;
        MERC_TICKETS[selfId] = {
            handler: 'MercTicket',
            castleId: group.castleId,
            npcId,
            typeIndex,
            typeLimit: group.typeLimit,
            castleLimit: group.castleLimit,
            minDistance: 25,
            messages: MERC_MESSAGES
        };
    });
});

function resolve(selfId) {
    return MERC_TICKETS[Number(selfId)] || null;
}

module.exports = {
    MERC_MESSAGES,
    MERC_TICKETS,
    resolve
};
