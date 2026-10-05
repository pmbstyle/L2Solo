require('./helpers/remainingProfessionHarness').runRoute(8).catch(error => {
    console.error(error); process.exitCode = 1;
});
