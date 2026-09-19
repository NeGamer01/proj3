'use strict';
const db = require('../db');
const { logger } = require('../utils/logger');

function logActivity(userId, type, message) {
  logger.log(type, `[u${userId ?? '-'}] ${message}`);
  db.query('INSERT INTO activity_logs (user_id, timestamp, type, message) VALUES (?, ?, ?, ?)',
    [userId ?? null, new Date().toISOString().slice(0, 23).replace('T', ' '), type, String(message).slice(0, 1000)])
    .catch((e) => logger.debug(`[ActivityLog] skipped: ${e.message}`));
}

async function listLogs({ userId = null, limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (userId === null) {
    return db.query(`SELECT l.id, l.user_id, u.email, l.timestamp, l.type, l.message FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ${lim}`);
  }
  return db.query(`SELECT id, timestamp, type, message FROM activity_logs WHERE user_id = ? ORDER BY id DESC LIMIT ${lim}`, [userId]);
}

async function pruneLogs(keep = 5000) {
  const row = await db.one('SELECT id FROM activity_logs ORDER BY id DESC LIMIT 1 OFFSET ?', [keep]).catch(() => null);
  if (row) await db.query('DELETE FROM activity_logs WHERE id <= ?', [row.id]);
}

module.exports = { logActivity, listLogs, pruneLogs };
