'use strict';
const assert = require('node:assert/strict');
const { ColdOccupationPlanner } = require('../src/GameServer/Bot/Population/ColdOccupationPlanner');

function drain(planner) {
    let portions = 0;
    while (planner.waiting.size || planner.ready.size) {
        assert(++portions < 100, 'completion must not leave obsolete work scheduled');
        planner.portion();
    }
}

(async () => {
    const publicationError = Error('original_publication_failure'), errors = [], publications = [];
    const planner = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0,
        capture: (id, input) => input, create: input => ({ input }), step: () => true,
        result: work => ({ known: true, recipeId: work.input.recipeId }),
        publish: (id, input, value) => {
            publications.push([id, value]);
            if (id === 1) throw publicationError;
        },
        onPublishError: (...args) => errors.push(args) });
    const first = planner.request(1, { mode: 'occupation', recipeId: 25 });
    const second = planner.request(2, { mode: 'occupation', recipeId: 26 });
    assert.doesNotThrow(() => drain(planner), 'a publication error cannot finish the same owner twice');
    assert.deepEqual(await first, { known: true, recipeId: 25 });
    assert.deepEqual(await second, { known: true, recipeId: 26 });
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], publicationError, 'the original failure remains observable');
    assert.equal(errors[0][1], 1);
    assert.equal(publications.length, 2, 'each owner publishes once; another owner still progresses');
    assert.equal(planner.slots.get(1).error, publicationError.message);
    planner.finish(planner.slots.get(1), { known: false });
    assert.equal(publications.length, 2, 'completed entries cannot republish a fallback');
    planner.stop();

    // A synchronous source callback may replace the current owner while one
    // cooperative step is running. Only the new slot may continue or publish.
    let replacement, oldSteps = 0, newSteps = 0;
    const oldInput = { version: 1 }, newInput = { version: 2 }, posted = [];
    const replaced = new ColdOccupationPlanner({ schedule: () => {}, now: () => 0,
        capture: (id, input) => input, create: input => ({ input }),
        step: work => {
            if (work.input === oldInput) {
                oldSteps++;
                replacement = replaced.request(3, newInput);
                throw Error('obsolete_owner_failure');
            }
            newSteps++; return true;
        }, result: work => ({ known: true, version: work.input.version }),
        publish: (...args) => posted.push(args) });
    const obsolete = replaced.request(3, oldInput);
    assert.doesNotThrow(() => drain(replaced), 'cancelled completion cannot settle a replacement');
    assert.equal((await obsolete).known, false);
    assert.deepEqual(await replacement, { known: true, version: 2 });
    assert.equal(oldSteps, 1);
    assert.equal(newSteps, 1);
    assert.equal(posted.length, 1);
    assert.equal(posted[0][1], newInput);
    replaced.stop();
    console.log('PASS single occupation completion, original publication errors and replacement ownership');
})().catch(error => { console.error(error); process.exitCode = 1; });
