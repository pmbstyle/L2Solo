require('./helpers/remainingProfessionHarness').runRoute(41).catch(error => {
    console.error(error); process.exitCode = 1;
});
