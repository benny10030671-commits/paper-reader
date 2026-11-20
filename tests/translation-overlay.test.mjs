import test from 'node:test';
import assert from 'node:assert/strict';
import { planTranslationOverlays, textFitter } from '../static/translation-overlay.js';

const block = (id, bbox) => ({ id, bbox });
const ids = items => items.map(b => b.id);

test('arXiv 1312.5067 page 1: overlapping prose cannot erase fraction fragments', () => {
  // Measured source rectangles from the public reproduction PDF, including its
  // separately extracted numerator and denominator. No PDF or cached data edits.
  const blocks = [
    block('title', [93.57, 123.43, 468.03, 142.91]),
    block('b11', [103.56, 316.74, 307.05, 327.68]),
    block('b12', [315.12, 315.95, 322.67, 322.02]),
    block('b13', [317.16, 322.77, 320.81, 328.74]),
    block('b14', [89.76, 318.72, 471.98, 360.56]),
  ];
  const result = planTranslationOverlays(blocks, { title: '標題', b11: '前段', b14: '後段' });
  assert.deepEqual(ids(result.overlays), ['title']);
  assert.deepEqual(ids(result.preserved), ['b11', 'b14']);
});

test('partial translation already protects neighbouring untranslated source', () => {
  const blocks = [block('prose', [0, 0, 100, 20]), block('fraction', [40, 15, 50, 25])];
  const result = planTranslationOverlays(blocks, { prose: '串流中的譯文' });
  assert.equal(result.overlays.length, 0);
  assert.deepEqual(ids(result.preserved), ['prose']);
});

test('ordinary adjacent paragraphs and separate columns still receive overlays', () => {
  const blocks = [block('a', [0, 0, 40, 20]), block('b', [0, 20, 40, 40]), block('c', [50, 0, 90, 40])];
  const result = planTranslationOverlays(blocks, { a: '甲', b: '乙', c: '丙' });
  assert.deepEqual(ids(result.overlays), ['a', 'b', 'c']);
  assert.deepEqual(result.preserved, []);
});

test('contained and mutually translated blocks both preserve original content', () => {
  const blocks = [block('outer', [0, 0, 100, 100]), block('inner', [20, 20, 30, 30])];
  const result = planTranslationOverlays(blocks, { outer: '甲', inner: '乙' });
  assert.equal(result.overlays.length, 0);
  assert.deepEqual(ids(result.preserved), ['outer', 'inner']);
});

test('planning preserves block identities, source order and cached translations', () => {
  const blocks = [block('a', [0, 0, 10, 10]), block('b', [20, 20, 30, 30])];
  const translations = { a: '甲' };
  const original = JSON.stringify({ blocks, translations });
  assert.equal(planTranslationOverlays(blocks, translations).overlays[0], blocks[0]);
  assert.equal(JSON.stringify({ blocks, translations }), original);
  assert.deepEqual(planTranslationOverlays(blocks, undefined), { overlays: [], preserved: [] });
});

// A box of w×h holding `chars` full-width characters at line-height 1.4; `token` is the width (in
// characters) of the longest unbreakable run. Returns [fits its height, fits its width] at a size.
const box = ({ w, h, chars, token = 1 }) => size =>
  [Math.ceil(chars / Math.max(1, Math.floor(w / size))) * size * 1.4 <= h, token * size <= w];

// drive the step machine the way the page does: lay out at `size`, report, repeat
function fit(measure, base = 10, min = 3, max = 20) {
  const f = textFitter(base, min, max);
  let passes = 0;
  for (; !f.done; passes++) f.next(...measure(f.size));
  return { size: f.size, passes };
}

test('a translation shorter than its box grows until the box is full', () => {
  const measure = box({ w: 240, h: 140, chars: 120 }); // 5 of 10 lines used at the source size
  const { size, passes } = fit(measure);
  assert.ok(size > 12 && size < 20, `grew to ${size}`);
  assert.deepEqual(measure(size), [true, true]);
  assert.equal(measure(size * 1.05)[0], false, 'nothing bigger still fits');
  assert.ok(passes <= 10, `${passes} layout passes`);
});

test('growth stops at the cap when the box is almost empty', () => {
  assert.deepEqual(fit(box({ w: 400, h: 400, chars: 4 })), { size: 20, passes: 2 });
});

test('a translation that overflows still shrinks to fit, as before', () => {
  const measure = box({ w: 240, h: 56, chars: 200 });
  const { size } = fit(measure);
  assert.ok(size < 10 && size > 3, `shrank to ${size}`);
  assert.equal(measure(size)[0], true);
  assert.equal(fit(() => [false, true]).size, 3); // nothing fits: stop at the minimum
});

test('growing never pushes an unbreakable token out of the box sideways', () => {
  const { size } = fit(box({ w: 120, h: 400, chars: 10, token: 10 }));
  assert.ok(size <= 12 && size > 11.9, `stopped at ${size}`);
  // already too wide at the source size: keep the source size instead of shrinking
  assert.deepEqual(fit(box({ w: 80, h: 400, chars: 10, token: 10 })), { size: 10, passes: 1 });
});

test('a block that is not laid out keeps the source size', () => {
  assert.deepEqual(fit(() => [true, false]), { size: 10, passes: 1 });
});
