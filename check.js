#!/usr/bin/env node
/*
 * Pre-deploy checks for the app redirect.
 *
 *   node check.js
 *
 * Covers the three ways this can silently break:
 *   1. vercel.json and index.html drifting apart on store URLs
 *   2. the edge User-Agent rules not matching real devices
 *   3. the in-page JS fallback routing the wrong way
 *
 * Run this before any print run - a printed QR cannot be recalled.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dir = __dirname;
const vercel = JSON.parse(fs.readFileSync(path.join(dir, 'vercel.json'), 'utf8'));
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

let failures = 0;
const check = (ok, label, extra) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && extra) console.log(`      ${extra}`);
};

/* ---- execute index.html's scripts to see where they actually route ---- */
// Both blocks matter: the <head> one redirects, the <body> one wires the
// rescue link. Run them in order, in one context, like a browser would.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length < 2) throw new Error(`expected 2 script blocks, found ${scripts.length}`);

function runPage(ua, platform, maxTouchPoints, search) {
  let replaced = null;
  const els = {};
  const makeEl = () => ({ textContent: '', href: '', style: {}, addEventListener() {} });
  const win = { location: { search, replace(u) { replaced = u; } } };
  const sandbox = {
    navigator: { userAgent: ua, platform, maxTouchPoints, vendor: '' },
    window: win,
    document: { getElementById(id) { return (els[id] = els[id] || makeEl()); } },
    URLSearchParams,
    // Fire timers immediately so the rescue link's final state is observable.
    setTimeout(cb) { cb(); },
    Math,
  };
  sandbox.window.location = win.location;
  vm.createContext(sandbox);
  for (const s of scripts) vm.runInContext(s, sandbox);
  return { replaced, els, preview: sandbox.window.__preview };
}

const probe = runPage('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'iPhone', 5, '');
const IOS_URL = probe.replaced;
const ANDROID_URL = runPage(
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0', 'Linux armv8l', 5, ''
).replaced;
const WEB_URL = runPage(
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0', 'Win32', 0, ''
).replaced;

console.log('Store URLs found in index.html');
console.log(`  iOS     : ${IOS_URL}`);
console.log(`  Android : ${ANDROID_URL}`);
console.log(`  Web     : ${WEB_URL}\n`);

/* ---- 1. vercel.json destinations must match index.html ---- */
console.log('vercel.json <-> index.html consistency');
const dests = vercel.redirects.map(r => r.destination);
const androidDests = vercel.redirects
  .filter(r => r.has.some(h => /Android/.test(h.value))).map(r => r.destination);
const iosDests = vercel.redirects
  .filter(r => r.has.some(h => /iPhone/.test(h.value))).map(r => r.destination);

check(androidDests.length > 0 && androidDests.every(d => d === ANDROID_URL),
  'Android edge redirects match index.html',
  `vercel.json has ${JSON.stringify([...new Set(androidDests)])}`);
check(iosDests.length > 0 && iosDests.every(d => d === IOS_URL),
  'iOS edge redirects match index.html',
  `vercel.json has ${JSON.stringify([...new Set(iosDests)])}`);

/* ---- 2. no permanent redirects ---- */
check(vercel.redirects.every(r => r.permanent === false),
  'all redirects are temporary (302, not cached forever)',
  'a permanent 308 would lock printed QRs to today\'s store URLs');

/* ---- 3. every printed entry point is covered on both platforms ---- */
console.log('\nEdge rule coverage');
const ENTRY_POINTS = ['/', '/app'];
for (const src of ENTRY_POINTS) {
  const rules = vercel.redirects.filter(r => r.source === src);
  check(rules.some(r => r.has.some(h => /Android/.test(h.value))), `${src} has an Android rule`);
  check(rules.some(r => r.has.some(h => /iPhone/.test(h.value))), `${src} has an iOS rule`);
}

/* ---- 4. the UA regexes must actually match real devices ---- */
console.log('\nEdge User-Agent matching (real UA strings)');
const UAS = [
  ['iPhone Safari 17',  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1', 'ios'],
  ['iPhone Chrome',     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) CriOS/126.0 Mobile/15E148 Safari/604.1', 'ios'],
  ['iPad legacy UA',    'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', 'ios'],
  ['Pixel 8 Chrome',    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36', 'android'],
  ['Samsung Internet',  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 SamsungBrowser/23.0 Mobile Safari/537.36', 'android'],
  ['Android WebView',   'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0 Mobile Safari/537.36', 'android'],
  // These must NOT match at the edge - they fall through to index.html
  ['iPadOS 17 (Mac UA)','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', 'page'],
  ['macOS Chrome',      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'page'],
  ['Windows Chrome',    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'page'],
];

const rootRules = vercel.redirects.filter(r => r.source === '/');
for (const [name, ua, want] of UAS) {
  // Vercel anchors `has.value`, so test the strictest interpretation.
  const hit = rootRules.find(r =>
    r.has.every(h => new RegExp(`^(?:${h.value})$`).test(ua)));
  const got = !hit ? 'page'
    : hit.destination === ANDROID_URL ? 'android'
    : hit.destination === IOS_URL ? 'ios' : '???';
  check(got === want, `${name.padEnd(19)} -> ${got}`, `expected ${want}`);
}

/* ---- 5. the in-page fallback still routes correctly ---- */
console.log('\nIn-page JS fallback (what the edge could not resolve)');
const PAGE_CASES = [
  ['iPadOS 17 (Mac UA)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari/605.1.15', 'MacIntel', 5, '', IOS_URL],
  ['macOS desktop',      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36', 'MacIntel', 0, '', WEB_URL],
  ['Windows desktop',    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36', 'Win32', 0, '', WEB_URL],
  ['unknown ?app value', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'iPhone', 5, '?app=nope', WEB_URL],
  ['no ?app param',      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'iPhone', 5, '', IOS_URL],
];
for (const [name, ua, plat, touch, search, want] of PAGE_CASES) {
  const { replaced, els } = runPage(ua, plat, touch, search);
  const btnMatches = els.rescue && els.rescue.href === want;
  check(replaced === want && btnMatches, `${name.padEnd(19)} -> ${String(replaced).slice(0, 44)}`,
    replaced !== want ? `expected ${want}` : `rescue link points at ${els.rescue && els.rescue.href}`);
}

/* ---- 6. the no-JS meta refresh must point somewhere real ---- */
console.log('\nNo-JS fallback');
const meta = html.match(/http-equiv="refresh"\s+content="(\d+);url=([^"]+)"/i);
check(!!meta, 'meta refresh present');
if (meta) check(meta[2] === WEB_URL, `meta refresh targets the web page (${meta[2]})`);

console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
