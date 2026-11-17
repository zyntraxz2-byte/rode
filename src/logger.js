'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Minimal structured JSON logger (one line per event, stdout/stderr) friendly to Docker/Loki/CloudWatch. */
function createLogger(level = 'info', sink = null) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields });
    if (sink) sink(line);
    else (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

module.exports = { createLogger };
