// PDF text extraction can split fractions across several overlapping blocks.
// An opaque translation rectangle would erase the neighbouring source content,
// even if that neighbour has no translation (or has not streamed in yet).
export function planTranslationOverlays(blocks, translations) {
  const overlays = [], preserved = [];
  for (const block of blocks) {
    if (!translations?.[block.id]) continue;
    const a = block.bbox;
    const overlaps = blocks.some(other => {
      if (other === block) return false;
      const b = other.bbox;
      return Math.min(a[2], b[2]) > Math.max(a[0], b[0])
        && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
    });
    (overlaps ? preserved : overlays).push(block);
  }
  return { overlays, preserved };
}

// Text size for a translated block (a font size or a scale factor). `base` is the size of the
// source text. Chinese usually needs less room than the English it replaces, so with room to
// spare the text grows until the box is full (never past `max`); when it does not fit at `base`
// it shrinks, down to `min`.
// The search is a step machine: read `size`, lay the text out at that size, report whether it
// stays inside the box with next(fitsHeight, fitsWidth), repeat until `done`. A page can then
// step all its blocks together and pay for one layout per step instead of one per block.
export function textFitter(base, min, max, steps = 8) {
  let lo = min, hi = base, growing = false, phase = 'base', left = steps;
  const f = { size: base, done: false, next };
  const finish = size => { f.size = size; f.done = true; };
  const bisect = () => { if (left-- > 0) f.size = (lo + hi) / 2; else finish(lo); };
  function next(fitsH, fitsW = true) {
    if (f.done) return;
    if (phase === 'base') {
      if (fitsH && fitsW && max > base) { growing = true; lo = base; hi = max; phase = 'cap'; f.size = max; }
      else if (fitsH) finish(base); // nothing to gain, or already too wide: keep the source size
      else { phase = 'search'; bisect(); }
    } else if (phase === 'cap') {
      if (fitsH && fitsW) finish(max); else { phase = 'search'; bisect(); }
    } else {
      // growing must not push an unbreakable token (a URL, a number) out of the box sideways
      if (fitsH && (fitsW || !growing)) lo = f.size; else hi = f.size;
      bisect();
    }
  }
  return f;
}
