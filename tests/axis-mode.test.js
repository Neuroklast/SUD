import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1] ?? '';
const labelFunction = inline.match(/function axisLabelForAge\(age,mode=axisMode\)\{[^}]+\}/)?.[0];
if (!labelFunction) throw new Error('axisLabelForAge helper is missing');
const axisLabelForAge = new Function('BIRTH_YEAR', 'axisMode',
  `${labelFunction}; return axisLabelForAge;`)(1989, 'age');

test('age view retains exact original labels', () => {
  assert.equal(axisLabelForAge(0, 'age'), '0');
  assert.equal(axisLabelForAge(12, 'age'), '12');
  assert.equal(axisLabelForAge(37, 'age'), '37');
});

test('calendar year is based on birthdate 28 September 1989', () => {
  assert.equal(axisLabelForAge(0, 'year'), '1989');
  assert.equal(axisLabelForAge(12, 'year'), '2001');
  assert.equal(axisLabelForAge(37, 'year'), '2026');
  assert.match(html, /const BIRTH_MONTH=9/);
  assert.match(html, /const BIRTH_DAY=28/);
});

test('axis controls switch labels without modifying or uploading timeline data', () => {
  assert.match(html, /id="axis-age"/);
  assert.match(html, /id="axis-year"/);
  const toggle = inline.match(/function setAxisMode\(mode\)\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(toggle);
  assert.match(toggle, /renderChart\(filterEvents\(\)\)/);
  assert.doesNotMatch(toggle, /\bpersist\s*\(|fetch\s*\(/);
  assert.match(inline, /AXIS_STORAGE_KEY/);
});
