#!/usr/bin/env node
/**
 * Daily Diary Generator - Minha's Secretary Log
 * Runs at 11:30 PM to summarize the day's conversation
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STATE_FILE = join(ROOT, '..', '.state.json');
const DIARY_DIR = join(ROOT, '..', '..', 'Obsidian/민하의-세컨드-브레인/민하 비서실장 일기');

try {
  const stateJson = readFileSync(STATE_FILE, 'utf8');
  const state = JSON.parse(stateJson);
  const messages = state.messages || [];

  if (messages.length === 0) {
    console.log('❌ No conversation today - skipping diary');
    process.exit(0);
  }

  // Summarize today's conversation
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.text).slice(-10);
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
  keywords.push('학습', '효율화', '자동화');

  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  const title = `${dateStr} - 생산성 있는 하루`;

  const diary = `---
date: ${dateStr}
mood: ${mood}
keywords: ${keywords.join(', ')}
---

# ${title}

## 기분
${mood}

## 주요사건
오늘 Claude와 함께 다음 작업을 진행했습니다:
${userMessages.map(m => `- ${m.substring(0, 60)}${m.length > 60 ? '...' : ''}`).join('\n')}

## 배운점
- 자동화 시스템의 중요성 재확인
- 실시간 협업 프로세스의 효율성
- 명확한 규칙의 중요성

## 내일다짐
- 더 많은 자동화 워크플로우 구축
- 일정 관리 자동화 완성
- 품질 검수 프로세스 개선
`;

  const filename = `${dateStr}.md`;
  const filepath = join(DIARY_DIR, filename);
  writeFileSync(filepath, diary);

  console.log(`✓ Daily diary created: ${filename}`);
} catch (err) {
  console.error('❌ Diary creation failed:', err.message);
  process.exit(1);
}
