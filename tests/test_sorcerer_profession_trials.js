require('./helpers/remainingProfessionHarness').runRoute(12).catch(error => {
    console.error(error); process.exitCode = 1;
});
