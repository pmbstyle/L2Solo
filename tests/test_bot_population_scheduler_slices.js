const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originalSliceMs = Config.schedulerSliceMs;
const originalYield = PopulationService.yieldSchedulerSlice;

async function run() {
    const values = [];
    const yields = [];
    Config.schedulerSliceMs = 1;
    PopulationService.yieldSchedulerSlice = async (startedAt) => {
        yields.push(Date.now() - startedAt);
    };

    const results = await PopulationService.runInSchedulerSlices([1, 2, 3], async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        values.push(value);
        return value * 2;
    });

    assert.deepStrictEqual(values, [1, 2, 3], 'scheduler work must stay ordered');
    assert.deepStrictEqual(results, [2, 4, 6], 'scheduler work results must be retained');
    assert.strictEqual(yields.length, 3, 'each over-budget scheduler slice must yield before more work');
    console.log('Bot population scheduler slice checks passed');
}

run()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        Config.schedulerSliceMs = originalSliceMs;
        PopulationService.yieldSchedulerSlice = originalYield;
    });
