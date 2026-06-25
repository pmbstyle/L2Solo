module.exports = {
    name: "Gludio Town",
    region: "19_21",
    
    // Developer: Add custom virtual obstacles below to prevent bots from walking through solid structures.
    // Use the coordinates from the map/game client to define town walls and buildings with doors.
    
    walls: [
        // Example horizontal wall with a gate:
        // { type: "horizontal", y: 122776, minX: -15000, maxX: -10000, gateX: -12672, gateWidth: 300 }
    ],
    
    buildings: [
        // Example building with a door:
        // { type: "box_door", minX: -13000, maxX: -12500, minY: 122000, maxY: 122500, doorWall: 'S', doorMin: -12800, doorMax: -12700 }
    ]
};
