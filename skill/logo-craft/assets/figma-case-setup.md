# 케이스 작업 파일 자동 구축 (Figma)

새 로고 케이스를 시작할 때, 피그마 파일 하나를 3페이지 구조로 세팅한다.
아래 코드는 `use_figma` 툴에 그대로 넣어 순서대로 실행한다. **한 번에 다 넣지 말고 5단계로 나눠 실행한다.**

## 전제

- `figma-create-new-file` 스킬을 먼저 로드하고 `create_new_file`로 파일 생성 (`editorType: "design"`)
- 파일명 규칙: `로고 스튜디오 — 케이스 NN 브랜드명`
- **Figma Starter 플랜은 파일당 3페이지가 상한.** 4번째 `createPage()`는 에러. 그래서 섹션(`figma.createSection()`)으로 묶는다.
- 한글 폰트: `Noto Sans KR` (Regular / Medium / Bold). 스타일명 정확히 이 표기.
- 케이스마다 새 파일. 기존 케이스 파일을 복제해 쓰면 이 스크립트는 불필요하다.

## 페이지 구성

| 페이지 | 섹션 |
|---|---|
| `01 · 리서치 + 스케치` | 00 시작하기(브리프+합격기준) · 01 경쟁사 12 · 02 무드보드 6 · 03 팔레트·폰트 · 04 스케치 30안 |
| `02 · 벡터 + 작도` | 01 심볼 작업 아트보드(1000×1000 + 작도 가이드) · 02 시안 비교 5 · 03 조합형 4 |
| `03 · 검증 + 적용` | 01 검증 보드 6종 · 02 적용 목업 6 · 03 브랜드 가이드 A4 5장 |

---

## STEP 1 — 페이지 3개

```js
const names = ["01 · 리서치 + 스케치", "02 · 벡터 + 작도", "03 · 검증 + 적용"];
figma.root.children[0].name = names[0];
while (figma.root.children.length < 3) {
  const p = figma.createPage();
  p.name = names[figma.root.children.length - 1];
}
figma.root.children.forEach((p, i) => { p.name = names[i]; });
return { pages: figma.root.children.map(p => ({ name: p.name, id: p.id })) };
```

## 공통 헬퍼

STEP 2~5 각 스크립트 맨 위에 붙여 쓴다. (`use_figma` 호출 간에 변수는 유지되지 않는다)

```js
await figma.loadFontAsync({family:"Noto Sans KR", style:"Regular"});
await figma.loadFontAsync({family:"Noto Sans KR", style:"Medium"});
await figma.loadFontAsync({family:"Noto Sans KR", style:"Bold"});
const INK={r:.102,g:.102,b:.094}, MUTED={r:.541,g:.525,b:.494}, GOLD={r:.784,g:.631,b:.353};
const BG={r:.949,g:.945,b:.933}, KRAFT={r:.651,g:.482,b:.357};
const solid=c=>[{type:"SOLID",color:c}];
function T(txt,{size=13,style="Regular",color=INK,w=800,ls=0,lh=1.6}={}){
  const t=figma.createText();
  t.fontName={family:"Noto Sans KR",style};
  t.characters=txt; t.fontSize=size; t.fills=solid(color);
  t.letterSpacing={unit:"PERCENT",value:ls};
  t.lineHeight={unit:"PERCENT",value:lh*100};
  t.textAutoResize="HEIGHT"; t.resize(w,t.height);
  return t;
}
function box(name,w,h,fill,dashed=true){
  const f=figma.createFrame(); f.name=name; f.resize(w,h);
  f.fills=solid(fill||{r:1,g:1,b:1});
  f.strokes=solid({r:.85,g:.84,b:.82}); f.strokeWeight=1;
  if(dashed) f.dashPattern=[6,6];
  return f;
}
function sec(name,x,y,w,h){
  const s=figma.createSection(); s.name=name; s.x=x; s.y=y;
  s.resizeWithoutConstraints(w,h); s.fills=solid(BG);
  return s;
}
```

## STEP 2 — 페이지 1 : 브리프 카드

`await figma.setCurrentPageAsync(figma.root.children[0])` 로 시작.
`sec("00 · 시작하기",0,0,1240,1080)` 안에 세로 auto-layout 카드 하나.
카드 내용 순서 — 케이스 브리프(`cases/NN-*/brief.md`)에서 그대로 옮긴다:

1. `CASE NN` (11px Medium GOLD, letterSpacing 18%)
2. 브랜드명 · 업종 (40px Bold)
3. 클라이언트 설정 2~3줄 (15px MUTED)
4. `납품물` 라벨 + 내용
5. `제약` 라벨 + 내용
6. `합격기준 — 하나라도 못 넘으면 다음 단계로 안 감` 라벨 + 번호 목록 (공통 6 + 케이스별 추가)
7. 작업 순서 한 줄 (13px MUTED)

텍스트 폭은 **800**. 그보다 좁으면 한글 줄바꿈이 어색해진다.

## STEP 3 — 페이지 1 : 리서치 + 스케치 섹션

- `sec("01 · 경쟁사 12곳",1400,0,2000,1080)` — `box("경쟁사 NN",420,220)` 12개, 4열 × 3행, x=60+col*470, y=130+row*260
- `sec("02 · 무드보드",3500,0,1500,1080)` — `box("무드 N",440,380)` 6개, 3열 × 2행
- `sec("03 · 팔레트 · 폰트 후보",5100,0,1200,1080)` — 가로 auto-layout 3줄(각 180×100 스와치 5개) + `box("폰트 후보 N",900,140)` 3개
- `sec("04 · 스케치 30안",0,1200,3060,1560)` — `box("안 NN",440,220)` 30개, 6열 × 5행, 각 프레임 좌상단에 번호 텍스트

각 섹션 상단에 무엇을 하는 칸인지 한 줄 안내(14px MUTED), 하단에 판정 기준 한 줄(13px GOLD).

## STEP 4 — 페이지 2 : 작업 아트보드 + 작도 가이드

`await figma.setCurrentPageAsync(figma.root.children[1])`

```js
const art = figma.createFrame();
art.name = "심볼 작업 (1000×1000)";
art.resize(1000,1000);
art.fills = solid({r:1,g:1,b:1});
// 섹션에 append 후 위치 지정
art.layoutGrids = [
  {pattern:"GRID", sectionSize:50, visible:true, color:{r:0,g:0,b:0,a:.05}},
  {pattern:"COLUMNS", alignment:"STRETCH", gutterSize:20, count:8, offset:100, visible:true, color:{r:.78,g:.63,b:.35,a:.08}}
];

const g = figma.createFrame();
g.name = "작도 가이드 (끄고 켜기)";
g.resize(1000,1000); g.fills = [];
art.appendChild(g); g.x = 0; g.y = 0;

// 동심원 r=100/200/300/400
[400,300,200,100].forEach(r => {
  const e = figma.createEllipse();
  e.resize(r*2, r*2); e.x = 500-r; e.y = 500-r;
  e.fills = []; e.strokes = solid(GOLD); e.strokeWeight = 1; e.opacity = .45;
  e.name = `원 r=${r}`;
  g.appendChild(e);
});
// 축 2개 — createLine은 가로선이므로 세로는 rotation -90
const vAxis = figma.createLine();
vAxis.strokes = solid(GOLD); vAxis.strokeWeight = 1; vAxis.opacity = .45; vAxis.name = "세로축";
g.appendChild(vAxis); vAxis.resize(1000,0); vAxis.rotation = -90; vAxis.x = 500; vAxis.y = 0;
const hAxis = figma.createLine();
hAxis.strokes = solid(GOLD); hAxis.strokeWeight = 1; hAxis.opacity = .45; hAxis.name = "가로축";
g.appendChild(hAxis); hAxis.resize(1000,0); hAxis.x = 0; hAxis.y = 500;
// 대각 2개 (1000×1000의 대각 길이 ≈ 1414)
[45,-45].forEach(deg => {
  const l = figma.createLine();
  l.strokes = solid(GOLD); l.strokeWeight = 1; l.opacity = .25; l.name = `대각 ${deg}°`;
  g.appendChild(l); l.resize(1414,0); l.rotation = deg;
  l.x = -207; l.y = deg > 0 ? 1207 : -207;
});
g.locked = true;  // 실수로 끌려가지 않게
```

같은 페이지에 이어서:
- `sec("02 · 시안 비교 (3~5안)",1500,0,1800,900)` — 300×300 시안칸 5개 + 그 아래 "이유" 칸 300×180 5개
- `sec("03 · 조합형 (lock-up)",1500,1000,1800,600)` — 400×320 칸 4개: 가로형 / 세로형 / 심볼 단독 / 워드마크 단독

## STEP 5 — 페이지 3 : 검증 보드 + 적용 + 가이드

`await figma.setCurrentPageAsync(figma.root.children[2])`

**검증 보드**가 이 파일의 핵심이다. `sec("01 · 검증 보드",0,0,2400,1500)`:

| 칸 | 내용 |
|---|---|
| ① 최소 크기 | 16 / 24 / 32 / 48 / 64 / 120 px 정사각 프레임, 각 아래 px 라벨 |
| ② 1색 (흑백) | 460×340 흰 배경 |
| ③ 반전 | 460×340, 배경 `{r:.078,g:.078,b:.078}` |
| ④ 크라프트 | 460×340, 배경 KRAFT (#A67B5B) |
| ⑤ 인스타 원형 | 340×340, `cornerRadius = 170` |
| ⑥ 실루엣 비교 | 420×300 네 칸 — 내 안 / 경쟁사 A / B / C |

하단 문구 고정: **"여섯 칸 전부 통과해야 다음으로 간다. 하나라도 걸리면 형태를 고치지 칸을 고치지 않는다."**

- `sec("02 · 적용 목업",2500,0,1900,900)` — 간판 860×420 / 종이봉투 380×420 / 스티커 380×420 / 인스타 400×400 / 명함 400×240 / 메뉴판 헤더 860×240
- `sec("03 · 브랜드 가이드 시트",2500,1000,1900,1500)` — A4 가로(842×595) 5장: 조합형·단독형 / 여백 규칙 / 최소크기·1색·반전 / 컬러값·폰트 / 금지 사용 8가지

---

## 실행 후 확인

1. `get_screenshot`으로 브리프 카드와 검증 보드를 실제로 렌더해 본다
2. 한글이 깨지지 않았는지, 줄바꿈이 어색하지 않은지 확인 (어색하면 텍스트 `resize(800, t.height)`)
3. 작도 가이드의 원·축·대각이 정확히 중심에서 만나는지 확인
4. 파일 URL을 프로젝트 `PROGRESS.md`에 기록

## 걸리는 지점

| 증상 | 원인 | 대응 |
|---|---|---|
| `The Starter plan only comes with 3 pages` | 무료 플랜 페이지 상한 | 섹션으로 묶는다. 케이스마다 새 파일 |
| `Cannot write to node with unloaded font` | 폰트 로드 누락 | 스크립트 맨 위에서 `loadFontAsync` 3종 |
| `Setting figma.currentPage is not supported` | 동기 setter 사용 | `await figma.setCurrentPageAsync(page)` |
| 한글이 네모로 보임 | 폰트 패밀리 오타 | `Noto Sans KR` 정확히. 스타일은 `Medium`(`SemiBold` 아님) |
| 줄바꿈이 단어 중간에서 끊김 | 텍스트 폭이 좁음 | 폭 800 이상 |
