// C4 beginner-shot reward eligibility and receipt.
//
// Source: MOBIUS_C4 6674a607. Player.java persists a `newbie` flag decided once,
// at character creation, from `ALT_GAME_NEW_CHAR_ALWAYS_IS_NEWBIE || account has
// no other character`, and isNewbie() re-applies the override at read time.
// The imported Q257/260/265/273/293 bounties grant 6000 soulshots or 3000
// spiritshots once per character. Existing starter quests retain their own
// reward behavior and do not use this counter.
//
// L2Solo has no historical equivalent of the flag, so characters created before
// the migration are recorded as UNKNOWN rather than guessed from their level or
// current ammunition. General.newbieRewardPolicy decides what UNKNOWN means.

const SOULSHOT = 5789;
const SPIRITSHOT = 5790;

const ELIGIBLE = 1;
const NOT_ELIGIBLE = 0;
const UNKNOWN = -1;

// Mystic base classes in C4. Orc mystics are deliberately excluded by the quests
// that pass `orcUsesSoulshots`, matching the reference's isMageClass() && !ORC.
const MAGE_CLASS_IDS = new Set([10, 11, 12, 13, 14, 15, 16, 17, 25, 26, 27, 28, 29, 30,
    38, 39, 40, 41, 42, 43, 49, 50, 51, 52]);
const ORC_RACE = 3;

function policy() {
    const configured = String(options.default.General?.newbieRewardPolicy ?? 'strict').toLowerCase();
    return ['strict', 'grant', 'always'].includes(configured) ? configured : 'strict';
}

// isNewbie(): the stored flag, with the server override applied at read time.
function isEligible(actor) {
    const mode = policy();
    if (mode === 'always') return true;
    const flag = Number(actor.fetchNewbie?.() ?? actor.newbie ?? UNKNOWN);
    if (flag === ELIGIBLE) return true;
    if (flag === NOT_ELIGIBLE) return false;
    return mode === 'grant';
}

function isMage(actor, orcUsesSoulshots) {
    if (orcUsesSoulshots && Number(actor.fetchRace?.() ?? actor.race) === ORC_RACE) return false;
    return MAGE_CLASS_IDS.has(Number(actor.fetchClassId?.() ?? actor.classId));
}

// The grant a quest should add to its own reward transaction, or null. The
// caller commits the items and the incremented counter together, so a crash can
// never hand out beginner shots without recording that it did.
function plan(actor, { threshold, soulshots, spiritshots = 0, orcUsesSoulshots = false }) {
    if (!isEligible(actor)) return null;
    const received = Math.max(0, Number(actor.fetchNewbieShotsReceived?.() ?? actor.newbieShotsReceived ?? 0));
    if (received >= threshold) return null;
    const mage = spiritshots > 0 && isMage(actor, orcUsesSoulshots);
    return {
        items: [[mage ? SPIRITSHOT : SOULSHOT, mage ? spiritshots : soulshots]],
        received: received + 1,
        voice: mage ? 'tutorial_voice_027' : 'tutorial_voice_026'
    };
}

// Eligibility is decided once, at creation, exactly as the reference does.
function flagForNewCharacter(existingCharactersOnAccount) {
    if (policy() === 'always') return ELIGIBLE;
    return Number(existingCharactersOnAccount) === 0 ? ELIGIBLE : NOT_ELIGIBLE;
}

module.exports = {
    SOULSHOT, SPIRITSHOT, ELIGIBLE, NOT_ELIGIBLE, UNKNOWN,
    policy, isEligible, isMage, plan, flagForNewCharacter
};
