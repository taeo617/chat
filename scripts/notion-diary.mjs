#!/usr/bin/env node
/**
 * Save diary to Notion
 * Usage: node notion-diary.mjs 2026-08-03
 */

import fs from 'fs';
import path from 'path';

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error('❌ Error: NOTION_API_KEY or NOTION_DATABASE_ID not set in .env');
  process.exit(1);
}
const DIARY_DIR = path.join(process.env.HOME, 'Obsidian/민하의-세컨드-브레인/민하 비서실장 일기');

const targetDate = process.argv[2] || new Date().toISOString().split('T')[0];
const diaryFile = path.join(DIARY_DIR, `${targetDate}.md`);

async function saveToDiary() {
  try {
    // Read diary file
    if (!fs.existsSync(diaryFile)) {
      console.log(`❌ Diary file not found: ${targetDate}`);
      process.exit(0);
    }

    const diaryContent = fs.readFileSync(diaryFile, 'utf8');

    // Parse frontmatter
    const frontmatterMatch = diaryContent.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter = {};
    if (frontmatterMatch) {
      const lines = frontmatterMatch[1].split('\n');
      lines.forEach(line => {
        const [key, value] = line.split(':').map(s => s.trim());
        frontmatter[key] = value;
      });
    }

    const title = `${targetDate} - 생산성 있는 하루`;
    const mood = frontmatter.mood || '😊 보통';
    const keywords = frontmatter.keywords || '학습, 효율화';

    console.log(`📤 Saving to Notion: ${title}`);
    console.log(`   Mood: ${mood}`);
    console.log(`   Keywords: ${keywords}`);

    // Create page in Notion
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: {
          database_id: NOTION_DATABASE_ID.replace(/-/g, ''),
        },
        properties: {
          '제목': {
            title: [
              {
                text: {
                  content: title,
                },
              },
            ],
          },
          '날짜': {
            date: {
              start: targetDate,
            },
          },
          '기분': {
            select: {
              name: mood.split(' ')[0], // Extract emoji
            },
          },
          '키워드': {
            multi_select: keywords.split(',').map(k => ({
              name: k.trim(),
            })),
          },
          '내용': {
            rich_text: [
              {
                text: {
                  content: diaryContent,
                },
              },
            ],
          },
        },
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Notion API Error:', error);
      process.exit(1);
    }

    const result = await response.json();
    console.log(`✅ Saved to Notion: ${result.url}`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

saveToDiary();
