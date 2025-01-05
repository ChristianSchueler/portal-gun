import { openPromisified } from 'i2c-bus';
import { exit } from 'process';
import * as util from 'util';
import Vector from 'vector2js';
import Terminal from 'terminal-kit';
import gpiox from "@iiot2k/gpiox";

// for dfrobot IR sensor cam
const sensivityBlock1 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x00, 0xC0];
const sensivityBlock2 = [0x40, 0x00];
const SENSOR_X_MAX_PX = 1023;
const SENSOR_Y_MAX_PX = 767;

// name and position association po points with array indices
const TOP_LEFT_00 = 0;
const TOP_RIGHT_10 = 1;
const BOTTOM_RIGHT_11 = 2;
const BOTTOM_LEFT_01 = 3;

// async sleep
export function sleep(duration_ms) {
	return new Promise(resolve => setTimeout(resolve, duration_ms));
}

// holds a single point from the sensor
class TrackedPoint {
  index = 0;        // 0 .. 3, 0 equals 00, 1 equals 10, 2 equals 11, 3 equals 01 position
  valid = false;
  x = 0;
  y = 0;
  size = 0;

  constructor(index) { this.index = index; }
}

// an interface into the sensor, using i2c
class DfRobotIRSensorCam {
  trackedPoints = [];         // this always holds the latest sensor data
  data = undefined;           // Buffer holding raw data from i2c bus
  bus = undefined;            // ... speaking of... i2c bus
  camAddress = 0;     // where to speak to the cam

  // connect to i2c and configure camera
  // @return true when successful, false otherwise. async.
  async initialize() {

    console.log("Setting up DfRobotIRSensorCam...");

    console.log("Opening i2c bus...");
    this.bus = await openPromisified(1);

    //let i2cFuncs = await bus.i2cFuncs();
    //console.log("available functions:", i2cFuncs);

    console.log("Scanning for i2c devices...");
    let devices = await this.bus.scan();

    console.log("i2c devices:", util.inspect(devices));

    if (devices && devices.length > 0) this.camAddress = devices[0];   // get first address
    if (this.camAddress == 0) return false;

    console.log("initializing IR cam at address", this.camAddress, "...");
    
    await this.bus.writeByte(this.camAddress, 0x30, 0x01);
    await this.bus.writeByte(this.camAddress, 0x30, 0x08);
    await this.bus.writeI2cBlock(this.camAddress, 0x00, sensivityBlock1.length, Buffer.from(sensivityBlock1));
    await this.bus.writeI2cBlock(this.camAddress, 0x1A, sensivityBlock2.length, Buffer.from(sensivityBlock2));
    await this.bus.writeByte(this.camAddress, 0x33, 0x03);  // select mode: 1, 3 or 5, currently using mode 3, needing 12 byte buffer
    await this.bus.writeByte(this.camAddress, 0x30, 0x08);

    console.log("DfRobotIRSensorCam ready.");

    // set up internal state
    this.data = Buffer.alloc(12);
    this.trackedPoints = new Array(4).fill().map((value, index) => { return new TrackedPoint(index); });

    return true;    // success
  }

  // read data from sensor into trackedPoints
  // return true or false
  async getData() {

    if (this.bus == undefined || this.camAddress == undefined) return false;
   
    console.log("Requesting sensor data...");
    await this.bus.sendByte(this.camAddress, 0x36);

    let temp = await this.bus.receiveByte(this.camAddress);   // always 0???? skip it
    console.log("what is this for?:", temp);

    let sensorResult = await this.bus.i2cRead(this.camAddress, 12, this.data);
    console.log("sensorResult:", util.inspect(sensorResult));

    // see https://wiibrew.org/wiki/Wiimote#Data_Formats
    this.trackedPoints[0].valid = this.data[0] != 0xFF;
    this.trackedPoints[0].x = this.data[0] + ((this.data[2] & 0x30) << 4);
    this.trackedPoints[0].y = this.data[1] + ((this.data[2] & 0xC0) << 2);
    this.trackedPoints[0].size = this.data[2] & 0x0F;

    this.trackedPoints[1].valid = this.data[3] != 0xFF;
    this.trackedPoints[1].x = this.data[3] + ((this.data[5] & 0x30) << 4);
    this.trackedPoints[1].y = this.data[4] + ((this.data[5] & 0xC0) << 2);
    this.trackedPoints[1].size = this.data[5] & 0x0F;

    this.trackedPoints[2].valid = this.data[6] != 0xFF;
    this.trackedPoints[2].x = this.data[6] + ((this.data[8] & 0x30) << 4);
    this.trackedPoints[2].y = this.data[7] + ((this.data[8] & 0xC0) << 2);
    this.trackedPoints[2].size = this.data[8] & 0x0F;

    this.trackedPoints[3].valid = this.data[9] != 0xFF;
    this.trackedPoints[3].x = this.data[9] + ((this.data[11] & 0x30) << 4);
    this.trackedPoints[3].y = this.data[10] + ((this.data[11] & 0xC0) << 2);
    this.trackedPoints[3].size = this.data[11] & 0x0F;

    console.log("trackedPoints:", this.trackedPoints);

    return true;
  }
}

// does the computation from sensor data to light gun screen coordinates
class LightGun {
  hit = false;    // when hit=true, x and y are valid
  x = 0.5;        // x and y in [0; 1], 0.5 being the center of the screen
  y = 0.5;
  orderedPoints = [];    // keep a persistent copy to improve performance (don't allocate memory for every clock cycle)

  constructor() {
  }

  // get new points and copy (clone) then in the order of quadrants into the orderedPoints array
  // @return number of valid points. when >= 3, orderedPoints now contains valid data
  updatePoints(trackedPoints) {
    
    // skip when num valid (!) points < 3!!!
    let numValidPoints = 0;
    trackedPoints.forEach((point, index) => {
      if (point.valid) numValidPoints++;
    });

    console.log("Valid points:", numValidPoints);

    // cancel computation and return false
    if (numValidPoints < 3) return numValidPoints;
    
    // first, separate all points into 4 quadrants
    let x_c = SENSOR_X_MAX_PX;   // all points <= x_c are left, all points > x_c are right
    let y_c = SENSOR_Y_MAX_PX;   // all points <= y_c are top, all points > y_c are bottom
    
    // ----- x_c -----

    let i_min_x = 0;                      // -> index of leftmost point
    // find leftmost point index
    let x_min = SENSOR_X_MAX_PX;     // -> coordinate of leftmost point
    trackedPoints.forEach((point, index) => {
      if (point.valid && point.x < x_min) { i_min_x = index; x_min = point.x; }   // if more left, remember index
    });

    // find leftmost point from remaining points, excluding former leftmost point, i.e. quadrant seerator coordinate
    x_c = SENSOR_X_MAX_PX;         // -> coordinate of second leftmost point
    trackedPoints.forEach((point, index) => {
      if (point.valid && index != i_min_x && point.x < x_c) { x_c = point.x; }  // if more left, remember index, now as x_c
    });
    
    // ----- y_c -----

    let i_min_y = 0;                      // -> index of topmost point
    // find topmost point index
    let y_min = SENSOR_Y_MAX_PX;     // -> coordinate of topmost point
    trackedPoints.forEach((point, index) => {
      if (point.valid && point.y < y_min) { i_min_y = index; y_min = point.y; }   // if more on top, remember index
    });
    console.log("i_min_y=", i_min_y);

    // find topmost point from remaining points, excluding former topmost point, i.e. quadrant seperator coordinate
    y_c = SENSOR_Y_MAX_PX;         // -> coordinate of second topmost point
    trackedPoints.forEach((point, index) => {
      if (point.valid && index != i_min_y && point.y < y_c) { y_c = point.y; }  // if more on top, remember index, now as y_c
    });

    console.log("x_c, y_c=", x_c, y_c);

    // ----- orderedPoints array -----

    let quadrantUsed = [false, false, false, false];    // used for verification

    // build orderedPoints array with points at the right location, from 00 to 10 to 11 to 01
    trackedPoints.forEach((point, index) => {
      
      let orderedIndex = 0;
      // decide which quadrant the point is in
      if (point.x <= x_c) {   // LEFT
        if (point.y <= y_c) orderedIndex = TOP_LEFT_00;   // TOP
        else orderedIndex = BOTTOM_LEFT_01;   // BOTTOM
      }
      else {    // RIGHT
        if (point.y <= y_c) orderedIndex = TOP_RIGHT_10;   // TOP
        else orderedIndex = BOTTOM_RIGHT_11;   // BOTTOM
      }

      console.log("point", index, ": orderedIndex:", orderedIndex, point);

      quadrantUsed[orderedIndex] = true;

      // create a cloned copy (ahem... a pleonasm... https://en.wikipedia.org/wiki/Pleonasm) at the right position
      this.orderedPoints[orderedIndex] = structuredClone(point);
    });

    console.log("orderedPoints:", util.inspect(this.orderedPoints));

    // signal error in case the number didn't add up. room for improvement here
    if (!quadrantUsed[TOP_LEFT_00] || !quadrantUsed[TOP_RIGHT_10] || !quadrantUsed[BOTTOM_RIGHT_11] || !quadrantUsed[BOTTOM_LEFT_01]) return 0;

    return numValidPoints;    // orderedPoints now valid
  }

  // does the heavy computation of current light points detected to screen position
  compute(trackedPoints) {

    let numValidPoints = this.updatePoints(trackedPoints);

    if (numValidPoints < 3) {
      this.hit = false;
      return;
    }

    // for conveniance
    let c_0 = new Vector(SENSOR_X_MAX_PX / 2, SENSOR_Y_MAX_PX / 2);   // center of sensor camera
    let p_00 = new Vector(this.orderedPoints[TOP_LEFT_00].x, this.orderedPoints[TOP_LEFT_00].y);
    let p_10 = new Vector(this.orderedPoints[TOP_RIGHT_10].x, this.orderedPoints[TOP_RIGHT_10].y);
    let p_11 = new Vector(this.orderedPoints[BOTTOM_RIGHT_11].x, this.orderedPoints[BOTTOM_RIGHT_11].y);
    let p_01 = new Vector(this.orderedPoints[BOTTOM_LEFT_01].x, this.orderedPoints[BOTTOM_LEFT_01].y);

    if (this.orderedPoints[TOP_LEFT_00].valid && this.orderedPoints[TOP_RIGHT_10].valid && this.orderedPoints[BOTTOM_LEFT_01].valid) {

      // create vectors spanning "points plane"
      let c_00 = c_0.sub(p_00);
      let u_00 = p_10.sub(p_00);
      let v_00 = p_01.sub(p_00);

      // compute screen coordinates in 0..1 space
      let u = c_00.dot(u_00.normalize()) / u_00.length();   // project c onto u and scale to length of u, so we do not use pixels any more
      let v = c_00.dot(v_00.normalize()) / v_00.length();   // project c onto v and scale to length of v, so we do not use pixels any more

      this.hit = (u >= 0 && u <= 1 && v >= 0 && v <= 1);
      this.x = u;
      this.y = v;
    }
    else console.log('not yet implemented');
  }

}

// ----- main -----

console.log("Opening GPIO...");
//console.log(util.inspect(gpiox));
//gpiox.init_gpio(4, gpiox.GPIO_MODE_INPUT_NOPULL, 10);

gpiox.watch_gpio(4, gpiox.GPIO_MODE_INPUT_NOPULL, 10, gpiox.GPIO_EDGE_BOTH, (state, edge, pin) => {
  console.log(state, edge, pin);
});

setTimeout(() => {
  gpiox.set_gpio(20, 0);
  gpiox.deinit_gpio(20);
}, 3000);

//const gpio4 = new Gpio(4, 'in', 'both');
//gpio4.watch((err, value) => {
//  console.log(err, value);
//});

console.log("done.");

await sleep(60*1000);

const sensor = new DfRobotIRSensorCam();
const lightGun = new LightGun();

try {
  
  let ok = await sensor.initialize();
  if (!ok) { console.log("no sensor found! exiting."); process.exit(1); }

  Terminal.terminal.clear();

  while (true) {

    // temp
    Terminal.terminal.moveTo(1, 1);

    await sensor.getData();
    lightGun.compute(sensor.trackedPoints);

    console.log("Lightgun: ", lightGun.hit, lightGun.x.toFixed(2), lightGun.y.toFixed(2));

    await sleep(100);
  }
}
catch (err) {
  if (err) console.log("Generic error:", err);
}

// TODO
// bus.close(err => {
//   if (err) throw err;
// });

process.on('SIGINT', () => { console.log("SIGINT"); });  // CTRL+C
process.on('SIGQUIT', () => { console.log("SIGQUIT"); }); // Keyboard quit
process.on('SIGTERM', () => { console.log("SIGTERM"); }); // `kill` command