require('./helpers/remainingProfessionHarness').runRoute(27).catch(error => {
    console.error(error); process.exitCode = 1;
});
