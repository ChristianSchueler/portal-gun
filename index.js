import { openPromisified } from 'i2c-bus';
import { exit } from 'process';
import * as util from 'util';

let camAddress = 0;   // probably 88
const sensivityBlock1 = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x00, 0xC0];
const sensivityBlock2 = [0x40, 0x00];

export function sleep(duration_ms) {
	return new Promise(resolve => setTimeout(resolve, duration_ms));
}

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
  
  await bus.writeByte(camAddress, 0x30, 0x01);
  await bus.writeByte(camAddress, 0x30, 0x08);
  await bus.writeI2cBlock(camAddress, 0x00, sensivityBlock1.length, Buffer.from(sensivityBlock1));
  await bus.writeI2cBlock(camAddress, 0x1A, sensivityBlock2.length, Buffer.from(sensivityBlock2));
  await bus.writeByte(camAddress, 0x33, 0x33);

  console.log("ready.");

  let data = Buffer.alloc(16);
  let x = [];
  let y = [];

  console.log("Reading positions...");
  while (true) {
    await bus.sendByte(camAddress, 0x36);
    let dataLen = await bus.i2cRead(camAddress, 16, data);
    //console.log(dataLen, util.inspect(data));

    x[0] = data[1];
    x[0] += (data[3] & 0x30) << 4;
    y[0]  =  data[2];
    y[0] += (data[3] & 0xC0) << 2;
    x[1]  = data[4];
    x[1] += (data[6] & 0x30) << 4;
    y[1]  = data[5];
    y[1] += (data[6] & 0xC0) << 2;
    x[2]  = data[7];
    x[2] += (data[9] & 0x30) << 4;
    y[2]  = data[8];
    y[2] += (data[9] & 0xC0) << 2;
    x[3]  = data[10];
    x[3] += (data[12] & 0x30) << 4;
    y[3]  = data[11];
    y[3] += (data[12] & 0xC0) << 2;

    console.log("positions - 0:", x[0], y[0], "1:", x[1], y[1], "2:", x[2], y[2], "3:", x[3], y[3]);

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