import { open } from 'i2c-bus';
import * as util from 'util';

/*const i2c1 = i2c.open(1, err => {
    if (err) throw err;
  
    i2c1.readWord(MCP9808_ADDR, TEMP_REG, (err, rawData) => {
      if (err) throw err;
  
      console.log(toCelsius(rawData));
  
      i2c1.close(err => {
        if (err) throw err;
      });
    });
  });*/

console.log("Scanning for i2c devices...");
const bus = open(0, (err) => {
    if (err) console.log("error opening bus:", err);
});

bus.scan((err, devices) => {
    if (err) console.log("error:", err);
    console.log("devices:", util.inspect(devices));
})