# chat — 구독으로 굴러가는 개인 채팅앱

Claude Pro/Max 구독 한도로 동작. API 키 별도 결제 없음. 이미지 첨부, iMessage 스타일 UI, PWA.

## 🔗 URL

**https://macbookpro.tail570fe5.ts.net/**

- 영구 URL. Mac 재부팅해도 안 바뀜
- Tailscale tailnet 안에서만 접근 가능 (본인 Mac + iPhone 만) → 공개 노출 없음
- HTTPS 자동 (Tailscale 인증서)

## 폰에 앱처럼 설치

1. iPhone Safari (Tailscale 켜져있는 상태) → 위 URL 열기
2. 공유 아이콘 → **홈 화면에 추가**
3. 파란 말풍선 아이콘 뜸. 탭하면 iMessage 전체화면.

## 구조

```
[iPhone / PC in tailnet] ─https─▶ [tailscale serve] ─▶ [localhost:8787 server.mjs] ─spawn─▶ [claude -p]
                                                                                              │ subscription OAuth
                                                                                              ▼
                                                                                       [Anthropic API]
```

## 파일

- `server.mjs` — Node HTTP + SSE, `claude` spawn, 첨부 이미지 저장
- `index.html` — iMessage UI, PWA manifest, 이미지 첨부·붙여넣기·드래그
- `manifest.webmanifest` · `icon.svg` · `icon-192.png` · `icon-512.png` · `apple-touch-icon.png` — PWA 자산
- `com.taeo.chat.plist` — server.mjs 자동 실행 (launchd, 로드됨)
- `com.taeo.chat.tunnel.plist` — cloudflared 백업용 (미로드, Tailscale 쓸 때 불필요)
- `.sessions/` — 세션 스코프 고정 + 첨부 (`attachments/`, 30일 자동 정리)
- `~/.claude/projects/-Users-taeo-chat--sessions/*.jsonl` — Claude Code 대화 로그

## 상시 실행 상태

지금 로드된 서비스:

```bash
launchctl list | grep com.taeo.chat
# com.taeo.chat  (server, PID)
```

Tailscale serve 설정은 tailscaled 데몬 상태에 저장되므로 Mac 재부팅해도 유지됨:

```bash
tailscale serve status
# https://macbookpro.tail570fe5.ts.net (tailnet only)
# |-- / proxy http://127.0.0.1:8787
```

즉 Mac 재부팅 → server.mjs 자동 시작 (launchd) → tailscale serve 자동 복원 → URL 그대로 살아있음.

## 이미지 첨부

- 컴포저 `+` → 이미지 선택 (여러 장). 붙여넣기(⌘V) · 드래그도 됨
- 클라이언트가 자동으로 최대 1600px · JPEG q0.85 로 다운사이즈 (토큰·저장 절약)
- 서버가 `.sessions/attachments/` 로 저장, 프롬프트에 `@경로` 삽입 → Claude가 Read로 봄
- Sonnet/Opus vision 모델에서 이미지 이해 가능. Haiku 는 텍스트만
- 30일 지난 첨부는 서버 재시작 시 자동 삭제

## 모델 · 세션

- `--model sonnet | opus | haiku`. 설정 시트에서 선택
- 세션은 자동 저장/재개. "새 대화" 누르면 세션 초기화
- 대화 로그는 로컬 브라우저 + Claude Code JSONL 트랜스크립트 양쪽에 남음

## Claude Code 툴 (Bash/Read/Write 등)

이 서버는 `claude -p --permission-mode dontAsk` 로 동작. Claude가 자유롭게 파일·명령어를 실행 가능. 대화창에서 "이 파일 읽어봐" "코드 짜줘" 같은 요청이 실제로 실행됨.

**작업 디렉토리는 `~/chat/.sessions`** 로 고정돼있어서 실수로 다른 프로젝트 건드리지 않음.

## 관리

```bash
# 서비스 상태
launchctl list | grep com.taeo.chat
tailscale serve status

# 서버 재시작
launchctl unload ~/Library/LaunchAgents/com.taeo.chat.plist
launchctl load   ~/Library/LaunchAgents/com.taeo.chat.plist

# 서버 로그
tail -f /tmp/chat.out.log /tmp/chat.err.log

# Tailscale serve 끄기 (URL 죽음)
tailscale serve --https=443 off

# Tailscale serve 다시 켜기
tailscale serve --bg 8787
```

## 외부에서도 쓰고 싶으면 (선택)

Tailscale Funnel 로 공용 인터넷에도 노출 가능. Tailscale 관리 콘솔에서 Funnel 활성화 후:

```bash
tailscale funnel --bg 8787
```

같은 URL(`https://macbookpro.tail570fe5.ts.net/`)이 tailnet 밖에서도 접근 가능해짐. **다만 세션·기록이 URL만 아는 사람 누구든 볼 수 있으니 주의**. 개인용이면 지금처럼 tailnet-only가 안전.

## 주의사항

**한도** — 구독 사용량 풀에서 차감. Claude Code 작업 한도랑 같은 지갑. 이미지 붙으면 특히 빠르게 소진.

**정책 변동** — Anthropic이 프로그래매틱 사용 정책 변경 시사한 적 있음 (2026-05, 6-15 보류). 향후 별도 크레딧으로 분리될 수 있음. 그때 대비해 `server.mjs` 의 `subscriptionEnv()` 조정만으로 API 키 모드 전환 가능.

**Mac 꺼지면 URL 죽음** — Tailscale serve는 Mac에서 도는 서비스라 Mac이 꺼지거나 잠자면 접근 불가. Mac 뚜껑 안 닫고 켜둔 상태 유지가 전제. 완전 클라우드로 옮기려면 VM 렌트 + 거기서 `claude login` 별도로 해야 함.

**함정 기록** — Claude Code 세션 내부에서 `node server.mjs` 를 띄우면 자식 `claude` 가 부모의 `CLAUDECODE=1` 상속받아서 nested 세션으로 오해 → `--resume` 무한 재시도. `subscriptionEnv()` 에서 `CLAUDECODE` + `CLAUDE_CODE_*` 다 삭제해서 해결 (반영됨). launchd 로 실행할 때는 이 문제 없음.
