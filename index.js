import { openPromisified } from 'i2c-bus';
import { exit } from 'process';
import * as util from 'util';
import Vector from 'vector2js';

// var vector1 = new Vector(10, 10);
// var vector2 = new Vector(5, 5);
// console.log("result: " + vector1.add(vector2).toString());

let camAddress = 0;   // probably 88
const sensivityBlock1 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x00, 0xC0];
const sensivityBlock2 = [0x40, 0x00];

export function sleep(duration_ms) {
	return new Promise(resolve => setTimeout(resolve, duration_ms));
}

class TrackedPoint {
  index = 0;        // 0 .. 3, 0 equals 00, 1 equals 10, 2 equals 11, 3 equals 01 position
  valid = false;
  x = 0;
  y = 0;
  size = 0;

  constructor(index) { this.index = index; }
}

// name and position association po points with array indices
const TOP_LEFT_00 = 0;
const TOP_RIGHT_10 = 1;
const BOTTOM_RIGHT_11 = 2;
const BOTTOM_LEFT_01 = 3;
const SENSOR_X_MAX_PX = 1023;
const SENSOR_Y_MAX_PX = 767;

class LightGun {
  hit = false;    // when hit=true, x and y are valid
  x = 0.5;        // x and y in [0; 1], 0.5 being the center of the screen
  y = 0.5;
  orderedPoints = undefined;    // keep a persistent copy to improve performance (don't allocate memory for every clock cycle)

  constructor(trackedPoints) {
    this.orderedPoints = [...trackedPoints];    // create a copy
  }

  // get new points and copy (clone) then in the order of quadrants into the orderedPoints array
  // @return false when not enough points, true otherwise. when true, orderedPoints now contains valid data
  updatePoints(trackedPoints) {
    
    // skip when num valid (!) points < 3!!!
    let numValidPoints = 0;
    trackedPoints.array.forEach((point, index) => {
      if (point.valid) numValidPoints++;
    });

    // cancel computation and return false
    if (numValidPoints < 3) return false;
    
    // first, separate all points into 4 quadrants
    let x_c = SENSOR_X_MAX_PX;   // all points <= x_c are left, all points > x_c are right
    let y_c = SENSOR_Y_MAX_PX;   // all points <= y_c are top, all points > y_c are bottom
    
    // ----- x_c -----

    let i_min_x = 0;                      // -> index of leftmost point
    // find leftmost point index
    let x_min = SENSOR_X_MAX_PX;     // -> coordinate of leftmost point
    trackedPoints.array.forEach((point, index) => {
      if (point.valid && point.x < x_min) { i_min_x = index; x_min = point.x; }   // if more left, remember index
    });

    // find leftmost point from remaining points, excluding former leftmost point, i.e. quadrant seerator coordinate
    x_min = SENSOR_X_MAX_PX;         // -> coordinate of second leftmost point
    trackedPoints.array.forEach((point, index) => {
      if (point.valid && index != i_min_x && point.x < x_min) { x_c = point.x; }  // if more left, remember index, now as x_c
    });
    
    // ----- y_c -----

    let i_min_y = 0;                      // -> index of topmost point
    // find topmost point index
    let y_min = SENSOR_Y_MAX_PX;     // -> coordinate of topmost point
    trackedPoints.array.forEach((point, index) => {
      if (point.valid && point.y < y_min) { i_min_y = index; y_min = point.y; }   // if more on top, remember index
    });

    // find topmost point from remaining points, excluding former topmost point, i.e. quadrant seperator coordinate
    y_min = SENSOR_Y_MAX_PX;         // -> coordinate of second topmost point
    trackedPoints.array.forEach((point, index) => {
      if (point.valid && index != i_min_y && point.y < y_min) { y_c = point.y; }  // if more on top, remember index, now as y_c
    });

    // ----- orderedPoints array -----

    // build orderedPoints array with points at the right location, from 00 to 10 to 11 to 01
    trackedPoints.array.forEach((point, index) => {
      
      let orderedIndex = 0;
      // decide which quadrant the point is in
      if (point.x <= c_x) {   // LEFT
        if (point.y <= y_c) orderedIndex = TOP_LEFT_00;   // TOP
        else orderedIndex = BOTTOM_LEFT_01;   // BOTTOM
      }
      else {    // RIGHT
        if (point.y <= y_c) orderedIndex = TOP_RIGHT_10;   // TOP
        else orderedIndex = BOTTOM_RIGHT_11;   // BOTTOM
      }

      // create a cloned copy (ahem... a pleonasm... https://en.wikipedia.org/wiki/Pleonasm) at the right position
      this.orderedPoints[orderedIndex] = structuredClone(point);
    });

    return true;    // orderedPoints now valid
  }

  // does the heavy computation of current light points detected to screen position
  compute() {

  }
}

let trackedPoints = new Array(4).fill().map((value, index) => { return new TrackedPoint(index); })

try {
  console.log("Opening i2c bus...");
  const bus = await openPromisified(1);

  //let i2cFuncs = await bus.i2cFuncs();
  //console.log("available functions:", i2cFuncs);

  console.log("Scanning for i2c devices...");
  let devices = await bus.scan();

  console.log("i2c devices:", util.inspect(devices));

  if (devices && devices.length > 0) camAddress = devices[0];   // grad first address
  if (camAddress == 0) process.exit(1);

  console.log("initializing IR cam at adress", camAddress, "...");
  
  await bus.writeByte(camAddress, 0x30, 0x01);  //
  await bus.writeByte(camAddress, 0x30, 0x08);
  await bus.writeI2cBlock(camAddress, 0x00, sensivityBlock1.length, Buffer.from(sensivityBlock1));
  await bus.writeI2cBlock(camAddress, 0x1A, sensivityBlock2.length, Buffer.from(sensivityBlock2));
  await bus.writeByte(camAddress, 0x33, 0x03);  // select mode: 1, 3 or 5
  await bus.writeByte(camAddress, 0x30, 0x08);

  console.log("ready.");

  let data = Buffer.alloc(12);
  
  console.log("Reading positions...");
  while (true) {
    await bus.sendByte(camAddress, 0x36);
    console.log(await bus.receiveByte(camAddress));   // always 0???? skip it
    let dataLen = await bus.i2cRead(camAddress, 12, data);
    console.log(util.inspect(dataLen));

    // see https://wiibrew.org/wiki/Wiimote#Data_Formats
    trackedPoints[0].valid = data[0] != 0xFF;
    trackedPoints[0].x = data[0] + ((data[2] & 0x30) << 4);
    trackedPoints[0].y = data[1] + ((data[2] & 0xC0) << 2);
    trackedPoints[0].size = data[2] & 0x0F;

    trackedPoints[1].valid = data[3] != 0xFF;
    trackedPoints[1].x = data[3] + ((data[5] & 0x30) << 4);
    trackedPoints[1].y = data[4] + ((data[5] & 0xC0) << 2);
    trackedPoints[1].size = data[5] & 0x0F;

    trackedPoints[2].valid = data[6] != 0xFF;
    trackedPoints[2].x = data[6] + ((data[8] & 0x30) << 4);
    trackedPoints[2].y = data[7] + ((data[8] & 0xC0) << 2);
    trackedPoints[2].size = data[8] & 0x0F;

    trackedPoints[3].valid = data[9] != 0xFF;
    trackedPoints[3].x = data[9] + ((data[11] & 0x30) << 4);
    trackedPoints[3].y = data[10] + ((data[11] & 0xC0) << 2);
    trackedPoints[3].size = data[11] & 0x0F;

    console.log(trackedPoints);

    await sleep(1000);
  }
}
catch (err) {
  if (err) console.log("i2c error:", err);
}

// TODO
// bus.close(err => {
//   if (err) throw err;
// });