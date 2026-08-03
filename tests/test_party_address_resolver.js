const assert = require('assert');

require('../src/Global');

const PartyAddressResolver = invoke('GameServer/Bot/AI/PartyAddressResolver');

function candidate(id, name) {
    return { id, name };
}

async function main() {
    const nice = candidate(1, 'NiceBot');
    const nico = candidate(2, 'Nicolas');

    let result = PartyAddressResolver.resolve('NiceBot, start pulling.', [nice, nico]);
    assert.strictEqual(result.status, 'matched');
    assert.strictEqual(result.candidate, nice);
    assert.strictEqual(result.matchType, 'full_name');

    result = PartyAddressResolver.resolve('Nice, now you are on pull.', [nice, nico]);
    assert.strictEqual(result.status, 'matched');
    assert.strictEqual(result.candidate, nice);
    assert.strictEqual(result.matchType, 'unique_prefix');

    result = PartyAddressResolver.resolve('hey Nico, hold here.', [nice, nico]);
    assert.strictEqual(result.status, 'matched');
    assert.strictEqual(result.candidate, nico);

    result = PartyAddressResolver.resolve('Nic, hold here.', [nice, nico]);
    assert.strictEqual(result.status, 'none', 'prefixes shorter than four characters must not auto-route');

    const nimbus = candidate(3, 'Nimbus');
    result = PartyAddressResolver.resolve('Nice, check the spot.', [nice, nimbus]);
    assert.strictEqual(result.status, 'matched');
    assert.strictEqual(result.candidate, nice);

    const arina = candidate(4, 'Arina');
    const arion = candidate(5, 'Arinor');
    result = PartyAddressResolver.resolve('Arin, regroup.', [arina, arion]);
    assert.strictEqual(result.status, 'ambiguous');
    assert.deepStrictEqual(result.matches, [arina, arion]);

    result = PartyAddressResolver.resolve('the weather is nice today', [nice]);
    assert.strictEqual(result.status, 'none', 'common words must not become a bot address');

    console.log('Party address resolver checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
