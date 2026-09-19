'use strict';
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');

class UserError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

// ── password hashing (scrypt, no native deps) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return calc.length === ref.length && crypto.timingSafeEqual(calc, ref);
}

// ── signed cookie session token (HS256 via sessionSecret) ──
function signToken(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── CRUD ──
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }

function validateCredentials(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('Email tidak valid', 400, 'INVALID_EMAIL');
  if (typeof password !== 'string' || password.length < 8) throw new UserError('Password minimal 8 karakter', 400, 'WEAK_PASSWORD');
}

async function register({ email, password, name, role = 'user' }) {
  email = normalizeEmail(email);
  validateCredentials(email, password);
  const cleanName = String(name || '').trim().slice(0, 120) || email.split('@')[0];
  const exists = await db.one('SELECT id FROM users WHERE email = ?', [email]);
  if (exists) throw new UserError('Email sudah terdaftar', 409, 'EMAIL_TAKEN');
  const r = await db.query('INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)', [email, hashPassword(password), cleanName, role]);
  return findById(r.insertId);
}

async function login({ email, password }) {
  email = normalizeEmail(email);
  const user = await db.one('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) throw new UserError('Email atau password salah', 401, 'INVALID_LOGIN');
  if (user.status === 'blocked') throw new UserError('Akun diblokir. Hubungi admin.', 403, 'BLOCKED');
  await db.query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  return publicUser(user);
}

async function changePassword(userId, oldPassword, newPassword) {
  const user = await db.one('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || !verifyPassword(String(oldPassword || ''), user.password_hash)) throw new UserError('Password lama salah', 400, 'INVALID_LOGIN');
  if (typeof newPassword !== 'string' || newPassword.length < 8) throw new UserError('Password baru minimal 8 karakter', 400, 'WEAK_PASSWORD');
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), userId]);
}

async function findById(id) {
  const u = await db.one('SELECT * FROM users WHERE id = ?', [id]);
  return u ? publicUser(u) : null;
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, created_at: u.created_at, last_login_at: u.last_login_at };
}

async function ensureAdminFromEnv() {
  const { email, password } = config.admin;
  const existing = await db.one("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing || !email || !password) return existing ? 'exists' : 'skipped';
  await register({ email, password, name: 'Admin', role: 'admin' });
  return 'created';
}

module.exports = { UserError, hashPassword, verifyPassword, signToken, verifyToken, register, login, changePassword, findById, ensureAdminFromEnv, publicUser };
