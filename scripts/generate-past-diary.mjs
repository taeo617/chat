#!/usr/bin/env node
/**
 * Generate diary for past dates
 * Usage: node generate-past-diary.mjs 2026-08-02
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STATE_FILE = join(ROOT, '..', '.state.json');
const DIARY_DIR = join(ROOT, '..', '..', 'Obsidian/민하의-세컨드-브레인/민하 비서실장 일기');

const targetDate = process.argv[2] || new Date(Date.now() - 86400000).toISOString().split('T')[0];

try {
  // Ensure diary directory exists
  if (!existsSync(DIARY_DIR)) {
    mkdirSync(DIARY_DIR, { recursive: true });
  }

  const stateJson = readFileSync(STATE_FILE, 'utf8');
  const state = JSON.parse(stateJson);
  const messages = state.messages || [];

  // Filter messages for target date
  const targetMessages = messages.filter(msg => {
    const msgDate = new Date(msg.createdAt).toISOString().split('T')[0];
    return msgDate === targetDate;
  });

  if (targetMessages.length === 0) {
    console.log(`❌ No messages found for ${targetDate}`);
    process.exit(0);
  }

  // Extract user messages
  const userMessages = targetMessages
    .filter(m => m.role === 'user')
    .map(m => m.text);

  // Determine mood and keywords
  const hasDifficulty = userMessages.some(m =>
    m.includes('어려움') || m.includes('실패') || m.includes('문제')
  );
  const hasSuccess = userMessages.some(m =>
    m.includes('성공') || m.includes('완료') || m.includes('가능')
  );

  const mood = hasDifficulty ? '😔 힘듦' : hasSuccess ? '😀 좋음' : '😊 보통';
  const keywords = [];
  if (hasSuccess) keywords.push('성공');
  if (hasDifficulty) keywords.push('도전');
  keywords.push('학습', '효율화');

  const title = `${targetDate} - 생산성 있는 하루`;

  const diary = `---
date: ${targetDate}
mood: ${mood}
keywords: ${keywords.join(', ')}
---

# ${title}

<details open>
<summary><strong>😊 기분</strong></summary>

${mood}

</details>

<details open>
<summary><strong>📋 주요사건</strong></summary>

Claude와 함께 다음 작업을 진행했습니다:

${userMessages.map(m => `- ${m.substring(0, 80)}${m.length > 80 ? '...' : ''}`).join('\n')}

</details>

<details>
<summary><strong>💡 배운점</strong></summary>

- 자동화 시스템의 중요성 재확인
- 실시간 협업 프로세스의 효율성
- 명확한 규칙의 중요성
- 사용자 피드백 기반 개선의 가치

</details>

<details>
<summary><strong>✨ 내일다짐</strong></summary>

- 더 많은 자동화 워크플로우 구축
- 일정 관리 자동화 완성
- 품질 검수 프로세스 개선
- 사용자 경험 계속 최적화

</details>

---
*생성 시간: ${new Date().toLocaleString('ko-KR')}*
*메시지 수: ${targetMessages.length}*
`;

  const filename = `${targetDate}.md`;
  const filepath = join(DIARY_DIR, filename);
  writeFileSync(filepath, diary);

  console.log(`✅ Diary created: ${filename}`);
  console.log(`📝 Messages: ${targetMessages.length}`);
  console.log(`😊 Mood: ${mood}`);
  console.log(`🏷️  Keywords: ${keywords.join(', ')}`);
} catch (err) {
  console.error('❌ Diary generation failed:', err.message);
  process.exit(1);
}
