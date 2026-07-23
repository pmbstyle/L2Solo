// Generated population names use readable CamelCase pairs.  The account id
// remains the durable technical identity; display names should look like
// player nicknames rather than a syllable hash with a collision suffix.
const GIVEN_NAMES = [
    'Aelina', 'Aerin', 'Alira', 'Amara', 'Arlen', 'Arwyn', 'Asher', 'Astrid',
    'Brenna', 'Brina', 'Caelan', 'Carys', 'Cedric', 'Celine', 'Corin', 'Cyra',
    'Daria', 'Dorian', 'Eira', 'Elara', 'Elian', 'Elora', 'Emrys', 'Eryn',
    'Faris', 'Fenna', 'Galen', 'Garen', 'Halen', 'Ilyra', 'Irena', 'Isolde',
    'Jaren', 'Kaela', 'Kieran', 'Liora', 'Lucan', 'Lyra', 'Maelin', 'Mara',
    'Nadia', 'Naren', 'Neris', 'Orin', 'Raina', 'Riven', 'Rowan', 'Sable',
    'Seren', 'Silas', 'Sylva', 'Talia', 'Taren', 'Thalia', 'Torin', 'Vaela',
    'Valen', 'Varyn', 'Vela', 'Wren', 'Xara', 'Yara', 'Zorin'
];

const BYNAMES = [
    'Amber', 'Arbor', 'Ash', 'Birch', 'Bloom', 'Bramble', 'Bright', 'Brook',
    'Cedar', 'Cinder', 'Cloud', 'Clover', 'Coast', 'Crest', 'Dawn', 'Drift',
    'Dusk', 'Echo', 'Ember', 'Falcon', 'Fern', 'Field', 'Flame', 'Frost',
    'Gale', 'Glimmer', 'Grove', 'Harbor', 'Haven', 'Hearth', 'Hill', 'Ivy',
    'Juniper', 'Lake', 'Lantern', 'Lark', 'Light', 'Linden', 'Maple', 'Marsh',
    'Meadow', 'Mist', 'Moon', 'Moss', 'Night', 'North', 'Oak', 'Onyx', 'Pearl',
    'Quartz', 'Rain', 'Raven', 'Reed', 'Ridge', 'River', 'Rose', 'Rowan',
    'Rune', 'Saffron', 'Sage', 'Sand', 'Shore', 'Silver', 'Sky', 'Snow', 'Sol',
    'Sparrow', 'Spring', 'Star', 'Stone', 'Storm', 'Summer', 'Thorn', 'Tide',
    'Umber', 'Vale', 'Velvet', 'Vesper', 'Wave', 'West', 'Wild', 'Willow',
    'Wind', 'Winter', 'Wisp', 'Wolf', 'Wood'
];

const NAME_SPACE = GIVEN_NAMES.length * BYNAMES.length;

function normalizedIndex(value) {
    const parsed = Math.trunc(Number(value) || 0);
    // 7919 is coprime with the 5,481 available pairs.  This keeps the mapping
    // one-to-one while spreading adjacent population slots across surnames.
    return Number((BigInt(Math.abs(parsed)) * 7919n) % BigInt(NAME_SPACE));
}

function nameFor(index) {
    const slot = normalizedIndex(index);
    const given = GIVEN_NAMES[slot % GIVEN_NAMES.length];
    const byname = BYNAMES[Math.floor(slot / GIVEN_NAMES.length)];
    return `${given}${byname}`;
}

module.exports = { nameFor };
