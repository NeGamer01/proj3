'use strict';
const fs = require('fs');
const path = require('path');

const LOGS_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_FILE = process.env.LOG_FILE || path.join(LOGS_DIR, 'app.log');

// Ensure log directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// single append stream without log-rotation library; upgrade to rotating-file-stream if multi-GB logs expected.
const fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function formatLog(level, message, details) {
  const timestamp = new Date().toISOString();
  const detailStr = details !== undefined && details !== null
    ? ` | ${typeof details === 'object' ? JSON.stringify(details) : String(details)}`
    : '';
  return `[${timestamp}] [${level}] ${message}${detailStr}`;
}

function writeLog(level, message, details) {
  const line = formatLog(level, message, details);
  if (level === 'ERROR') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
  fileStream.write(line + '\n');
}

const logger = {
  debug: (msg, details) => writeLog('DEBUG', msg, details),
  info: (msg, details) => writeLog('INFO', msg, details),
  warn: (msg, details) => writeLog('WARN', msg, details),
  error: (msg, details) => writeLog('ERROR', msg, details),
  system: (msg, details) => writeLog('SYSTEM', msg, details),
  log: writeLog,
  close: () => fileStream.end()
};

module.exports = { logger, formatLog, writeLog };
