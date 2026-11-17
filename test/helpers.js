'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const ADMIN_PW = 'Salon-Passw0rd!';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

async function boot(overrides = {}, { fetchImpl, mailTransport } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rode-test-'));
  const config = loadConfig({ dataDir, port: 0, logLevel: 'silent', admin: { username: 'admin', password: ADMIN_PW }, ...overrides });
  const logger = createLogger('silent');
  const db = openDatabase(dataDir);
  const { app, services } = createApp({ config, db, logger, fetchImpl, mailTransport });
  services.settings.ensureDefaults();
  await services.users.ensureBootstrapAdmin(config);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    async function call(method, url, body, { raw, headers = {}, csrf = true } = {}) {
      const h = { ...headers };
      if (csrf) h['x-requested-with'] = 'rode';
      if (cookie) h.cookie = cookie;
      let payload;
      if (raw) { payload = raw.body; h['content-type'] = raw.type; }
      else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
      const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const [pair] = c.split(';');
        if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) cookie = ''; else cookie = pair;
      }
      let data = null;
      const type = res.headers.get('content-type') || '';
      if (type.includes('json')) data = await res.json().catch(() => null);
      else if (res.status !== 204) data = Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers, setCookie: set };
    }
    return {
      get: (u, o) => call('GET', u, undefined, o),
      post: (u, b, o) => call('POST', u, b === undefined ? {} : b, o),
      patch: (u, b, o) => call('PATCH', u, b, o),
      del: (u, o) => call('DELETE', u, undefined, o),
      upload: (buf, type = 'image/jpeg') => call('POST', '/api/assets', undefined, { raw: { body: buf, type } }),
      login: async (username, password) => call('POST', '/api/auth/login', { username, password }),
      cookie: () => cookie,
      clear: () => { cookie = ''; },
    };
  }

  async function adminClient() {
    const c = client();
    const r = await c.login('admin', ADMIN_PW);
    if (r.status !== 200) throw new Error('admin login failed ' + JSON.stringify(r.data));
    return c;
  }

  /** Create a user via the admin API and return a signed-in client (password change skipped). */
  async function makeUser(admin, { username, role = 'customer', name, access, password = 'Str0ng-Passw0rd!' }) {
    const r = await admin.post('/api/users', { username, name: name || username, role, access, password, mustChange: false });
    if (r.status !== 201) throw new Error('create user failed ' + JSON.stringify(r.data));
    const c = client();
    const l = await c.login(username, password);
    if (l.status !== 200) throw new Error('login failed ' + JSON.stringify(l.data));
    return { client: c, user: r.data.user, password };
  }

  const close = async () => {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, client, adminClient, makeUser, db, services, config, dataDir, close };
}

const futureDate = (days = 3) => {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
};

module.exports = { boot, ADMIN_PW, JPEG, futureDate };
