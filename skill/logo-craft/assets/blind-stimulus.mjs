#!/usr/bin/env node
// 블라인드 읽힘 테스트용 자극 이미지 생성기.
// 만든 사람은 자기 로고가 뭐로 보이는지 판정할 수 없다 — 이미 답을 알고 보기 때문이다.
// 이 스크립트는 브랜드 단서를 전부 지운 이미지를 만든다. 누설되면 테스트가 무의미해진다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch {}
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const req = createRequire(join(root, 'noop.js'));
  const mod = await import(pathToFileURL(req.resolve('playwright')).href);
  return mod.chromium ?? mod.default.chromium;
}

// SVG 안의 텍스트 메타데이터를 전부 제거한다.
// <title>우디카페 심볼</title> 하나가 남아 있으면 읽는 쪽이 답을 먼저 본다.
function scrub(svg) {
  return svg
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<desc>[\s\S]*?<\/desc>/gi, '')
    .replace(/<metadata>[\s\S]*?<\/metadata>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(id|class|aria-label|data-[\w-]+)="[^"]*"/gi, '');
}

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
if (!src) {
  console.error('사용법: node blind-stimulus.mjs <logo.svg> [--out <dir>]');
  process.exit(1);
}
const outFlag = args.indexOf('--out');
const token = randomBytes(3).toString('hex');            // 파일명·폴더명에 브랜드가 남지 않게
const outDir = outFlag > -1 ? resolve(args[outFlag + 1]) : join(tmpdir(), `form-${token}`);
mkdirSync(outDir, { recursive: true });

const svg = scrub(readFileSync(resolve(src), 'utf8'));
const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

// 세 조건. 사람이 실제로 로고를 만나는 조건들이다.
const shots = [
  { key: 'a', px: 260, bg: '#FFFFFF', ink: null,      what: '기본 · 흰 배경' },
  { key: 'b', px:  36, bg: '#FFFFFF', ink: null,      what: '축소 · 파비콘 크기' },
  { key: 'c', px: 260, bg: '#141414', ink: '#FFFFFF', what: '반전 · 어두운 배경' },
];

const chromium = await loadChromium();
const browser = await chromium.launch();
const made = [];
for (const s of shots) {
  const pad = Math.round(s.px * 0.5);
  const box = s.px + pad * 2;
  const filter = s.ink ? 'filter:brightness(0) invert(1);' : '';
  const html = `<style>html,body{margin:0}
    body{width:${box}px;height:${box}px;background:${s.bg};
      display:flex;align-items:center;justify-content:center}
    img{width:${s.px}px;height:${s.px}px;${filter}}</style>
    <img src="${dataUrl}">`;
  const page = await browser.newPage({
    viewport: { width: box, height: box }, deviceScaleFactor: 2,
  });
  await page.setContent(html);
  const file = join(outDir, `form-${token}-${s.key}.png`);
  await page.screenshot({ path: file });
  await page.close();
  made.push({ file, what: s.what });
}
await browser.close();

const list = made.map(m => `  ${m.file}\n     (${m.what})`).join('\n');
console.log(`
자극 이미지 3장 생성 — 브랜드 단서 제거됨 (title/desc/id/주석/파일명)

${list}

다음 — 읽는 사람에게 아래 문장만 준다. 이미지 외에 아무것도 붙이지 마라.

  ─────────────────────────────────────────────
  이 이미지가 무엇으로 보입니까?
  떠오르는 첫 단어 3개를 순서대로만 적어주세요.
  설명하지 마세요. 맞히려 하지 마세요.
  ─────────────────────────────────────────────

집계와 판정 기준: references/blind-read.md
`);
writeFileSync(join(outDir, 'PROMPT.txt'),
  '이 이미지가 무엇으로 보입니까?\n떠오르는 첫 단어 3개를 순서대로만 적어주세요.\n설명하지 마세요. 맞히려 하지 마세요.\n');
