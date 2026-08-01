# chat

iMessage 스타일 개인 채팅 앱. Anthropic Claude와 브라우저에서 바로 대화.

- 단일 파일 (`index.html`) — 빌드 없음, 프레임워크 없음
- API 키는 브라우저 localStorage에만 저장. 서버 없음.
- GitHub Pages에서 무료 호스팅

## 사용

1. https://taeo617.github.io/chat 열기
2. 상단 이름/아바타 탭 → Anthropic API 키 붙여넣기 → 저장
3. iOS Safari에서 공유 → "홈 화면에 추가" 하면 앱 아이콘처럼 씀

## 다른 곳에 옮기고 싶으면

`index.html` 하나만 있으면 어디서든 열림:

- Cloudflare Pages / Vercel / Netlify: 이 repo 연결하고 static site로 배포
- 그냥 로컬에서: `index.html`을 브라우저로 열기
- 자체 서버: 아무 웹서버 root에 올리기

의존성 0.
