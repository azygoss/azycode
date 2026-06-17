const { cursorTo } = require('readline');
process.stdout.write('\x1b[2J\x1b[H');
console.log("Line 1");
console.log("Line 2");
console.log("Line 3");
process.stdout.write('\x1b[1;20r'); // set margins
process.stdout.write("Test text after margins\n");
