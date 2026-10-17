// WCAG 2.1 contrast check for the colour pairs the design system actually uses.
// Values mirror src/styles/tokens.css, including its color-mix() tints (mixed in sRGB, as the browser does).
// Run: npm run contrast   (exits non-zero if any pair fails its required ratio)

// ---- The five approved brand colours (must match tokens.css exactly) ----
const brand = {
  midnight: '#021024',
  solar: '#052659',
  steel: '#5483B3',
  soft: '#7DA0CA',
  ice: '#C1E8FF',
};
const white = '#FFFFFF';

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
/** color-mix(in srgb, a p%, b) */
const mix = (a, p, b) => {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex(x.map((v, i) => v * (p / 100) + y[i] * (1 - p / 100)));
};

// ---- Derived tokens, same formulas as tokens.css ----
const t = {
  ice50: mix(brand.ice, 12, white),
  ice100: mix(brand.ice, 30, white),
  ice200: mix(brand.ice, 55, white),
  ink700: mix(brand.midnight, 75, white),
  ink600: mix(brand.midnight, 62, white),
  onDarkMuted: mix(brand.ice, 55, brand.soft),
  ctaEnd: mix(brand.solar, 70, brand.midnight),
  /* hero card: midnight at 82% over the illustration — worst case is the lightest panel stop (Soft Blue) */
  heroCard: mix(brand.midnight, 82, brand.soft),
  /* header bar: white at 94% over the page background */
  header: mix(white, 94, mix(brand.ice, 12, white)),
};

const status = {
  error: '#B42318', errorBg: '#FEF3F2',
  success: '#067647', successBg: '#ECFDF3',
  warning: '#93370D', warningBg: '#FFFAEB',
};

const pairs = [
  // [label, foreground, background, required]
  // Body text on light surfaces
  ['Primary text (Midnight) on white', brand.midnight, white, 4.5],
  ['Primary text on page background (ice-50)', brand.midnight, t.ice50, 4.5],
  ['Primary text on tinted panel (ice-100)', brand.midnight, t.ice100, 4.5],
  ['Secondary text (ink-700) on white', t.ink700, white, 4.5],
  ['Secondary text on ice-50', t.ink700, t.ice50, 4.5],
  ['Secondary text on ice-100', t.ink700, t.ice100, 4.5],
  ['Supporting text (ink-600) on white', t.ink600, white, 4.5],
  ['Supporting text on ice-50', t.ink600, t.ice50, 4.5],
  ['Supporting text on ice-100', t.ink600, t.ice100, 4.5],
  ['Nav link (ink-700) on header bar', t.ink700, t.header, 4.5],
  // Links / accent text / buttons
  ['Link & accent text (Deep Solar) on white', brand.solar, white, 4.5],
  ['Link & accent text on ice-50', brand.solar, t.ice50, 4.5],
  ['Link & accent text on ice-100', brand.solar, t.ice100, 4.5],
  ['Chip text (Deep Solar) on ice-200', brand.solar, t.ice200, 4.5],
  ['Primary button: white on Deep Solar', white, brand.solar, 4.5],
  ['Primary button: white on CTA gradient end', white, t.ctaEnd, 4.5],
  ['Primary button hover: white on Midnight', white, brand.midnight, 4.5],
  ['Secondary button text (Deep Solar) on white', brand.solar, white, 4.5],
  ['Secondary button hover text on ice-100', brand.midnight, t.ice100, 4.5],
  ['Light button text (Midnight) on white', brand.midnight, white, 4.5],
  ['Light button hover text on ice-200', brand.midnight, t.ice200, 4.5],
  // Non-text UI (WCAG 1.4.11 — 3:1)
  ['Secondary button border (Steel) on white', brand.steel, white, 3],
  ['Form control border (Steel) on white', brand.steel, white, 3],
  ['Icons (Steel) on white', brand.steel, white, 3],
  ['Icons (Steel) on ice-50', brand.steel, t.ice50, 3],
  ['Focus ring (Steel) on white', brand.steel, white, 3],
  ['Focus ring (Steel) on ice-100', brand.steel, t.ice100, 3],
  ['Focus ring on dark (Ice) on Midnight', brand.ice, brand.midnight, 3],
  ['Focus ring on dark (Ice) on Deep Solar', brand.ice, brand.solar, 3],
  ['Dashboard bar (Deep Solar) on track (ice-100)', brand.solar, t.ice100, 3],
  ['Dashboard low bar (Steel) on track (ice-100)', brand.steel, t.ice100, 3],
  // Text on dark surfaces
  ['White on Midnight', white, brand.midnight, 4.5],
  ['White on Deep Solar', white, brand.solar, 4.5],
  ['Ice accent text on Midnight', brand.ice, brand.midnight, 4.5],
  ['Ice accent text on Deep Solar', brand.ice, brand.solar, 4.5],
  ['Muted text on Midnight (footer)', t.onDarkMuted, brand.midnight, 4.5],
  ['Muted text on Deep Solar', t.onDarkMuted, brand.solar, 4.5],
  ['Muted text on hero card (worst case)', t.onDarkMuted, t.heroCard, 4.5],
  ['Soft Blue text on Midnight', brand.soft, brand.midnight, 4.5],
  // Status (functional colours, each also has an icon + text label)
  ['Error text on white', status.error, white, 4.5],
  ['Error text on error background', status.error, status.errorBg, 4.5],
  ['Success text on white', status.success, white, 4.5],
  ['Success text on success background', status.success, status.successBg, 4.5],
  ['Warning text on white', status.warning, white, 4.5],
  ['Warning text on warning background', status.warning, status.warningBg, 4.5],
  ['WhatsApp icon (white) on #128C7E', white, '#128C7E', 3],
];

// Documented restrictions: these combinations are NOT allowed for normal text. Listed so a change to the
// palette that accidentally makes them pass/fail differently is visible. They are informational only.
const restricted = [
  ['Steel Blue text on white (large text only, ≥24px / 18.66px bold)', brand.steel, white, 3],
  ['Soft Blue on white (decoration only)', brand.soft, white, null],
  ['Ice Blue on white (background only)', brand.ice, white, null],
  ['Deep Solar vs Midnight (never distinguish meaning)', brand.solar, brand.midnight, null],
  ['White text on Steel Blue (never for body text)', white, brand.steel, null],
];

function luminance(hex) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = toRgb(hex).map((v) => lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

console.log('Derived tokens:', Object.entries(t).map(([k, v]) => `${k}=${v}`).join('  '), '\n');
let failures = 0;
for (const [label, fg, bg, need] of pairs) {
  const r = ratio(fg, bg);
  const ok = r >= need;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  (need ${need})  ${label}  ${fg} on ${bg}`);
}
console.log('\nRestricted combinations (informational — enforced by usage rules, not used for normal text):');
for (const [label, fg, bg, need] of restricted) {
  const r = ratio(fg, bg);
  const note = need ? (r >= need ? 'meets large-text 3:1' : 'fails even large-text 3:1') : 'not for text';
  console.log(`INFO  ${r.toFixed(2).padStart(5)}:1  ${label} — ${note}`);
}
console.log(failures ? `\n${failures} pair(s) failed.` : `\nAll ${pairs.length} colour pairs pass.`);
process.exit(failures ? 1 : 0);
