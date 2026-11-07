'use strict';
// Table 8's death correction: real / formula deaths, 0 when the real hunt
// has none (not 1, which kept the formula's deaths), 1 when the formula has none.
const assert = require('node:assert/strict');
const K = require('../scripts/hunt-tables/corrections');
const row = (danger, real, formula) => K.FIELDS.map(field => ({ rotKind: 'melee', danger, half: 0, realKph: 60,
    formulaKph: 50, realDeathsPerHour: real, formulaDeathsPerHour: formula }[field] ?? 0));
const fit = K.fit([row('safe', 0, 2), row('safe', 0, 1), row('risky', 1, 4), row('risky', 1, 0), row('none', 1, 0)]);
assert.equal(fit['melee|safe'][1], 0, 'no real deaths: the formula deaths go');
assert.equal(fit['melee|risky'][1], 0.5, 'ratio of sums');
assert.equal(fit['melee|none'][1], 1, 'no formula deaths: nothing to scale');
assert.equal(fit['melee|safe'][0], 1.2, 'kills: median of real / formula');
console.log('PASS hunt corrections death fit');
