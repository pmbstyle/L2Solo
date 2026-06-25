module.exports = {
    name: "Giran Town",
    region: "22_22",
    
    // Developer: Add custom virtual obstacles below to prevent bots from walking through solid structures.
    // Use the coordinates from the map/game client to define town walls and buildings with doors.
    
    walls: [
        // Example:
        // { type: "horizontal", y: 147943, minX: 81000, maxX: 85000, gateX: 83400, gateWidth: 300 }
    ],
    
    buildings: [
        // Example:
        // { type: "box_door", minX: 83000, maxX: 83500, minY: 147000, maxY: 147500, doorWall: 'E', doorMin: 147200, doorMax: 147300 }
    ]
};
