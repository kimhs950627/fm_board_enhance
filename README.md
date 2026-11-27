# fm_board_enhance

가정의학과 전문의 기출(2020–2025)에서 **되짚어볼 개념과 문제**를 모아 **단권화**하는 저장소.
브라우저 입력 앱에서 텍스트(굵게·밑줄)와 이미지를 넣고 저장하면 기록이 하나씩 쌓이고,
그걸 카테고리로 묶어 **시험장에 들고 갈 HTML/PDF 한 권**으로 빌드한다.

## 흐름

```
단원별정리 docx  →  scripts/build_base.py  →  base/<대단원>.md   (기본 교재)
입력 앱(브라우저)  →  notes/<id>/entry.md    →  매일 LLM이 base에 덧붙임
                                              →  dist/ (HTML + PDF)
```

- **base/** — `fm 보드시험 단원별정리/*.docx` 를 옮긴 기본 교재. 대단원마다 파일 하나.
  `python3 scripts/build_base.py` 로 다시 뽑으며, 이미 있는 소제목은 새로 덮지 않는다(덧붙이기 전용).
  내용이 적은 소제목은 `### 총론`(첫 머리말) · `### 기타`(나머지)로 묶는다.
  `base/categories.json` 은 입력 앱의 대단원·소단원 선택지가 된다.
- **notes/** — 사용자가 쓰는 기록. base 와 별개로 남는다.
- **글·디자인 규칙** — `STYLE.md`. HTML·PDF 는 `design-craft`(토큰·타이포·인쇄 규칙)와
  `human-readable-writing`(결론 먼저·문장 규칙)을 따른다.
- **매일 04:00** — git pull → `polished.md` 생성 → LLM이 오늘 기록을 base 의 맞는 소단원에 덧붙임
  (기존 줄이 하나라도 지워지면 자동으로 되돌린다) → 빌드 → 커밋·푸시.

## 사용법

```powershell
npm start     # 입력 앱 열기 (http://127.0.0.1:4173)
npm run share # 같은/다른 네트워크의 휴대폰·랩탑에서 접속 (Cloudflare 터널)
npm run base  # docx → base/*.md 다시 뽑기 (기존 소제목은 건드리지 않음)
npm run build # HTML + PDF 빌드
npm run watch # notes/ 변경 감시 → 자동 빌드
```

### GitHub Pages (권장 입력 경로)

- 편집기: `https://kimhs950627.github.io/fm_board_enhance/new.html`
- 목록/PDF: `https://kimhs950627.github.io/fm_board_enhance/`
- Pages의 편집기는 서버가 없으므로 **GitHub API로 직접 커밋**한다.
  첫 저장 때 fine-grained token(권한: Contents = Read and write, 이 저장소만)을 붙여넣으면
  브라우저 localStorage에 저장되고, 이후엔 묻지 않는다.
- 저장 → Action이 자동 빌드 → 1~2분 뒤 Pages의 PDF가 갱신된다.

### 매일 새벽 자동 정리

Windows 작업 스케줄러가 04:00에 `scripts/daily.mjs` 를 실행한다.

1. `git pull`
2. `polished.md` 가 없는 노트만 추출
3. `cmdc -p` (모델 `deepseek/deepseek-v4.1-flash`, effort `low`) 가 `TRIAGE.md` 규칙대로
   `notes/<id>/polished.md` 작성 + `categories` 확정
4. `polished.md` 누락/빌드 실패 시 커밋하지 않고 중단
5. `git commit && push` → Action이 Pages 갱신

- **원본 `entry.md` 는 절대 수정하지 않는다.** 다듬은 결과만 `polished.md` 로 남으므로 diff로 검수 가능.
- `entry.md` front matter에 `locked: true` 를 넣으면 자동 정리에서 제외된다.
- 로그: `logs/daily-YYYY-MM-DD.log`

```powershell
# 스케줄 등록 (관리자 PowerShell 불필요)
schtasks /Create /TN "fm_board_enhance daily" /SC DAILY /ST 04:00 ^
  /TR "node D:\board_test_recon\fm_board_enhance\scripts\daily.mjs" /F

schtasks /Run /TN "fm_board_enhance daily"   # 즉시 1회 실행
schtasks /Query /TN "fm_board_enhance daily" /V /FO LIST
```


### 토큰 (pat.txt)

- 저장소 루트에 `pat.txt` 를 두고 fine-grained PAT(Contents: Read and write, 이 저장소만)를 한 줄로 넣는다.
  **`.gitignore` 대상이라 커밋되지 않는다.**
- `npm start` 로 연 편집기는 이 토큰을 자동으로 받아 첫 저장 때 묻지 않는다.
  주입은 **이 PC(localhost Host + 로컬 접속)** 에만 일어나고, `npm run share` 터널로 들어온 요청에는
  토큰이 실리지 않는다(외부 노출 방지).
- GitHub Pages(공개 사이트)는 토큰을 받을 수 없다. 다른 기기·브라우저에서는 예전처럼 한 번 붙여넣고
  `localStorage` 에 남긴다.

### 계층 점검 (매일)

- `python3 scripts/hierarchy_audit.py` → `reports/hierarchy-audit.md`: 아직 평평한 소단원 순위
  (긴 불릿 목록, 한 줄에 뭉친 계층, 잘못된 들여쓰기를 점수화).
- 새벽 작업이 1순위 섹션 하나를 `scripts/hierarchy_llm.mjs` 로 LLM 에 넘겨 계층만 정리한다.
  글자 보존 검사(`check_content.py`)를 통과해야 남고, 실패하면 그 파일만 되돌린다.
- 처리한 섹션은 `reports/hierarchy-done.json` 에 쌓여 매일 다음 순위로 내려간다.

### 기록 수정

- 입력 앱 아래 '최근 기록' 목록에서 **수정** 을 누르면 그 기록의 마크다운 원문이 편집기에 열린다.
- 제목·대단원·소단원을 바꾸고 본문을 고쳐 저장하면 **같은 기록을 새 판으로** 커밋한다(새 기록을 만들지 않는다).
- 수정하면 `merged: true` 가 풀려 다음 새벽 병합에서 기본 교재에 다시 반영된다.

### 입력 앱

- 굵게 `Ctrl+B`, 밑줄 `Ctrl+U`, 이미지는 **Ctrl+V 붙여넣기** 또는 드래그/선택 — **여러 장 가능**
- 카테고리: **대단원 → 소단원** 두 상자에서 고른다. 소단원 목록은 docx 에서 뽑은 것이고,
  없으면 각 대단원의 **기타(직접 입력)** 으로 새 이름을 넣는다
- `Ctrl+Enter` 저장
- 저장 위치: `notes/<timestamp>/entry.md` (이미지는 같은 폴더에 `img-N.png`)
- **표**: 본문에 `<table>` … `</table>` 을 글자로 적으면 빌드가 표로 그린다.
  안쪽은 한 줄에 한 행, 칸은 `|` 또는 탭으로 나누고 **첫 줄이 머리행**이다. 웹페이지에서 표를 복사해
  붙여넣어도 앱이 같은 형식으로 남긴다. 이미 `<tr>`/`<td>` 로 쓴 HTML 표는 손대지 않는다.

### 외부 접속

```powershell
npm run share
```

Cloudflare 퀵 터널이 뜨고 `https://xxxx.trycloudflare.com/?k=<비밀키>` 주소가 출력된다.
그 주소를 휴대폰에 열면 같은 와이파이가 아니어도 입력·저장할 수 있다.

- 주소는 실행할 때마다 바뀐다. 켜 둔 동안만 살아 있다.
- 첫 접속 때 비밀키가 쿠키로 저장되어, 이후에는 주소만으로 들어간다.
- 파일은 이 PC에 그대로 쌓인다(클라우드 저장 아님). PC가 꺼지면 접속도 끊긴다.
- `dist/` 는 공개하지 않는다. PDF만 공유하려면 파일을 직접 보내는 편이 안전하다.

### 카테고리 정리 (LLM)

`notes/*/entry.md` 의 front matter `categories:` 를 채우면 빌드가 그 기준으로 묶는다.

```yaml
---
id: 20261122-091200-a1b2
title: 이상지질혈증 — 스타틴 관련 근육 증상(SAMS)
created: 2026-11-22T09:12:00
categories: 이상지질혈증, 심혈관
---
```

**한 기록이 여러 카테고리에 동시에 들어갈 수 있다.** `categories: A, B` 로 적으면
목록과 단권 PDF 양쪽에서 A 장과 B 장에 **각각 배치**된다(내용은 한 벌만 유지).

`미분류`가 쌓이면 정리 요청만 하면 된다(파일을 읽고 주제별로 나눠 `categories`를 채움).

## 빌드 결과

```
dist/index.html            카테고리별 목록
dist/html/<id>.html        기록 하나씩 (이미지 내장, 단일 파일)
dist/pdf/fm_board_all.pdf  표지 + 카테고리 장 + 기록으로 묶인 단권
```

## 문서 작성 규칙

- 본문은 pandoc markdown. `[밑줄]{.underline}` 문법으로 밑줄을 쓴다(앱이 자동 생성).
- 이미지: `![](img-1.png)` 처럼 같은 폴더 파일명으로 참조.
- 색인 정렬은 front matter의 `created` 순. 카테고리는 가나다순, `미분류`는 맨 뒤.

## 요구사항

- Node.js 20+ (npm 패키지 설치 없음)
- [pandoc](https://pandoc.org) 2.19+
- Chrome 또는 Edge (PDF 생성, `CHROME_PATH`로 지정 가능)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (외부 접속용, 선택)
