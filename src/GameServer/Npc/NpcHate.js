// Whom an NPC attacks: one rule for the live hate table (Npc.aggroList) and the
// cold party fight (BackgroundResolver.resolvePartyFight).
// Lisvus L2Attackable: a hit adds its damage as hate; an actor that engages
// without hate gets one point; the NPC attacks the entry with the most hate
// above zero, the earliest entry on a tie.
// Cold differences: a living tank holds the mob (the hot tank takes it back with
// Aggression), and self-buff aggroPoints (C4SkillEffects.applyAggroPoints) add no
// cold hate, as cold charge and buff turns hit nothing.
const ENGAGE_HATE = 1;

function fromDamage(damage) {
    return Math.max(0, Number(damage) || 0);
}

// An event that carries no hate still registers its actor with one point.
function add(hate, aggro) {
    return hate + aggro + (aggro === 0 ? ENGAGE_HATE : 0);
}

function mostHated(entries) {
    let best = null;
    let maxHate = 0;
    for (const entry of entries) {
        if (entry.hate > maxHate) {
            best = entry;
            maxHate = entry.hate;
        }
    }
    return best;
}

module.exports = { ENGAGE_HATE, fromDamage, add, mostHated };
