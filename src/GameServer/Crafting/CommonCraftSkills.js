const REQUIRED_LEVELS = Object.freeze([5, 20, 28, 36, 43, 49, 55, 62, 70]);

function levelForCharacter(characterLevel) {
    const level = Number(characterLevel) || 0;
    return REQUIRED_LEVELS.filter((requiredLevel) => level >= requiredLevel).length;
}

function automaticSkills(characterLevel) {
    const craftLevel = levelForCharacter(characterLevel);
    return [
        { selfId: 1322, level: 1 },
        ...(craftLevel > 0 ? [{ selfId: 1320, level: craftLevel }] : [])
    ];
}

module.exports = {
    automaticSkills,
    levelForCharacter
};
