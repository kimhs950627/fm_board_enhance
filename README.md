# fm_board_enhance

가정의학과 전문의 기출(2020–2025)에서 **되짚어볼 개념과 문제**를 모아 **단권화**하는 저장소.
브라우저 입력 앱에서 텍스트(굵게·밑줄)와 이미지를 넣고 저장하면 기록이 하나씩 쌓이고,
그걸 카테고리로 묶어 **시험장에 들고 갈 HTML/PDF 한 권**으로 빌드한다.

## 흐름

```
입력 앱(브라우저)  →  notes/<id>/entry.md + 이미지  →  카테고리 정리  →  dist/pdf/fm_board_all.pdf
```

## 사용법

```powershell
npm start     # 입력 앱 열기 (http://127.0.0.1:4173)
npm run share # 같은/다른 네트워크의 휴대폰·랩탑에서 접속 (Cloudflare 터널)
npm run build # HTML + PDF 빌드
npm run watch # notes/ 변경 감시 → 자동 빌드
```

### 입력 앱

- 굵게 `Ctrl+B`, 밑줄 `Ctrl+U`, 이미지는 **Ctrl+V 붙여넣기** 또는 드래그/선택 — **여러 장 가능**
- 카테고리는 쉼표로 여러 개: `이상지질혈증, 심혈관`. 비워두면 `미분류`로 저장되고, 나중에 정리하면 된다
- `Ctrl+Enter` 저장
- 저장 위치: `notes/<timestamp>/entry.md` (이미지는 같은 폴더에 `img-N.png`)

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
