'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

const MASTER_KEY_FILE = path.join(process.cwd(), 'qrispay.key');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard IV length for AES-GCM

/**
 * Retrieves the 256-bit master encryption key for provider tokens.
 *
 * Checks in order:
 * 1. PROVIDER_MASTER_KEY environment variable (64 hex characters / 32 bytes)
 * 2. qrispay.key file in the project root
 * 3. If neither exists, automatically generates a new 32-byte key, saves it
 *    to qrispay.key with restricted permissions (0600), and returns the key buffer.
 */
function getMasterKey() {
  // 1. Environment Variable
  const envKey = process.env.PROVIDER_MASTER_KEY?.trim();
  if (envKey) {
    if (envKey.length === 64) {
      return Buffer.from(envKey, 'hex');
    }
    // Fallback: scrypt derivation if not exact 64-hex
    return crypto.scryptSync(envKey, 'qrispay-salt-v1', 32);
  }
  // 2. Key File
  if (fs.existsSync(MASTER_KEY_FILE)) {
    try {
      const fileContent = fs.readFileSync(MASTER_KEY_FILE, 'utf-8').trim();
      if (fileContent.length === 64) {
        return Buffer.from(fileContent, 'hex');
      }
      return crypto.scryptSync(fileContent, 'qrispay-salt-v1', 32);
    } catch (err) {
      logger.warn(`[Crypto] Failed to read ${MASTER_KEY_FILE}: ${err.message}`);
    }
  }
  // 3. Auto-generate new Master Key
  const newKey = crypto.randomBytes(32);
  const hexKey = newKey.toString('hex');
  try {
    fs.writeFileSync(MASTER_KEY_FILE, hexKey + '\n', { mode: 0o600, encoding: 'utf-8' });
    logger.info(`[Crypto] Generated new master key saved to ${MASTER_KEY_FILE} (0600)`);
  } catch (err) {
    logger.error(`[Crypto] Failed to write master key to file: ${err.message}`);
  }
  return newKey;
}

/**
 * Encrypts an object or string using AES-256-GCM.
 * Format: iv_hex:auth_tag_hex:ciphertext_hex
 *
 * @param {object|string} payload Object or string to encrypt
 * @param {Buffer} [customKey] Optional custom 32-byte Buffer key
 * @returns {string} Serialized encrypted envelope
 */
function encryptPayload(payload, customKey) {
  const key = customKey || getMasterKey();
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts and parses an AES-256-GCM encrypted envelope.
 *
 * @param {string} envelope String in the format iv_hex:auth_tag_hex:ciphertext_hex
 * @param {Buffer} [customKey] Optional custom 32-byte Buffer key
 * @returns {object|string} Decrypted object or string
 */
function decryptPayload(envelope, customKey) {
  const key = customKey || getMasterKey();
  const parts = envelope.trim().split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted envelope format (expected iv:authTag:ciphertext)');
  }
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  try {
    return JSON.parse(decrypted);
  } catch {
    return decrypted;
  }
}

module.exports = { MASTER_KEY_FILE, getMasterKey, encryptPayload, decryptPayload };
