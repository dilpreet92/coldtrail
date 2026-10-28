// Node 22 hands a directory argument (`node --test tests/js/`, the documented command) to the
// module loader as one test file, which resolves it to this index.js. Load every *.test.mjs
// beside it so that command runs the whole suite; a file that fails to load fails the run.
// They share one process this way, so a test that stubs a global (window, document, location,
// localStorage, navigator, timers) must put it back in a finally / after() hook. To run each file
// in its own process instead: `node --test tests/js/*.test.mjs`.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, f)).href).catch((err) => {
    console.error(`${f}: failed to load`, err);
    process.exitCode = 1;
  });
}
