const assert = require('assert');

const UiLanguage = require('../src/WorldObserver/public/uiLanguage');

assert.strictEqual(UiLanguage.label('reason', 'clan_equipment_market'), 'Buying clan gear');
assert.strictEqual(UiLanguage.label('reason', 'party_not_ready'), 'Party not ready');
assert.strictEqual(UiLanguage.label('event', 'action_succeeded'), 'Action completed');
assert.strictEqual(UiLanguage.label('status', 'executing'), 'In progress');
assert.strictEqual(UiLanguage.label('plan', 'goal_plan'), 'Goal planning');
assert.strictEqual(UiLanguage.label('strategy', 'direct_drop'), 'Direct drop');
assert.strictEqual(UiLanguage.label('reason', 'future_runtime_code'), 'Future runtime code',
    'unknown runtime codes must still be readable');
assert.strictEqual(UiLanguage.humanize('partyWait'), 'Party wait');
assert.strictEqual(UiLanguage.humanize('Hound Dog of Hallate fields'), 'Hound Dog of Hallate fields',
    'already readable world names must preserve their casing');
assert.strictEqual(UiLanguage.humanize('EXP'), 'EXP');
assert.strictEqual(UiLanguage.label('reason', null), '—');

console.log('World observer UI language checks passed');
