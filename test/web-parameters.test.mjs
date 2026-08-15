import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumericInput } from '../src/lib/web-parameters.mjs';

test('manual parameter input accepts plain decimal text without coercing exotic syntax', () => {
  assert.equal(parseNumericInput('20', { integer: true }), 20);
  assert.equal(parseNumericInput(' 005 ', { integer: true }), 5);
  assert.equal(parseNumericInput('60.5'), 60.5);
  assert.equal(parseNumericInput('.5'), 0.5);
  assert.equal(parseNumericInput('60.'), 60);
  assert.equal(parseNumericInput(''), null);
  for (const value of ['0x10', '1e3', '+5', '1,000', '２０', 'NaN', 'Infinity']) {
    assert.equal(Number.isNaN(parseNumericInput(value, { integer: true })), true, value);
  }
  assert.equal(Number.isNaN(parseNumericInput('1.5', { integer: true })), true);
  assert.equal(Number.isNaN(parseNumericInput('999999999999999999999', { integer: true })), true);
});
