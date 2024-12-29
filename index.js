import { openPromisified } from 'i2c-bus';
import { exit } from 'process';
import * as util from 'util';

let camAddress = 0;   // probably 88
const sensivityBlock1 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x00, 0xC0];
const sensivityBlock2 = [0x40, 0x00];

export function sleep(duration_ms) {
	return new Promise(resolve => setTimeout(resolve, duration_ms));
}

class TrackedPoint {
  index = 0;        // 0 .. 3
  valid = false;
  x = 0;
  y = 0;
  size = 0;

  constructor(index) { this.index = index; }
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

  let data = Buffer.alloc(16);
  let x = [];
  let y = [];

  console.log("Reading positions...");
  while (true) {
    await bus.sendByte(camAddress, 0x36);
    let dataLen = await bus.i2cRead(camAddress, 16, data);
    console.log(util.inspect(data));

    // see https://wiibrew.org/wiki/Wiimote#Data_Formats
    trackedPoints[0].valid = data[0] != 0xFF;
    trackedPoints[0].x = data[1] + ((data[3] & 0x30) << 4);
    trackedPoints[0].y = data[2] + ((data[3] & 0xC0) << 2);
    trackedPoints[0].size = data[3] & 0x0F;

    trackedPoints[1].valid = data[4] != 0xFF;
    trackedPoints[1].x = data[4] + ((data[6] & 0x30) << 4);
    trackedPoints[1].y = data[5] + ((data[6] & 0xC0) << 2);
    trackedPoints[1].size = data[5] & 0x0F;

    trackedPoints[2].valid = data[7] != 0xFF;
    trackedPoints[2].x = data[7] + ((data[9] & 0x30) << 4);
    trackedPoints[2].y = data[8] + ((data[9] & 0xC0) << 2);
    trackedPoints[2].size = data[8] & 0x0F;

    trackedPoints[3].valid = data[10] != 0xFF;
    trackedPoints[3].x = data[10] + ((data[12] & 0x30) << 4);
    trackedPoints[3].y = data[11] + ((data[12] & 0xC0) << 2);
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