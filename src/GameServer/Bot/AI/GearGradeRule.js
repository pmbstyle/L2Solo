// The gear grade a character level is expected to wear (C4: D from 20, C from 40, B from 52, A from 61, S from 76).
const GRADE_LEVELS = Object.freeze({ d: 20, c: 40, b: 52, a: 61, s: 76 });
// Grades in wear order, from 'none' (level 1): the hunt tables' kit ladders read it (scripts/hunt-tables).
const GRADES = Object.freeze(['none', ...Object.keys(GRADE_LEVELS)]);

function gradeForLevel(level) {
    const value = Number(level || 1);
    if (value >= GRADE_LEVELS.s) return 's';
    if (value >= GRADE_LEVELS.a) return 'a';
    if (value >= GRADE_LEVELS.b) return 'b';
    if (value >= GRADE_LEVELS.c) return 'c';
    if (value >= GRADE_LEVELS.d) return 'd';
    return 'none';
}

// A grade's place in the wear order ('none' 0 .. 's' 5); 0 for anything else.
function rankOf(grade) {
    const rank = GRADES.indexOf(String(grade || 'none').toLowerCase());
    return rank < 0 ? 0 : rank;
}

// The first level that wears a grade ('none' from level 1).
function levelForGrade(grade) {
    return GRADE_LEVELS[grade] || 1;
}

module.exports = { GRADES, rankOf, gradeForLevel, levelForGrade };
