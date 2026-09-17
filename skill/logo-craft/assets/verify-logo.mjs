#!/usr/bin/env node
// 로고 SVG 검증 시트 생성기.
// 피그마에서 뽑은 SVG 하나를 넣으면 크기/흑백/반전/크라프트/원형크롭/여백 테스트를
// 한 장의 PNG로 모아 뽑아준다. 사람이 눈으로 판정하는 게 목적이라 자동판정은 보조.
//
//   node verify-logo.mjs <input.svg> [--out <dir>] [--name <브랜드명>]
//   node verify-logo.mjs --selftest

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// ── playwright 로더 ───────────────────────────────────────────────
// playwright가 전역(-g) 설치라 ESM `import 'playwright'`는 못 찾는다.
// NODE_PATH도 ESM엔 안 먹어서, npm root -g로 실경로를 잡아 file:// 로 불러온다.
async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {}
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const req = createRequire(join(root, 'noop.js'));
  const mod = await import(pathToFileURL(req.resolve('playwright')).href);
  return mod.chromium ?? mod.default.chromium;
}

// ── 자동 판정 ─────────────────────────────────────────────────────
// 정규식 파싱. 기계적으로 확실한 것만 본다(형태 미학은 사람 몫).
function audit(svg) {
  const out = [];
  const add = (level, title, why) => out.push({ level, title, why });

  if (/<image[\s>]/i.test(svg) || /;base64,/i.test(svg))
    add('error', '래스터 이미지가 박혀 있음', '<image>/base64 발견. 벡터 납품 불가, 확대 시 깨진다');

  if (/<text[\s>]/i.test(svg))
    add('error', '글자가 아웃라인화 안 됨', '<text> 발견. 폰트 없는 환경에서 다른 글꼴로 깨진다');

  if (/<(linear|radial)Gradient[\s>]/i.test(svg))
    add('warn', '그라데이션 사용', '1도 인쇄·자수·각인에서 무너진다. 단색 버전이 따로 필요');

  if (/<filter[\s>]/i.test(svg) || /feGaussianBlur|filter\s*[:=]/i.test(svg))
    add('warn', '필터/블러 효과', '인쇄 재현 불가. 실크스크린·자수에서 사라진다');

  // 앵커 근사치: path의 명령 문자(Z 제외) + 다각형 점 개수
  const paths = svg.match(/<path[\s>]/gi)?.length ?? 0;
  let nodes = 0;
  for (const m of svg.matchAll(/\sd\s*=\s*"([^"]*)"/gi))
    nodes += (m[1].match(/[MLHVCSQTA]/gi) ?? []).length;
  for (const m of svg.matchAll(/\spoints\s*=\s*"([^"]*)"/gi))
    nodes += (m[1].trim().split(/[\s,]+/).length / 2) | 0;

  if (nodes > 100)
    add('warn', `노드 ${nodes}개로 과다`, '형태가 복잡하다. 16px에서 뭉개지고 수정도 어렵다');
  else
    add('pass', `path ${paths}개 / 노드 약 ${nodes}개`, '단순하다. 작게 줄여도 버틸 구조');

  const vb = svg.match(/viewBox\s*=\s*"([^"]*)"/i);
  if (!vb) add('error', 'viewBox 없음', '크기 대응 불가. 배치하는 곳마다 크기가 틀어진다');
  else add('pass', `viewBox ${vb[1]}`, '어떤 크기로도 안전하게 늘어난다');

  if (!out.some((v) => v.level !== 'pass'))
    add('pass', '기계 검사 전항목 통과', '나머지는 눈으로 판정 — 특히 16px 칸과 실루엣 칸');

  return { verdicts: out, paths, nodes };
}

// ── 브라우저 안에서 도는 픽셀 실측 + 공법 시뮬 ────────────────────
// 함수 그대로 toString()해서 <script>로 주입한다(따옴표 탈출 지옥 회피).
// getBBox()는 절대 안 쓴다 — 회전된 호를 베지에 제어점 기준으로 재서
// 실제 잉크보다 최대 12%까지 과대평가한다(실측 확인). 전부 알파 스캔.
function pageScript(SRC, AR_HINT) {
  const BLUE = '#2F6FB0', RED = '#C4372F';
  const img = new Image();
  img.onerror = () => { window.__optics = { error: 'SVG 로드 실패' }; };
  img.onload = () => {
    try { window.__optics = run(); }
    catch (e) { window.__optics = { error: String((e && e.message) || e) }; }
  };
  img.src = SRC;

  // ─ 유틸 ─
  const $ = (id) => document.getElementById(id);

  // SVG를 정사각 캔버스 한가운데 최대 크기로 그린다
  function draw(S) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const ar = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : AR_HINT;
    let w = S, h = S / ar;
    if (h > S) { h = S; w = S * ar; }
    g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
    return cv;
  }

  const lumaOf = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

  // 잉크 마스크. darkInk면 "불투명하고 어두운 픽셀"만 잉크로 본다
  // (배경 사각형이 깔렸거나 밝은 색 녹아웃이 뚫린 SVG 대응).
  // ponytail: 어두운 판때기 위에 흰 마크가 얹힌 반전 SVG는 판때기를 잉크로 읽는다.
  //           그런 파일이 실제로 오면 흰색 추출 분기를 추가하라.
  function maskOf(ctx, w, h, darkInk) {
    const d = ctx.getImageData(0, 0, w, h).data;
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (d[i * 4 + 3] <= 32) continue;
      m[i] = darkInk ? (lumaOf(d, i * 4) < 160 ? 1 : 0) : 1;
    }
    return m;
  }

  // 박스 커널 팽창/침식. dilate=true면 팽창.
  function morph(m, w, h, r, dilate) {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const v = m[yy * w + xx];
          if (dilate ? v : !v) { hit = 1; break; }
        }
      }
      o[y * w + x] = dilate ? (hit ? 1 : 0) : (hit ? 0 : 1);
    }
    return o;
  }

  function paint(cv, m, w, h) {
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const im = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = m[i] ? 0 : 255;
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
      im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }

  // flood fill 연결요소. 잉크는 8-이웃.
  function components(m, w, h, minArea) {
    const lab = new Int32Array(w * h);
    const out = [];
    const st = [];
    let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || lab[s]) continue;
      id++; let cnt = 0; st.push(s); lab[s] = id;
      while (st.length) {
        const p = st.pop(); cnt++;
        const px = p % w, py = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (m[q] && !lab[q]) { lab[q] = id; st.push(q); }
        }
      }
      out.push({ id, count: cnt });
    }
    return { lab, comps: out.filter((c) => c.count >= minArea) };
  }

  // 속공간(카운터) 개수 = 테두리와 안 이어진 배경 덩어리. 배경은 4-이웃.
  function holes(m, w, h, minArea) {
    const inv = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) inv[i] = m[i] ? 0 : 1;
    const st = [];
    for (let x = 0; x < w; x++) { st.push(x); st.push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { st.push(y * w); st.push(y * w + w - 1); }
    while (st.length) {
      const p = st.pop(); if (!inv[p]) continue; inv[p] = 0;
      const px = p % w, py = (p / w) | 0;
      if (px > 0) st.push(p - 1);
      if (px < w - 1) st.push(p + 1);
      if (py > 0) st.push(p - w);
      if (py < h - 1) st.push(p + w);
    }
    return components(inv, w, h, minArea).comps.length;
  }

  // 획 굵기 근사: 폭 t 길이 L 막대는 면적 tL, 둘레 ≈ 2L → 2·면적/둘레 = t
  function strokeWidth(m, w, h) {
    let area = 0, per = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !m[y * w + x - 1] || !m[y * w + x + 1] || !m[(y - 1) * w + x] || !m[(y + 1) * w + x]) per++;
    }
    return per ? (2 * area) / per : 0;
  }

  function thresh(g, w, h, t) {
    const im = g.getImageData(0, 0, w, h);
    for (let i = 0; i < w * h; i++) {
      const v = im.data[i * 4] < t ? 0 : 255;
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
      im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }

  // 저해상도 축소 → 이진화 → 확대를 n회 반복(팩스/복사 열화)
  function faxify(m, w, h, times) {
    const a = document.createElement('canvas');
    paint(a, m, w, h);
    const ag = a.getContext('2d', { willReadFrequently: true });
    const s = Math.max(12, Math.round(w / 7));
    const b = document.createElement('canvas');
    b.width = b.height = s;
    const bg = b.getContext('2d', { willReadFrequently: true });
    for (let t = 0; t < times; t++) {
      bg.fillStyle = '#fff'; bg.fillRect(0, 0, s, s);
      bg.drawImage(a, 0, 0, s, s);
      thresh(bg, s, s, 150);
      ag.fillStyle = '#fff'; ag.fillRect(0, 0, w, h);
      ag.drawImage(b, 0, 0, w, h);
      thresh(ag, w, h, 150);
    }
    const d = ag.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = d[i * 4] < 128 ? 1 : 0;
    return out;
  }

  const ratio = (m) => m.reduce((a, v) => a + v, 0) / m.length;

  // ─ 원형 크롭 프리뷰 ─
  function cross(g, x, y, color, dashed, D) {
    g.save();
    g.strokeStyle = color; g.lineWidth = 1.5;
    if (dashed) g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(0, y); g.lineTo(D, y); g.moveTo(x, 0); g.lineTo(x, D); g.stroke();
    g.setLineDash([]);
    g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.stroke();
    g.restore();
  }

  function circlePreview(id, src, ccx, ccy, side, mk) {
    const cv = $(id), D = cv.width, g = cv.getContext('2d');
    g.save();
    g.beginPath(); g.arc(D / 2, D / 2, D / 2, 0, 7); g.clip();
    g.fillStyle = '#fff'; g.fillRect(0, 0, D, D);
    g.drawImage(src, ccx - side / 2, ccy - side / 2, side, side, 0, 0, D, D);
    const k = D / side;
    const tx = (x) => (x - (ccx - side / 2)) * k;
    const ty = (y) => (y - (ccy - side / 2)) * k;
    cross(g, tx(mk.gx), ty(mk.gy), BLUE, true, D);
    cross(g, tx(mk.cx), ty(mk.cy), RED, false, D);
    g.restore();
  }

  const badge = { pass: ['통과', '#2E7D4F'], warn: ['주의', '#B07A16'], error: ['경고', '#B33A3A'] };
  const rowHtml = (v) =>
    '<div class="row"><span class="badge" style="background:' + badge[v.level][1] + '">' + badge[v.level][0] +
    '</span><div><b>' + v.title + '</b><span class="why">' + v.why + '</span></div></div>';

  // ─ 본체 ─
  function run() {
    const S = 1200;
    const big = draw(S);
    const bd = big.getContext('2d').getImageData(0, 0, S, S).data;

    // 잉크를 알파로 볼 것인가(투명 배경 위 단색 마크), 명도로 볼 것인가(배경 도형 + 속 파낸 형태).
    // 불투명 픽셀 중 어두운 게 유의미하게 섞여 있으면 명도 기준으로 본다.
    // 알파 기준만 쓰면 원판 위에 흰 삼각형을 파낸 형태에서 그 삼각형까지 잉크로 세어 속공간이 0이 된다.
    let opaque = 0, darkOpaque = 0;
    for (let i = 0; i < S * S; i++) {
      if (bd[i * 4 + 3] <= 32) continue;
      opaque++;
      if (bd[i * 4] * 0.299 + bd[i * 4 + 1] * 0.587 + bd[i * 4 + 2] * 0.114 < 160) darkOpaque++;
    }
    const lum = opaque > 0 && darkOpaque / opaque > 0.05;

    // 잉크 경계 + 알파 가중 무게중심
    let minX = S, minY = S, maxX = -1, maxY = -1, sw = 0, sx = 0, sy = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const a = bd[i + 3];
      if (a <= 32) continue;
      const wgt = lum ? 255 - (bd[i] * 0.299 + bd[i + 1] * 0.587 + bd[i + 2] * 0.114) : a;
      if (wgt <= 32) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sw += wgt; sx += wgt * x; sy += wgt * y;
    }
    if (maxX < 0) throw new Error('잉크 픽셀이 하나도 없음');

    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const gx = (minX + maxX) / 2, gy = (minY + maxY) / 2;
    const cx = sx / sw, cy = sy / sw;
    const dx = ((cx - gx) / bw) * 100, dy = ((cy - gy) / bh) * 100;
    const off = Math.max(Math.abs(dx), Math.abs(dy));

    const side = Math.max(bw, bh) / 0.62;
    circlePreview('opt-geo', big, gx, gy, side, { gx, gy, cx, cy });
    circlePreview('opt-cen', big, cx, cy, side, { gx, gy, cx, cy });

    const dir = [];
    if (Math.abs(dx) >= 0.4) dir.push(dx > 0 ? '오른쪽' : '왼쪽');
    if (Math.abs(dy) >= 0.4) dir.push(dy > 0 ? '아래' : '위');
    const lean = dir.length ? dir.join('·') + '쪽으로 쏠려 보인다' : '쏠림이 거의 없다';
    const lv = off < 2 ? 'pass' : off <= 5 ? 'warn' : 'error';
    const why = off < 2 ? '기하 중심 정렬 그대로 써도 안정적이다'
      : off <= 5 ? '원형 락업(프로필·뱃지)은 무게중심 기준으로 따로 배치하는 걸 권한다'
        : '기하 중심에 맞추면 눈에 띄게 치우쳐 보인다. 무게중심 정렬본을 따로 만들어라';

    const optV = [
      { level: lv, title: '광학 중심 벗어남 가로 ' + dx.toFixed(1) + '% / 세로 ' + dy.toFixed(1) + '% (최대 ' + off.toFixed(1) + '%)', why },
      { level: 'pass', title: '잉크 경계 ' + bw + '×' + bh + 'px @' + S + ' 스캔', why: '무게중심이 기하 중심 대비 ' + lean },
    ];
    $('opt-nums').innerHTML = optV.map(rowHtml).join('');

    // ─ 공법 시뮬 ─
    const W = 480;
    const pad = Math.max(bw, bh) * 0.06;
    const side8 = Math.max(bw, bh) + pad * 2;
    const simCv = document.createElement('canvas');
    simCv.width = simCv.height = W;
    const sgx = simCv.getContext('2d', { willReadFrequently: true });
    sgx.drawImage(big, gx - side8 / 2, gy - side8 / 2, side8, side8, 0, 0, W, W);
    const m0 = maskOf(sgx, W, W, lum);

    const stroke = strokeWidth(m0, W, W);
    const r6 = Math.max(1, Math.round((stroke * 0.06) / 2));
    const r12 = Math.max(1, Math.round((stroke * 0.12) / 2));
    const d6 = morph(m0, W, W, r6, true);
    const d12 = morph(m0, W, W, r12, true);
    // 자수 실 한계 ≈ 1mm. 5cm 폭 기준이면 로고 폭의 2% → 침식 반경은 그 절반
    const embR = Math.max(1, Math.round(W * 0.01));
    const emb = morph(m0, W, W, embR, false);
    const fax = faxify(m0, W, W, 3);

    paint($('sim-dot6'), d6, W, W);
    paint($('sim-dot12'), d12, W, W);
    paint($('sim-emb'), emb, W, W);
    paint($('sim-fax'), fax, W, W);

    // 시트지 커팅: 조각(island) 색칠
    const minArea = Math.round(W * W * 0.0004);
    const cc = components(m0, W, W, minArea);
    const keep = new Set(cc.comps.map((c) => c.id));
    const cut = $('sim-cut');
    cut.width = cut.height = W;
    const cg = cut.getContext('2d');
    const im = cg.createImageData(W, W);
    const hue = ['#221A14', '#C4372F', '#2F6FB0', '#2E7D4F', '#B07A16', '#7A4FA3', '#0F8F94', '#B3437F'];
    for (let i = 0; i < W * W; i++) {
      const id = cc.lab[i];
      let col = [255, 255, 255];
      if (id && keep.has(id)) {
        const hx = hue[(id - 1) % hue.length];
        col = [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)];
      } else if (id) col = [200, 200, 200];
      im.data[i * 4] = col[0]; im.data[i * 4 + 1] = col[1]; im.data[i * 4 + 2] = col[2]; im.data[i * 4 + 3] = 255;
    }
    cg.putImageData(im, 0, 0);

    const h0 = holes(m0, W, W, minArea);
    const h6 = holes(d6, W, W, minArea);
    const h12 = holes(d12, W, W, minArea);
    const islands = cc.comps.length;
    const embRatio = ratio(emb) / (ratio(m0) || 1);
    const embIslands = components(emb, W, W, minArea).comps.length;

    const mfV = [];
    if (h0 === 0) mfV.push({ level: 'pass', title: '속공간(카운터) 없음', why: '메워질 안쪽 공간이 애초에 없다. 도트 게인에 강한 형태' });
    else if (h12 < h0) mfV.push({ level: h6 < h0 ? 'error' : 'warn', title: '도트 게인에서 속공간 ' + h0 + '개 → ' + h6 + '/' + h12 + '개', why: (h6 < h0 ? '6%' : '12%') + ' 번짐에서 이미 메워진다. 획을 얇게 하거나 속공간을 키워라' });
    else mfV.push({ level: 'pass', title: '속공간 ' + h0 + '개 유지(6%·12% 모두)', why: '1도 인쇄 번짐에도 안쪽이 안 메워진다' });

    mfV.push(embIslands > islands || embRatio < 0.3
      ? { level: 'warn', title: '자수 침식 후 면적 ' + Math.round(embRatio * 100) + '% · 조각 ' + islands + '→' + embIslands + '개', why: '실 굵기 한계(1mm) 이하 구간이 끊긴다. 5cm 이하 자수는 굵은 버전이 따로 필요' }
      : { level: 'pass', title: '자수 침식 후 면적 ' + Math.round(embRatio * 100) + '% 유지', why: '5cm 폭 자수에서 끊기는 구간 없음' });

    mfV.push({
      level: islands <= 3 ? 'pass' : islands <= 8 ? 'warn' : 'error',
      title: '떨어진 조각 ' + islands + '개',
      why: islands <= 3 ? '시트지 커팅·전사 시공이 쉽다'
        : islands <= 8 ? '유리문 시트지 시공 시 조각별 위치 잡기가 번거롭다. 전사지 필수'
          : '조각이 너무 많다. 시트지 시공 사실상 불가 — 붙임 요소를 통합하라',
    });
    $('mf-nums').innerHTML = mfV.map(rowHtml).join('');

    return {
      offset: { x: +dx.toFixed(2), y: +dy.toFixed(2), max: +off.toFixed(2) },
      ink: { w: bw, h: bh, scan: S, lumFallback: lum },
      stroke: +stroke.toFixed(1),
      islands, holes: [h0, h6, h12],
      sims: { base: ratio(m0), dot6: ratio(d6), dot12: ratio(d12), emb: ratio(emb), fax: ratio(fax) },
      canvases: document.querySelectorAll('#sec7 canvas, #sec8 canvas').length,
      cells8: document.querySelectorAll('#sec8 .cell').length,
      verdicts: optV.concat(mfV),
    };
  }
}

// ── 시트 HTML ─────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildHtml({ brand, file, dataUri, verdicts, arHint }) {
  const now = new Date().toLocaleString('ko-KR', { hour12: false });
  const img = (h, filter = '', extra = '') =>
    `<img src="${dataUri}" style="height:${h}px;width:auto;max-width:100%;${filter ? `filter:${filter};` : ''}${extra}">`;

  const sizes = [16, 24, 32, 48, 64, 128]
    .map((n) => `<div class="cell"><div class="stage" style="height:140px">${img(n)}</div><div class="lab">${n}px</div></div>`)
    .join('');

  const mono = [
    ['원본', ''],
    ['그레이스케일', 'grayscale(1)'],
    ['완전 실루엣', 'brightness(0)'],
  ].map(([t, f]) => `<div class="cell"><div class="stage" style="height:120px">${img(90, f)}</div><div class="lab">${t}</div></div>`).join('');

  const kraft = [
    ['원본 그대로', ''],
    ['검정 실루엣', 'brightness(0)'],
  ].map(([t, f]) => `<div class="cell"><div class="stage kraft" style="height:120px">${img(90, f)}</div><div class="lab">${t}</div></div>`).join('');

  const badge = { pass: ['통과', '#2E7D4F'], warn: ['주의', '#B07A16'], error: ['경고', '#B33A3A'] };
  const rows = verdicts.map((v) => {
    const [txt, col] = badge[v.level];
    return `<div class="row"><span class="badge" style="background:${col}">${txt}</span>
      <div><b>${esc(v.title)}</b><span class="why">${esc(v.why)}</span></div></div>`;
  }).join('');

  const section = (n, title, desc, body, id = '') => `
    <section${id ? ` id="${id}"` : ''}>
      <h2><span class="num">${n}</span>${title}</h2>
      <p class="desc">${desc}</p>
      <div class="body">${body}</div>
    </section>`;

  // ⑦ 광학 중심 — 캔버스는 비워두고 주입 스크립트가 채운다
  const optics = `
    <div class="cell"><canvas id="opt-geo" class="cv round" width="480" height="480" style="width:240px;height:240px"></canvas>
      <div class="lab">(a) 기하 중심 정렬</div><p class="note">잉크 경계의 한가운데를 원 중심에 맞춘 것</p></div>
    <div class="cell"><canvas id="opt-cen" class="cv round" width="480" height="480" style="width:240px;height:240px"></canvas>
      <div class="lab">(b) 무게중심 정렬</div><p class="note">알파 가중 무게중심을 원 중심에 맞춘 것</p></div>
    <div class="cell" style="align-self:center">
      <div class="legend" style="flex-direction:column;align-items:flex-start;gap:8px">
        <span><i class="sw" style="border-top-style:dashed;border-color:#2F6FB0"></i>기하 중심 (bbox 한가운데)</span>
        <span><i class="sw" style="border-color:#C4372F"></i>무게중심 (잉크 분포)</span>
      </div>
      <p class="note" style="margin-left:0;text-align:left">두 칸을 나란히 보고 <b>어느 쪽이 원 안에서 안정적으로 보이는지</b> 눈으로 골라라.</p>
    </div>
    <div class="full" id="opt-nums"></div>
    <div class="full foot">측정은 1200px 캔버스의 알파 채널 스캔이다. getBBox()는 회전된 호를 제어점 기준으로 재서
      실제 잉크보다 최대 12%까지 부풀리므로 쓰지 않았다. 2% / 5% 경계는 실무에서 통용되는 감각이지 절대 기준이 아니다.</div>`;

  // ⑧ 제작 공법 시뮬
  const cv8 = (id, px = 150) => `<canvas id="${id}" class="cv" width="480" height="480" style="width:${px}px;height:${px}px"></canvas>`;
  const mfg = `
    <div class="cell">
      <div class="cap">1도 인쇄 도트 게인</div>
      <div class="pair">${cv8('sim-dot6', 118)}${cv8('sim-dot12', 118)}</div>
      <div class="lab">획 +6% / +12% 번짐</div>
      <p class="note" style="max-width:244px">잉크가 번져 획이 굵어진다. <b>속공간이 메워지는지</b>를 본다.</p>
    </div>
    <div class="cell">
      <div class="cap">자수</div>${cv8('sim-emb')}
      <div class="lab">5cm 폭 · 실 한계 침식</div>
      <p class="note">실 굵기(약 1mm) 이하로 얇은 구간이 <b>끊겨서 사라지는지</b> 본다.</p>
    </div>
    <div class="cell">
      <div class="cap">팩스·복사 3회</div>${cv8('sim-fax')}
      <div class="lab">저해상 축소 + 이진화 ×3</div>
      <p class="note">세무·법무 서식에 실려 3번 복사돼도 <b>형태가 남는지</b> 본다.</p>
    </div>
    <div class="cell">
      <div class="cap">시트지 커팅</div>${cv8('sim-cut')}
      <div class="lab">떨어진 조각 색 구분</div>
      <p class="note">색이 다르면 다른 조각이다. <b>조각이 많을수록</b> 유리문 시공이 어렵다.</p>
    </div>
    <div class="full" id="mf-nums"></div>`;

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { background:#F2F1EE; font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;
         color:#1C1B19; padding:36px 40px 44px; width:960px; }
  header { border-bottom:2px solid #1C1B19; padding-bottom:14px; margin-bottom:28px; }
  h1 { font-size:26px; letter-spacing:-0.5px; }
  header .meta { margin-top:6px; font-size:12px; color:#6B675F; }
  section { background:#fff; border:1px solid #DEDBD4; border-radius:10px;
            padding:20px 22px 22px; margin-bottom:18px; }
  h2 { font-size:16px; display:flex; align-items:center; gap:9px; }
  .num { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px;
         border-radius:50%; background:#1C1B19; color:#fff; font-size:12px; flex:none; }
  .desc { font-size:12.5px; color:#6B675F; margin:7px 0 16px; line-height:1.5; }
  .body { display:flex; flex-wrap:wrap; gap:20px; align-items:flex-end; }
  .cell { text-align:center; }
  .stage { display:flex; align-items:center; justify-content:center; min-width:150px;
           padding:0 14px; background:#FAFAF8; border:1px solid #EAE7E0; border-radius:6px; }
  .lab { font-size:11.5px; color:#6B675F; margin-top:7px; }
  .kraft { background:#A67B5B; border-color:#8C6446; }
  .dark { background:#141414; border-color:#141414; }
  .circle { width:240px; height:240px; border-radius:50%; overflow:hidden; background:#fff;
            border:1px solid #EAE7E0; display:flex; align-items:center; justify-content:center; }
  .clear { padding:30px; border:2px dashed #C4372F; display:inline-flex; }
  .row { display:flex; gap:11px; align-items:baseline; padding:8px 0; border-bottom:1px solid #F0EEE9; font-size:13px; }
  .row:last-child { border-bottom:0; }
  .badge { color:#fff; font-size:11px; padding:2px 8px; border-radius:4px; flex:none; }
  .why { color:#6B675F; font-size:12px; margin-left:8px; }
  footer { margin-top:22px; font-size:11px; color:#8C877D; text-align:center; }
  .full { flex-basis:100%; }
  .cv { display:block; background:#fff; border:1px solid #EAE7E0; border-radius:6px; }
  .cv.round { border-radius:50%; }
  .note { font-size:11px; color:#8C877D; line-height:1.45; margin:5px auto 0; max-width:170px; }
  .legend { display:flex; gap:18px; align-items:center; font-size:11.5px; color:#6B675F; }
  .sw { display:inline-block; width:16px; border-top:2px solid; margin-right:6px; vertical-align:middle; }
  .pair { display:flex; gap:8px; }
  .cap { font-size:12.5px; font-weight:600; margin-bottom:2px; }
  .foot { font-size:11px; color:#8C877D; margin-top:12px; line-height:1.5; }
  </style></head><body>
  <header>
    <h1>${esc(brand)} — 로고 검증 시트</h1>
    <div class="meta">${esc(file)} · ${now}</div>
  </header>

  ${section(1, '크기 테스트', '16px에서 형태가 뭉개지지 않고 무엇인지 알아볼 수 있나? 안 되면 디테일을 덜어내라.', sizes)}
  ${section(2, '1색 흑백', '색을 뺐을 때도 요소가 서로 구분되나? 실루엣 칸에서 덩어리로 뭉치면 명도 대비가 없는 것이다.', mono)}
  ${section(3, '반전', '어두운 배경에서 흰 로고가 가늘어져 사라지지 않나? 얇은 선은 반전에서 먼저 죽는다.',
    `<div class="cell"><div class="stage dark" style="height:150px">${img(100, 'brightness(0) invert(1)')}</div><div class="lab">#141414 배경 / 흰색 강제</div></div>`)}
  ${section(4, '크라프트 배경', '중간 명도 갈색 위에서도 읽히나? 실제 종이봉투·패키지가 이 밝기다.', kraft)}
  ${section(5, '인스타 원형 크롭', '프로필 원 안에서 잘리는 부분은 없나? 여백이 너무 많아 작아 보이지는 않나?',
    `<div class="cell"><div class="circle">${img(120)}</div><div class="lab">지름 240px</div></div>`)}
  ${section(6, '여백 침범 테스트', '점선은 최소 여백선(로고 높이의 25%). 실제 배치에서 이 선 안으로 다른 요소가 들어오면 안 된다.',
    `<div class="cell"><div class="clear">${img(110)}</div><div class="lab">clear space = 로고 높이 × 0.25</div></div>`)}
  ${section(7, '광학 중심 측정', '잉크가 실제로 어디에 몰려 있나? 회전된 형태는 기하 중심에 맞춰도 원형 크롭에서 한쪽으로 쏠려 보인다. 목업 가서 발견하지 말고 여기서 잡아라.', optics, 'sec7')}
  ${section(8, '제작 공법 시뮬레이션', '인쇄·자수·복사·커팅에서 미리 실패시켜 본다. 네 칸이 서로 다르게 보여야 정상이고, 각 칸에서 볼 것은 아래 설명대로다.', mfg, 'sec8')}

  <section>
    <h2><span class="num">✓</span>자동 판정</h2>
    <p class="desc">SVG 파일을 기계적으로 검사한 결과. 형태의 좋고 나쁨은 위 칸을 눈으로 보고 판단하라.</p>
    ${rows}
  </section>
  <footer>verify-logo.mjs · 눈으로 볼 것: 16px 식별 / 실루엣 뭉침 / 반전 시 가늘어짐 / 원형 크롭 쏠림 / 공법 4칸</footer>
  <script>(${pageScript})(${JSON.stringify(dataUri)}, ${arHint});</script>
  </body></html>`;
}

// ── 메인 파이프라인 ───────────────────────────────────────────────
async function verify(svgPath, { outDir, brand } = {}) {
  const svg = readFileSync(svgPath, 'utf8');
  const file = basename(svgPath);
  const dir = outDir ?? dirname(resolve(svgPath));
  mkdirSync(dir, { recursive: true });
  const outPng = join(dir, 'verify-sheet.png');

  const { verdicts, paths, nodes } = audit(svg);
  const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  // viewBox 종횡비 — 브라우저가 naturalWidth를 0으로 주는 SVG용 폴백
  const vb = svg.match(/viewBox\s*=\s*"([^"]*)"/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const arHint = vb?.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : 1;
  const html = buildHtml({ brand: brand ?? file.replace(/\.svg$/i, ''), file, dataUri, verdicts, arHint });

  const chromium = await loadChromium();
  const browser = await chromium.launch();
  let optics;
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 1200 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__optics, null, { timeout: 30000 });
    optics = await page.evaluate(() => window.__optics);
    await page.screenshot({ path: outPng, fullPage: true });
  } finally {
    await browser.close();
  }
  if (optics?.error) console.error(`  ⚠︎ 픽셀 측정 실패: ${optics.error}`);
  const all = verdicts.concat(optics?.verdicts ?? []);
  return { outPng, verdicts: all, paths, nodes, optics };
}

function report({ outPng, verdicts, optics }) {
  const mark = { pass: '[통과]', warn: '[주의]', error: '[경고]' };
  console.log('');
  for (const v of verdicts) console.log(`  ${mark[v.level]} ${v.title} — ${v.why}`);
  if (optics && !optics.error)
    console.log(`\n  광학 중심 벗어남 ${optics.offset.max}% (가로 ${optics.offset.x}% / 세로 ${optics.offset.y}%)` +
      ` · 조각 ${optics.islands}개 · 속공간 ${optics.holes.join('→')}개 · 획 약 ${optics.stroke}px`);
  const bad = verdicts.filter((v) => v.level !== 'pass').length;
  console.log(`\n  검증 시트: ${outPng}`);
  console.log(bad ? `  주의/경고 ${bad}건. 위 목록을 먼저 처리하라.` : '  기계 검사 이상 없음. 시트를 눈으로 확인하라.');
}

// ── 셀프테스트 ────────────────────────────────────────────────────
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="46" fill="#1C1B19"/>
  <path d="M30 62 L50 28 L70 62 Z" fill="#F2F1EE"/>
</svg>`;

async function selftest() {
  const dir = join(tmpdir(), 'verify-logo-selftest');
  mkdirSync(dir, { recursive: true });
  const svgPath = join(dir, 'sample.svg');
  writeFileSync(svgPath, SAMPLE_SVG);

  const r = await verify(svgPath, { brand: 'SELFTEST' });
  if (!existsSync(r.outPng)) throw new Error('셀프테스트 실패: PNG가 생성되지 않음');
  if (statSync(r.outPng).size <= 0) throw new Error('셀프테스트 실패: PNG 크기가 0');
  if (r.verdicts.some((v) => v.level === 'error')) throw new Error('셀프테스트 실패: 정상 SVG인데 경고가 떴다');

  // ⑦ 광학 중심 — 수치가 실제로 나오는지
  const o = r.optics;
  if (!o || o.error) throw new Error(`셀프테스트 실패: 픽셀 측정 실패 — ${o?.error ?? 'undefined'}`);
  if (!Number.isFinite(o.offset.max) || !Number.isFinite(o.offset.x))
    throw new Error('셀프테스트 실패: 광학 중심 수치가 숫자가 아님');
  if (!(o.ink.w > 0 && o.ink.h > 0)) throw new Error('셀프테스트 실패: 잉크 경계가 0');
  if (o.canvases !== 7) throw new Error(`셀프테스트 실패: 캔버스 7개(⑦2+⑧5)여야 하는데 ${o.canvases}개`);
  if (o.cells8 !== 4) throw new Error(`셀프테스트 실패: 공법 칸이 4개여야 하는데 ${o.cells8}개`);

  // ⑧ 공법 4칸 — 시뮬이 실제로 다른 결과를 냈는지(전부 같으면 안 먹은 것)
  const s = o.sims;
  if (!(s.base > 0)) throw new Error('셀프테스트 실패: 실루엣이 비었다');
  if (!(s.dot12 > s.dot6 && s.dot6 > s.base)) throw new Error('셀프테스트 실패: 도트 게인 팽창이 안 먹었다');
  if (!(s.emb < s.base)) throw new Error('셀프테스트 실패: 자수 침식이 안 먹었다');
  if (s.fax === s.base) throw new Error('셀프테스트 실패: 팩스 열화가 안 먹었다');
  if (!(o.islands >= 1)) throw new Error('셀프테스트 실패: island 카운팅이 0');
  if (o.holes[0] < 1) throw new Error('셀프테스트 실패: 샘플의 삼각 속공간을 못 잡았다');

  // 경고 경로도 확인 — text + gradient가 실제로 잡히는지
  const bad = audit(`<svg><text x="0">A</text><linearGradient id="g"/><path d="M0 0"/></svg>`);
  const levels = bad.verdicts.map((v) => v.level);
  if (!levels.includes('error') || !levels.includes('warn'))
    throw new Error('셀프테스트 실패: 불량 SVG에서 경고/주의가 안 잡힘');

  console.log(`셀프테스트 통과 — ${r.outPng} (${statSync(r.outPng).size} bytes)`);
}

// ── CLI ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  await selftest();
} else {
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const input = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out' && argv[argv.indexOf(a) - 1] !== '--name');
  if (!input) {
    console.error('사용법: node verify-logo.mjs <input.svg> [--out <dir>] [--name <브랜드명>]');
    process.exit(1);
  }
  if (!existsSync(input)) { console.error(`파일 없음: ${input}`); process.exit(1); }
  report(await verify(input, { outDir: flag('--out'), brand: flag('--name') }));
}
