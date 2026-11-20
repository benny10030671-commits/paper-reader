// View rotation is relative to the PDF's original displayed orientation.
// Stored highlights and layout boxes always stay in original page coordinates.
export function normalizeRotation(value) {
  return Number.isFinite(value) && value % 90 === 0 ? ((value % 360) + 360) % 360 : 0;
}

export function rotatedSize(w, h, rotation) {
  return normalizeRotation(rotation) % 180 ? [h, w] : [w, h];
}

export function pageToView(x, y, w, h, rotation) {
  switch (normalizeRotation(rotation)) {
    case 90: return [h - y, x];
    case 180: return [w - x, h - y];
    case 270: return [y, w - x];
    default: return [x, y];
  }
}

export function viewToPage(x, y, w, h, rotation) {
  switch (normalizeRotation(rotation)) {
    case 90: return [y, h - x];
    case 180: return [w - x, h - y];
    case 270: return [w - y, x];
    default: return [x, y];
  }
}

export function viewRectToPage(rect, w, h, rotation) {
  const a = viewToPage(rect[0], rect[1], w, h, rotation);
  const b = viewToPage(rect[2], rect[3], w, h, rotation);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export function rotationTransform(w, h, rotation) {
  switch (normalizeRotation(rotation)) {
    case 90: return `matrix(0, 1, -1, 0, ${h}, 0)`;
    case 180: return `matrix(-1, 0, 0, -1, ${w}, ${h})`;
    case 270: return `matrix(0, -1, 1, 0, 0, ${w})`;
    default: return 'none';
  }
}
