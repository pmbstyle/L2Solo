const GEAR_FOCUS_LEVEL = 5;
const D_GRADE_LEVEL = 20;

function levelOf(state = {}) {
    return Math.max(1, Number(state.level || 1));
}

function phaseFor(state = {}) {
    const level = levelOf(state);
    if (level < GEAR_FOCUS_LEVEL) return 'starter';
    if (level < D_GRADE_LEVEL) return 'no_grade_focus';
    return 'grade_progression';
}

function isGearFocusActive(state = {}) {
    return levelOf(state) >= GEAR_FOCUS_LEVEL;
}

function allowsCrafting(state = {}) {
    return levelOf(state) >= D_GRADE_LEVEL;
}

function slotPriority(slot) {
    const value = Number(slot || 0);
    if ([7, 14].includes(value)) return 3;
    if ([6, 8, 9, 10, 11, 12, 15].includes(value)) return 2;
    if ([1, 2, 3, 4, 5].includes(value)) return 1;
    return 0;
}

module.exports = { GEAR_FOCUS_LEVEL, D_GRADE_LEVEL, phaseFor, isGearFocusActive, allowsCrafting, slotPriority };
