'use strict';
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { attachUser } = require('./middlewares/auth');
const { logger } = require('./utils/logger');

function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(attachUser);

  const pub = path.join(__dirname, '..', 'public');
  app.use('/assets', express.static(path.join(pub, 'assets'), { maxAge: '5m' }));
  app.get('/qris.css', (_req, res) => res.sendFile(path.join(pub, 'qris.css')));
  app.get('/qris.js', (_req, res) => res.sendFile(path.join(pub, 'qris.js')));

  // pages
  const page = (file) => (_req, res) => res.sendFile(path.join(pub, file));
  app.get('/', (req, res) => (req.user ? res.redirect(req.user.role === 'admin' ? '/admin' : '/app') : res.sendFile(path.join(pub, 'index.html'))));
  app.get('/login', page('index.html'));
  app.get('/register', page('index.html'));
  app.get('/app', (req, res) => (req.user ? res.sendFile(path.join(pub, 'app.html')) : res.redirect('/login')));
  app.get('/admin', (req, res) => (req.user?.role === 'admin' ? res.sendFile(path.join(pub, 'admin.html')) : res.redirect('/login')));
  app.get('/docs', page('docs.html'));

  // APIs
  app.use(require('./routes/api'));
  app.use('/app/api', require('./routes/user'));
  app.use('/admin/api', require('./routes/admin'));

  app.use((req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} tidak ada` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, code: 'BAD_JSON', message: 'Body JSON tidak valid' });
    logger.error(`Unhandled: ${err.stack || err.message}`);
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal error' });
  });
  return app;
}

module.exports = { createApp };
