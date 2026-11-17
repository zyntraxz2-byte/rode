'use strict';
const { createSettingsService } = require('./settings');
const { createSessionService } = require('./sessions');
const { createUsersService } = require('./users');
const { createMailerService } = require('./mailer');
const { createPasswordResetService } = require('./passwordReset');
const { createAssetService } = require('./assets');
const { createApptService } = require('./appts');
const { createTxnService } = require('./txns');
const { createSampleService } = require('./sample');
const { createQuickBookService } = require('./quickbook');

function createServices({ db, config, logger, fetchImpl, mailTransport }) {
  const settings = createSettingsService({ db, config });
  const sessions = createSessionService({ db, config });
  const users = createUsersService({ db, sessions, logger });
  const mailer = createMailerService({ config, logger, transport: mailTransport });
  const passwordReset = createPasswordResetService({ db, config, logger, users, sessions, mailer });
  const assets = createAssetService({ db, config, logger });
  const appts = createApptService({ db, config, settings, assets });
  const txns = createTxnService({ db });
  const sample = createSampleService({ db, config, settings, assets });
  const quickbook = createQuickBookService({ config, settings, fetchImpl });
  return { settings, sessions, users, mailer, passwordReset, assets, appts, txns, sample, quickbook };
}

module.exports = { createServices };
