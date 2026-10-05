// Lisvus fdc7e33a Q213; historical C4 37a3ec95 awards eight diamonds once.
const rows = [
    [1,7064,2,[[2647,1]],[[2648,1]]], [2,7064,3,[[2648,1],[2653,1]],[[2649,1]]],
    [3,7064,4,[[2649,1],...[2654,2655,2656,2657].map(i=>[i,1])],[[2650,1],[2658,1]]],
    [4,7684,5,[[2650,1]],[[2651,1]]], [5,7064,6,[[2651,1]],[[2652,1]]],
    [6,7684,7,[[2652,1],[2658,1]],[[2659,1]]], [7,7684,8,[[2659,1],[2660,10]],[[2661,1],[2662,1]]],
    [8,7715,9,[[2661,1],[2662,1]],[[2663,1]]], [9,7526,10,[[2663,1]],[[2664,1]]],
    [10,7715,11,[[2664,1]],[[2665,1]]],
    [12,7064,13,[[2666,1]],[[2667,1]],{minLevel:36}],
    [13,7064,14,[[2667,1],...[2668,2669,2670,2671].map(i=>[i,1])],[[2672,1]]],
    [14,7106,0,[[2672,1]],[[2673,1],[7562,8]]]
];
module.exports = require('../TrialJourney')({
    id:213, name:'Trial of the Seeker', startNpc:7106, npcs:[7106,7064,7684,7715,7526],
    clientCondition: () => 1, // C4 uses items to track the journey within cond 1.
    eligible:s=>s.session.actor.fetchLevel()>=35 && [7,22,35].includes(s.session.actor.fetchClassId()),
    intro:'Dufner in Giran sends you to Terry in Dion to investigate dark bezoars and their hosts.', startItems:[[2647,1]],
    questItems:Array.from({length:26},(_,i)=>2647+i), exp:72126,sp:11000,
    rows:s=>[...rows,[11,7064,s.session.actor.fetchLevel()<36?12:13,[[2665,1]],[[s.session.actor.fetchLevel()<36?2666:2667,1]]]],
    note:s=>[11,12].includes(s.getInt('cond'))?'<br>Terry requires level 36 to identify the hosts.':'',
    drops:[[2,198,2653,1,10],[3,211,2654,1,25],[3,495,2655,1,25],[3,80,2656,1,25],[3,249,2657,1,25],
        [7,158,2660,10,30],[13,234,2668,1,25],[13,270,2669,1,25],[13,88,2670,1,25],[13,580,2671,1,25]]
});
