const UTILITY_ITEMS = {
    1665: { handler: 'WorldMap' },
    1863: { handler: 'WorldMap' },
    4393: { handler: 'Calculator' },
    4625: { handler: 'RollingDice' },
    4626: { handler: 'RollingDice' },
    4627: { handler: 'RollingDice' },
    4628: { handler: 'RollingDice' }
};

function resolve(selfId) {
    return UTILITY_ITEMS[Number(selfId)] || null;
}

module.exports = {
    UTILITY_ITEMS,
    resolve
};
