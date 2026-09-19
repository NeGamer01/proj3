'use strict';
// Passenger entry: load server.
require('dotenv').config();
require('./src/server.js').main().catch((e) => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
