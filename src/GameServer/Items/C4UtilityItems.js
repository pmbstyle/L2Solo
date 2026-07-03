const UTILITY_ITEMS = {
    1665: { handler: 'WorldMap' },
    1863: { handler: 'WorldMap' },
    4393: { handler: 'Calculator' },
    4625: { handler: 'RollingDice' },
    4626: { handler: 'RollingDice' },
    4627: { handler: 'RollingDice' },
    4628: { handler: 'RollingDice' },
    5707: { handler: 'SevenSignsRecord' },
    5588: { handler: 'Book' },
    6317: { handler: 'Book' },
    7063: { handler: 'Book' },
    7064: { handler: 'Book' },
    7065: { handler: 'Book' },
    7066: { handler: 'Book' },
    7082: { handler: 'Book' },
    7083: { handler: 'Book' },
    7084: { handler: 'Book' },
    7085: { handler: 'Book' },
    7086: { handler: 'Book' },
    7087: { handler: 'Book' },
    7088: { handler: 'Book' },
    7089: { handler: 'Book' },
    7090: { handler: 'Book' },
    7091: { handler: 'Book' },
    7092: { handler: 'Book' },
    7093: { handler: 'Book' },
    7094: { handler: 'Book' },
    7095: { handler: 'Book' },
    7096: { handler: 'Book' },
    7097: { handler: 'Book' },
    7098: { handler: 'Book' },
    7099: { handler: 'Book' },
    7100: { handler: 'Book' },
    7101: { handler: 'Book' },
    7102: { handler: 'Book' },
    7103: { handler: 'Book' },
    7104: { handler: 'Book' },
    7105: { handler: 'Book' },
    7106: { handler: 'Book' },
    7107: { handler: 'Book' },
    7108: { handler: 'Book' },
    7109: { handler: 'Book' },
    7110: { handler: 'Book' },
    7111: { handler: 'Book' },
    7112: { handler: 'Book' },
    7561: { handler: 'Book' }
};

function resolve(selfId) {
    return UTILITY_ITEMS[Number(selfId)] || null;
}

module.exports = {
    UTILITY_ITEMS,
    resolve
};
