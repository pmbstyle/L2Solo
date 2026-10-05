require('./helpers/remainingProfessionHarness').runRoute(23).catch(error => {
    console.error(error); process.exitCode = 1;
});
