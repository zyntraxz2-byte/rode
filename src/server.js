'use strict';
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

async function start(overrides = {}) {
  const config = loadConfig(overrides);
  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.dataDir);
  const { app, services } = createApp({ config, db, logger });

  services.settings.ensureDefaults();
  await services.users.ensureBootstrapAdmin(config);

  const maintain = () => {
    try {
      const s = services.sessions.sweep();
      const a = services.assets.sweepOrphans();
      if (s || a) logger.info('maintenance', { sessionsRemoved: s, orphanPhotosRemoved: a });
    } catch (e) { logger.error('maintenance_failed', { err: e.message }); }
  };
  maintain();
  const maintenanceTimer = setInterval(maintain, 60 * 60 * 1000);
  maintenanceTimer.unref();

  const server = app.listen(config.port, config.host, () => {
    const addr = server.address();
    logger.info('listening', { host: config.host, port: addr.port, env: config.env, timezone: config.timezone, quickBook: services.quickbook.enabled() });
  });
  server.keepAliveTimeout = 65 * 1000; // longer than typical proxy idle timeouts
  server.headersTimeout = 70 * 1000;

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    logger.info('shutdown', { signal });
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close(() => {
      try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) { logger.error('db_close_failed', { err: e.message }); }
      process.exit(0);
    });
    server.closeIdleConnections?.();
  }
  process.on('unhandledRejection', (e) => logger.error('unhandled_rejection', { err: e && e.stack ? e.stack : String(e) }));
  process.on('uncaughtException', (e) => { logger.error('uncaught_exception', { err: e && e.stack ? e.stack : String(e) }); shutdown('uncaughtException'); });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { server, db, services, config };
}

if (require.main === module) {
  start().catch((err) => {
    process.stderr.write(`Fatal: ${err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { start };
