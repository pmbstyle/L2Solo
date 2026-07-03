const UTILITY_ITEMS = {
    1665: { handler: 'WorldMap' },
    1863: { handler: 'WorldMap' },
    4393: { handler: 'Calculator' }
};

function resolve(selfId) {
    return UTILITY_ITEMS[Number(selfId)] || null;
}

module.exports = {
    UTILITY_ITEMS,
    resolve
};
