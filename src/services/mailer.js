'use strict';

/**
 * Outgoing mail over SMTP. `transport` can be injected (tests) and only needs `sendMail(message) => Promise`.
 * When SMTP is not configured, mail is not sent; outside production the message is written to the log instead
 * so the flow can be tried locally.
 */
function createMailerService({ config, logger, transport }) {
  const m = config.mail;
  const configured = !!(transport || (m.host && m.from));
  let tx = transport || null;

  function getTransport() {
    if (!tx) {
      const nodemailer = require('nodemailer');
      tx = nodemailer.createTransport({
        host: m.host, port: m.port, secure: m.secure,
        auth: m.user ? { user: m.user, pass: m.pass } : undefined,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      });
    }
    return tx;
  }

  /** True when a real email can be sent. */
  const enabled = () => configured;
  /** Dev convenience: no SMTP, not production -> links are logged. */
  const devFallback = () => !configured && config.env !== 'production';

  async function send({ to, subject, text, html }) {
    if (!configured) {
      if (devFallback()) logger.info('mail.dev_not_sent', { to, subject, text });
      else logger.warn('mail.not_configured', { subject });
      return false;
    }
    await getTransport().sendMail({ from: m.from || undefined, to, subject, text, html });
    return true;
  }

  return { enabled, devFallback, send };
}

module.exports = { createMailerService };
