'use strict';
// Worker thread: runs ops off the UI thread. Messages: { id, op, args } -> { id, result | error }.
const { parentPort } = require('worker_threads');
const { ops } = require('./ops');

parentPort.on('message', async ({ id, op, args }) => {
  const progress = (text) => parentPort.postMessage({ id, progress: String(text) });
  try {
    if (!ops[op]) throw new Error('Unknown op ' + op);
    const result = await ops[op](progress, ...(args || []));
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  }
});
