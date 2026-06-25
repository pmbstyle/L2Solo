module.exports = {
    name: "Talking Island Town",
    region: "17_25",
    walls: [
        { type: "horizontal", y: 243227, minX: -85400, maxX: -83150, gateX: -84081, gateWidth: 300 },
        { type: "horizontal", y: 245800, minX: -85400, maxX: -83150, gateX: -84318, gateWidth: 300 },
        { type: "vertical", x: -85400, minY: 243227, maxY: 245800, gateY: 244579, gateWidth: 300 },
        { type: "vertical", x: -83150, minY: 243227, maxY: 245800, gateY: 244579, gateWidth: 300 }
    ],
    buildings: [
        { type: "circle", x: -84318, y: 244579, r: 250 }, // Center Obelisk (Solid)
        { type: "box_door", minX: -84200, maxX: -83400, minY: 243400, maxY: 244200, doorWall: 'S', doorMin: -83920, doorMax: -83680 }, // NE Temple (South Door)
        { type: "box_door", minX: -85150, maxX: -84450, minY: 243650, maxY: 244350, doorWall: 'E', doorMin: 243920, doorMax: 244080 }, // NW Building (East Door)
        { type: "box_door", minX: -85250, maxX: -84550, minY: 244750, maxY: 245450, doorWall: 'E', doorMin: 245020, doorMax: 245180 }, // SW Building (East Door)
        { type: "box_door", minX: -84050, maxX: -83350, minY: 244750, maxY: 245450, doorWall: 'W', doorMin: 245020, doorMax: 245180 }  // SE Building (West Door)
    ]
};
