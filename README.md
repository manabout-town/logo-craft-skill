# logo-craft — 로고 제작·비평·납품 (Claude Code 스킬)

로고·심볼·워드마크를 만들거나, 시안을 비평하거나, 납품물(벡터·브랜드 가이드·목업)을 준비할 때 쓰는 스킬.

- **AI 경계선**: 로고 최종 형태는 이미지 생성 AI로 만들지 않는다(래스터라 벡터 납품 불가). AI는 발산·조사·조판·검증 담당.
- 작업 순서 6단계: 리서치 → 발산 → 정제 → 검증 → 적용 → 가이드
- 시안 비평 고정 형식, 납품 체크리스트 33개, 공법별 제약표 10종(인쇄·자수·각인·간판…)
- **SVG 자동 검증 시트**: 크기 6단계·1색·반전·크라프트·원형 크롭·여백·광학 중심·제작 공법 시뮬레이션 + 기계 판정

## 설치
```bash
git clone https://github.com/manabout-town/logo-craft-skill.git
cd logo-craft-skill && ./install.sh     # → ~/.claude/skills/logo-craft
```

## 검증 시트
```bash
node ~/.claude/skills/logo-craft/assets/verify-logo.mjs <로고.svg> --name "브랜드명"   # → verify-sheet.png
node ~/.claude/skills/logo-craft/assets/verify-logo.mjs --selftest
```
playwright가 필요하다(로컬 또는 `npm i -g playwright` 전역 설치 모두 인식).

## 구성
```
skill/logo-craft/
├── SKILL.md                     AI 경계선 · 작업 순서 · 검증 · 비평 원칙 · 흔한 실패
├── references/
│   ├── critique.md              시안 비평 고정 출력 형식
│   ├── deliverables.md          납품 티어·포맷·변형·브랜드 가이드·공법 제약·계약 상식·체크리스트
│   ├── prompt-cards.md          비개발자가 Claude에게 말하는 문장 카드 14개
│   └── blind-read.md            사전 정보 없이 읽히는지 보는 블라인드 테스트
└── assets/
    ├── verify-logo.mjs          SVG 검증 시트 생성기
    ├── blind-stimulus.mjs       블라인드 테스트 자극물 생성
    └── figma-case-setup.md      케이스용 피그마 파일 자동 구축
```
MIT.
