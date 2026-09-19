'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calculateCRC16 } = require('../src/utils/crc16');
const { generateDynamicQRIS, parseEMVCoTags } = require('../src/utils/qris');

// Pure, offline tests for the QRIS EMVCo injection (provider-agnostic).

const STATIC_SAMPLE = '00020101021126570011A00000000501021151031599880304UMI51440014ID.CO.QRIS.WWW0115ID1003001020250303UMI515080102590303UMI60115NGAMEDIA01110302116';

test('calculateCRC16: stable known output (4 hex chars)', () => {
  const crc = calculateCRC16('00020101021126');
  assert.match(crc, /^[0-9A-F]{4}$/);
});

test('generateDynamicQRIS: flips tag 01 to 12 and injects tag 54', () => {
  const dyn = generateDynamicQRIS(STATIC_SAMPLE, 106000);
  assert.ok(dyn, 'should produce a string');
  const tags = parseEMVCoTags(dyn);
  const t01 = tags.find((t) => t.tag === '01');
  const t54 = tags.find((t) => t.tag === '54');
  assert.strictEqual(t01.val, '12', 'tag 01 must be 12 (dynamic)');
  assert.ok(t54, 'tag 54 must be present');
  assert.strictEqual(t54.val, '106000', 'tag 54 must equal injected amount');
  // tag 63 (CRC) present and valid (re-verify CRC)
  const crc = dyn.slice(-4);
  assert.strictEqual(calculateCRC16(dyn.slice(0, -4)).toUpperCase(), crc.toUpperCase());
});

test('generateDynamicQRIS: rejects invalid inputs', () => {
  assert.strictEqual(generateDynamicQRIS('', 1000), null);
  assert.strictEqual(generateDynamicQRIS(STATIC_SAMPLE, 0), null);
  assert.strictEqual(generateDynamicQRIS(STATIC_SAMPLE, -5), null);
  assert.strictEqual(generateDynamicQRIS(null, 1000), null);
});

test('parseEMVCoTags: strips existing CRC (6304) before parsing', () => {
  const dyn = generateDynamicQRIS(STATIC_SAMPLE, 1000);
  const tags = parseEMVCoTags(dyn);
  assert.ok(!tags.some((t) => t.tag === '63'), 'tag 63 (CRC) must be stripped');
});
