# STYLE.md — 산출물(HTML·PDF)과 base 글쓰기 규칙

이 저장소의 산출물은 **시험장에서 읽는 단권화**다. 매일 도는 LLM 작업과 사람이 손으로 쓰는 기록 모두
이 규칙을 따른다. 규칙은 두 스킬에서 가져왔다 — `design-craft`(표면), `human-readable-writing`(문장).

## 1. 문장 (human-readable-writing)

- **결론 먼저.** 절 제목 아래 첫 줄에 그 절의 결론·판단을 쓴다. 배경 설명으로 시작하지 않는다.
- **한 문장에 한 가지.** 주어와 동작을 붙인다("검사가 시행되었다" → "담당의가 검사를 했다").
- 명사 더미를 동사로 푼다. 형용사·부사는 지워도 뜻이 같으면 지운다.
- **표는 표로 둔다.** 수치·용량·기준은 문장으로 풀지 말고 표·불릿으로 남긴다. 해석만 문장으로 쓴다.
- 수치·단위·약물명·검사명·부정·조건은 원문 표기를 그대로 보존한다. 문체를 다듬다 인과를 새로 만들지 않는다.
- 같은 말을 두 번 하지 않는다. 요약 뒤에 같은 디테일을 반복하지 않는다.
- 목록은 진짜 나열일 때만. 원인→결과로 이어지는 내용은 문장으로 잇는다.

## 2. 표면 (design-craft)

- 색·간격·글꼴은 **`templates/style.css` 의 토큰만** 쓴다. hex/px 하드코딩 금지.
  색 계열: clinical-cool(악센트 `#0D6C87`). 색을 바꾸려면 토큰 한 곳만 고친다.
- 제목 계층은 h1(대단원) → h2(소단원) → h3(소제목) 순서를 지킨다. 건너뛰지 않는다.
- 이미지에는 `alt` 를 넣는다(빌드가 파일명으로 자동 채운다).
- 본문 최소 16px(화면) / 10pt(인쇄). 캡션·라벨은 12.5~13px 허용.
- A4 인쇄에서 대단원은 새 쪽에서 시작하고, 제목이 쪽 끝에 홀로 남지 않게 한다(`break-after: avoid`).
- 좌우 여백은 `--pad-x` 토큰 하나로만 만든다. `padding: X 0 Y` 축약형으로 덮지 않는다.

## 3. base 편집 (매일 도는 작업)

- base 는 **덧붙이기 전용**이다. 기존 줄을 지우거나 고치지 않는다.
- 새 내용은 해당 대단원 파일의 **맞는 소단원(`### 제목`) 아래**에 불릿으로 붙인다.
- 맞는 소단원이 없으면 파일 끝 `### 기타` 에 붙이고, 같은 주제가 3개 이상 쌓이면 소단원으로 승격한다.
- 중복은 넣지 않는다. 같은 사실이 이미 있으면 더 정확한 표현만 덧붙인다.
- 소단원 내용이 80자 미만으로 얇으면 `### 기타`·`### 총론` 로 묶는다(빌드 스크립트가 처리).
- 파일 머리의 `division:`·`sources:` front matter 는 건드리지 않는다.

## 4. 검증

```bash
node scripts/build.mjs --no-pdf                       # HTML 생성
python3 scripts/build_base.py                         # docx → base (증분)
python3 ~/.config/opencode/skills/design-craft/scripts/design-lint.py dist \
        --tokens templates/style.css                  # HIGH 0
~/.config/opencode/skills/design-craft/scripts/page-check.sh dist/index.html --width 1440
```

PDF 는 CI 에서 만든다(`.github/workflows/build.yml`). 빌드는 한글 글꼴이 빠지면 실패하고,
PDF 에 대단원/소단원 북마크를 심는다.
