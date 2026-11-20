import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRotation, rotatedSize, pageToView, viewToPage, viewRectToPage, rotationTransform } from '../static/rotation.js';

test('quarter turns wrap correctly and invalid stored values are ignored', () => {
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(360), 0);
  for (const invalid of [null, undefined, '90', 45, NaN, Infinity, {}]) assert.equal(normalizeRotation(invalid), 0);
});

test('a landscape selection maps back to the same original highlight for every angle', () => {
  // A known source rectangle [40, 100, 240, 120] on a 600 x 800 page.
  const screenRects = [[40, 100, 240, 120], [680, 40, 700, 240], [360, 680, 560, 700], [100, 360, 120, 560]];
  for (const [index, rotation] of [0, 90, 180, 270].entries()) {
    assert.deepEqual(viewRectToPage(screenRects[index], 600, 800, rotation), [40, 100, 240, 120]);
  }
});

test('hover and search coordinates round-trip on mixed portrait and landscape pages', () => {
  for (const [w, h] of [[600, 800], [800, 600]]) {
    for (const angle of [0, 90, 180, 270]) {
      const [vw, vh] = rotatedSize(w, h, angle);
      for (const point of [[0, 0], [w, 0], [w, h], [0, h], [100.25, 215.75]]) {
        const view = pageToView(...point, w, h, angle);
        assert.ok(view[0] >= 0 && view[0] <= vw && view[1] >= 0 && view[1] <= vh);
        assert.deepEqual(viewToPage(...view, w, h, angle), point);
      }
    }
  }
});

test('CSS surface transform agrees with hit testing at different zoom factors', () => {
  for (const scale of [0.3, 1, 1.75, 4]) {
    for (const angle of [90, 180, 270]) {
      const matrix = rotationTransform(600 * scale, 800 * scale, angle).match(/matrix\((.*)\)/)[1].split(',').map(Number);
      const [a, b, c, d, e, f] = matrix;
      const x = 40 * scale, y = 100 * scale;
      assert.deepEqual([a * x + c * y + e, b * x + d * y + f], pageToView(x, y, 600 * scale, 800 * scale, angle));
    }
  }
});
