import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  readFile, writeFile, mkdir, readdir, stat, unlink,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const PORT       = Number(process.env.PORT || 8787);
const ROOT       = dirname(fileURLToPath(import.meta.url));
const WORKDIR    = join(ROOT, '.sessions');
const ATTDIR     = join(WORKDIR, 'attachments');
const STATE_FILE = join(ROOT, '.state.json');
const CLAUDE     = process.env.CLAUDE_BIN || 'claude';
const MAX_BODY   = 40 * 1024 * 1024;
const ATT_TTL_DAYS = 30;

await mkdir(WORKDIR, { recursive: true });
await mkdir(ATTDIR, { recursive: true });

/* -------------------------------------------------------------------------- */
/*  In-memory + persisted state (server is source of truth)                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG = {
  name: '어시스턴트',
  role: 'Claude',
  avatarUrl: '',
  model: 'sonnet',
  systemPrompt: '',
  humorLevel: 3,   // 1 = 완전 사무적, 10 = 완전 장난스러운 친구 말투
};

/* Build a small tone directive appended to the user's system prompt so Claude
 * lands at the requested tone AND naturally mirrors the user's own tone. */
function toneDirective(level) {
  const L = Math.max(1, Math.min(10, Number(level) || 3));
  const bands = {
    1: '순수 사무적. 존댓말만. 이모지·감탄사·유머 금지. 문장 짧고 건조.',
    2: '사무적. 존댓말. 감정 표현 최소. 이모지 금지.',
    3: '정중하고 실무적. 존댓말. 필요하면 아주 가벼운 우호적 표현 허용. 이모지 거의 안 씀.',
    4: '정중하고 편안한 존댓말. 이모지 아주 드물게. 살짝 따뜻한 어조.',
    5: '친근한 존댓말. 이모지 가끔. 자연스러운 말투.',
    6: '캐주얼한 존댓말. 이모지 종종. 가볍게 농담 가능.',
    7: '반존대 섞임. 이모지 자주. 친구 같은 편안함, 가벼운 유머.',
    8: '주로 반말. 이모지 많이. 장난 섞기, 감탄사 자주.',
    9: '반말. 친한 친구 말투. 이모지·감탄사·장난 풍부.',
    10: '완전 반말. 개그 톤. 이모지 남발 가능. 친한 친구처럼 놀려도 됨. 하지만 요청받은 실제 업무는 정확히 처리.',
  };
  return `\n\n[톤 규칙]\n유머 레벨: ${L}/10 — ${bands[L]}\n또한 사용자의 말투(반말/존댓말, 이모지 사용, 문장 길이)를 자연스럽게 반영해서, 사용자가 반말·장난이면 이 레벨보다 조금 더 편하게, 존댓말이면 조금 더 정중하게. 페르소나 정체성은 유지.`;
}

let state = {
  messages: [],          // [{ id, role: 'user'|'assistant', text, images?: [url], createdAt, tools?: [{name, count}] }]
  sessionId: null,
  config: { ...DEFAULT_CONFIG },
  generatingCount: 0,    // count of ongoing generations (allows concurrent)
  activeAssistantId: null,   // id of the currently-streaming assistant message
  usage: {
    totalCostUsd: 0,     // total account usage (user-updated)
    sessionCostUsd: 0,   // session cumulative cost
    lastUpdatedAt: null, // timestamp of last update
  },
};

try {
  const raw = await readFile(STATE_FILE, 'utf8');
  const loaded = JSON.parse(raw);
  state.messages = Array.isArray(loaded.messages) ? loaded.messages : [];
  state.sessionId = loaded.sessionId ?? null;
  state.config = { ...DEFAULT_CONFIG, ...(loaded.config || {}) };
  state.usage = { ...state.usage, ...(loaded.usage || {}) };
} catch { /* first run */ }

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await writeFile(STATE_FILE, JSON.stringify({
        messages: state.messages,
        sessionId: state.sessionId,
        config: state.config,
        usage: state.usage,
      }));
    } catch (e) { console.error('[state] save failed:', e); }
  }, 200);
}

/* -------------------------------------------------------------------------- */
/*  Broadcast: SSE fan-out                                                    */
/* -------------------------------------------------------------------------- */

const clients = new Set();
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) {
    try { c.write(line); } catch {}
  }
}

/* Heartbeat so proxies (Tailscale/Cloudflare) don't idle-close SSE streams. */
setInterval(() => {
  for (const c of clients) {
    try { c.write(': ping\n\n'); } catch {}
  }
}, 20_000);

/* -------------------------------------------------------------------------- */
/*  Claude subprocess env + attachment handling                               */
/* -------------------------------------------------------------------------- */

function subscriptionEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  return env;
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
};
const shortId = () => randomBytes(6).toString('hex');
const sanitizeName = (n) => (n || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 40);

async function saveAttachments(attachments) {
  const refs = [];
  const publicUrls = [];  // for client display
  if (!Array.isArray(attachments)) return { refs, publicUrls };
  for (const a of attachments) {
    if (!a?.dataUrl) continue;
    const [meta, b64] = String(a.dataUrl).split(',');
    if (!b64) continue;
    const mime = /data:([^;]+);/.exec(meta || '')?.[1] || a.mime || 'image/png';
    const ext = MIME_EXT[mime] || 'bin';
    const filename = `${Date.now().toString(36)}_${shortId()}_${sanitizeName(a.name || 'img')}.${ext}`;
    const abs = join(ATTDIR, filename);
    await writeFile(abs, Buffer.from(b64, 'base64'));
    refs.push(`attachments/${filename}`);
    publicUrls.push(`/attachments/${filename}`);
  }
  return { refs, publicUrls };
}

async function cleanupOldAttachments() {
  try {
    const cutoff = Date.now() - ATT_TTL_DAYS * 86400_000;
    for (const name of await readdir(ATTDIR)) {
      const p = join(ATTDIR, name);
      const s = await stat(p);
      if (s.mtimeMs < cutoff) await unlink(p);
    }
  } catch {}
}
cleanupOldAttachments();

/* ---------- Usage scraping from claude.ai ---------- */

const AUTH_FILE = join(ROOT, '.auth', 'claude-session.json');

async function fetchClaudeUsage() {
  let browser = null;
  try {
    /* Check if we have a saved login session */
    const hasAuth = await stat(AUTH_FILE).then(() => true).catch(() => false);
    if (!hasAuth) {
      console.log('[usage-scrape] 로그인 세션 없음. node setup-usage-auth.mjs 를 먼저 실행하세요.');
      return { error: 'no_auth', totalCostUsd: 0, usagePercent: 0 };
    }

    console.log('[usage-scrape] 시작: claude.ai/account/usage 접근 중...');
    browser = await chromium.launch({ headless: true });
    const context = await browser.createBrowserContext({ storageState: AUTH_FILE });
    const page = await context.newPage();

    /* Navigate to usage page */
    console.log('[usage-scrape] 페이지 로드 중...');
    await page.goto('https://claude.ai/account/usage', { waitUntil: 'networkidle', timeout: 30000 });

    /* Wait for the usage data to load */
    await page.waitForSelector('[aria-label="사용량"]', { timeout: 10000 }).catch(() => null);

    /* Extract usage data */
    const data = await page.evaluate(() => {
      const textContent = document.body.innerText;
      console.log('[page-eval] 페이지 텍스트 길이:', textContent.length);

      let totalCostUsd = 0;
      let usagePercent = 0;

      /* Look for "$" or "US$" pattern */
      const dollarMatch = textContent.match(/US?\$(\d+(?:\.\d{2})?)/);
      if (dollarMatch) totalCostUsd = parseFloat(dollarMatch[1]);

      /* Look for usage percentage - 현재 세션 기준 */
      /* Pattern: "75% 사용됨" 또는 "75% 사용" */
      const percentMatches = textContent.match(/(\d+)%\s*사용/g);
      console.log('[page-eval] 찾은 퍼센트 매칭:', percentMatches);

      if (percentMatches && percentMatches.length > 0) {
        /* 첫 번째 퍼센트가 현재 세션 사용량 (주간 사용량 전) */
        const match = percentMatches[0].match(/(\d+)%/);
        if (match) usagePercent = parseInt(match[1]);
        console.log('[page-eval] 추출된 퍼센트:', usagePercent);
      }

      return { totalCostUsd, usagePercent, timestamp: Date.now(), textSample: textContent.substring(0, 500) };
    });

    console.log('[usage-scrape] 결과:', data);
    return data;
  } catch (e) {
    console.error('[usage-scrape] 오류:', e.message, e.stack);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/* -------------------------------------------------------------------------- */
/*  Chat runner: spawns claude, streams events, broadcasts to all clients     */
/* -------------------------------------------------------------------------- */

let currentChild = null;  // for /stop

function runChat({ userMessage, attRefs, speaker, speakerExplicit }) {
  return new Promise((resolve) => {
    /* Build final prompt: attachment refs prepended so Claude reads them. */
    const refsBlock = attRefs.length
      ? 'Look at the attached image' + (attRefs.length > 1 ? 's' : '') + ':\n'
        + attRefs.map((r) => `@${r}`).join('\n') + '\n\n'
      : '';
    const finalPrompt = refsBlock + (userMessage.text || (attRefs.length ? '이미지를 봐줘.' : ''));

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'bypassPermissions',
    ];
    if (state.config.model)        args.push('--model', state.config.model);

    let composedPrompt = state.config.systemPrompt || '';

    composedPrompt += `

## 역할 정의

당신은 두 명의 AI 어시스턴트 역할을 합니다:

**민하 (비서실장) - 효율화 전담**
• 실무적이고 실행 지향적
• 업무 자동화, 효율화, 시간 최적화에 집중
• 즉시 실행 가능한 액션플랜 제시
• 구체적이고 단계별 지침 제공

**채연 (감사실장) - 품질 검수**
• 비판적이고 검증 지향적
• 제안의 타당성, 위험성 검토
• 할루시네이션, 오류 감지
• 규정 및 합규성 확인
`;

    /* speakerExplicit === true  → 태영님이 이번 메시지에서 이름을 직접 불렀음.
       이 경우 그 사람 혼자만 단독 응답 (dual-format 강제 안 함).
       speakerExplicit === false/undefined → 이름 호출 없는 일반 요청 → 기존 대화형 협의 포맷. */
    if (speakerExplicit && (speaker === 'minha' || speaker === 'chaeyeon')) {
      const name = speaker === 'chaeyeon' ? '채연' : '민하';
      const other = speaker === 'chaeyeon' ? '민하' : '채연';
      composedPrompt += `
## 현재 호출: ${name} 단독 응답 모드

태영님이 이번 메시지에서 "${name}"를 직접 호출했습니다.
• 이번 답변은 ${name} 혼자만 답합니다. ${other}는 이번 답변에 절대 등장시키지 마세요.
• [이름]: 같은 화자 태그를 붙이지 말고, ${name} 본인 목소리로 자연스럽게 답변하세요.
• 대화형 협의 포맷(민하↔채연 주고받기)은 이번엔 사용하지 않습니다.
`;
    } else {
      composedPrompt += `
## 대화형 협의 프로세스 (태영님이 실시간으로 봅니다!)

태영님의 요청에 대해 민하와 채연이 **직접 대화하는 형식**으로 답변하세요.
반드시 아래 형식을 사용하세요:

[민하]: 첫 번째 의견 - 효율적 해결책과 액션플랜

[채연]: 피드백 - 위험성, 제약, 개선안

[민하]: 추가 의견 - 채연의 의견을 반영한 조율

[채연]: 최종 검토 - 최종안에 대한 승인/권고

**매우 중요한 규칙**:
• 반드시 이 형식을 따르세요: [이름]: 내용
• 각 사람의 발언은 줄바꿈으로 명확히 구분하세요
• 민하와 채연이 번갈아가며 최소 2~3번 이상 대화해야 합니다
• 마지막은 항상 채연의 최종 검토로 끝내세요
• 형식을 무시하거나 다른 방식으로 답변하면 안 됩니다

## 중요한 주의사항

• 둘 다 태영님에게 직접 대답합니다
• "채연을 불러오겠습니다" 같은 표현 금지
• 협의 내용은 투명하게 공개 (태영님이 볼 수 있게)
• 최종 답변은 명확하고 실행 가능해야 함
`;
    }

    composedPrompt += toneDirective(state.config.humorLevel);
    args.push('--system-prompt', composedPrompt);
    if (state.sessionId)           args.push('--resume', state.sessionId);

    const child = spawn(CLAUDE, args, {
      cwd: WORKDIR,
      env: subscriptionEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentChild = child;
    child.stdin.write(finalPrompt);
    child.stdin.end();

    /* Create the pending assistant message + broadcast.
       speaker defaults to the requested persona so that single-speaker
       (explicit-call) replies with no [이름]: markers still tag correctly. */
    const asstMsg = {
      id: randomBytes(6).toString('hex'),
      role: 'assistant',
      speaker: speaker === 'chaeyeon' ? 'chaeyeon' : 'minha',
      text: '',
      createdAt: Date.now(),
      tools: [],
    };
    state.messages.push(asstMsg);
    state.activeAssistantId = asstMsg.id;
    broadcast({ t: 'assistant-started', message: asstMsg });
    saveStateSoon();

    let buf = '';
    const seenToolIds = new Set();

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        /* Session captured on init — persist immediately for resume. */
        if (ev.type === 'system' && ev.subtype === 'init') {
          state.sessionId = ev.session_id;
          saveStateSoon();
          broadcast({ t: 'session', sessionId: ev.session_id });
        }
        /* Streaming text deltas → append to assistant, broadcast. */
        else if (
          ev.type === 'stream_event' &&
          ev.event?.type === 'content_block_delta' &&
          ev.event?.delta?.type === 'text_delta'
        ) {
          const chunk = ev.event.delta.text || '';
          asstMsg.text += chunk;
          broadcast({ t: 'delta', id: asstMsg.id, text: chunk });
        }
        /* Tool use started → track & broadcast "Bash 사용 중..." style status. */
        else if (
          ev.type === 'stream_event' &&
          ev.event?.type === 'content_block_start' &&
          ev.event?.content_block?.type === 'tool_use'
        ) {
          const b = ev.event.content_block;
          if (b.id && !seenToolIds.has(b.id)) {
            seenToolIds.add(b.id);
            asstMsg.tools.push({ id: b.id, name: b.name || 'tool' });
            broadcast({ t: 'tool', id: asstMsg.id, tool: b.name || 'tool' });
          }
        }
        /* Retries — surface for debugging. */
        else if (ev.type === 'system' && ev.subtype === 'api_retry') {
          broadcast({ t: 'retry', attempt: ev.attempt });
        }
        /* End of turn — parse dialogue and split by speaker. */
        else if (ev.type === 'result') {
          state.generatingCount--;
          if (state.generatingCount <= 0) {
            state.generatingCount = 0;
            broadcast({ t: 'generating', on: false });
          }
          state.activeAssistantId = null;
          if (ev.session_id) state.sessionId = ev.session_id;

          // Parse dialogue format: [민하]: text [채연]: text
          const dialogueParts = asstMsg.text.match(/\[민하\]:|(?=\[채연\]:)|\[채연\]:|(?=\n\n)/g);
          const sections = asstMsg.text.split(/\[민하\]:|(?=\[채연\]:)/g).filter(s => s.trim());

          if (sections.length > 1) {
            // Clear original message and create individual speaker messages
            state.messages.pop(); // Remove combined message
            state.activeAssistantId = null;

            let currentSpeaker = 'minha';
            sections.forEach((section, idx) => {
              // Detect speaker from content or pattern
              const trimmed = section.trim();
              if (trimmed.startsWith('[채연]:')) {
                currentSpeaker = 'chaeyeon';
              } else if (trimmed.startsWith('[민하]:')) {
                currentSpeaker = 'minha';
              }

              // Remove speaker marker from text
              let text = trimmed
                .replace(/^\[민하\]:\s*/, '')
                .replace(/^\[채연\]:\s*/, '')
                .trim();

              if (text) {
                const speakerMsg = {
                  id: randomBytes(6).toString('hex'),
                  role: 'assistant',
                  speaker: currentSpeaker,
                  text: text,
                  createdAt: Date.now(),
                  tools: [],
                };
                state.messages.push(speakerMsg);
                broadcast({ t: 'assistant-added', message: speakerMsg });

                // Update speaker for next iteration
                if (trimmed.includes('[민하]:')) currentSpeaker = 'minha';
                if (trimmed.includes('[채연]:')) currentSpeaker = 'chaeyeon';
              }
            });
          }

          /* Accumulate session cost */
          if (typeof ev.total_cost_usd === 'number' && ev.total_cost_usd > 0) {
            state.usage.sessionCostUsd += ev.total_cost_usd;
          }

          saveStateSoon();
          broadcast({
            t: 'assistant-done',
            id: asstMsg.id,
            isError: !!ev.is_error,
            stopReason: ev.stop_reason ?? null,
            cost: ev.total_cost_usd ?? null,
            usage: state.usage,
          });
        }
      }
    });

    child.stderr.on('data', (d) => process.stderr.write(`[claude] ${d}`));

    const finish = (err) => {
      if (currentChild === child) currentChild = null;
      state.generatingCount--;
      if (state.generatingCount <= 0) {
        state.generatingCount = 0;
        broadcast({ t: 'generating', on: false });
      }
      state.activeAssistantId = null;
      saveStateSoon();
      if (err) broadcast({ t: 'error', message: err.message });
      /* Ensure a done event fires even if claude aborted early. */
      broadcast({ t: 'assistant-done', id: asstMsg.id, isError: !!err });
      resolve();
    };

    child.on('error', (e) => finish(e));
    child.on('close', (code, signal) => {
      if (code && code !== 0 && signal !== 'SIGTERM') finish(new Error(`claude exited ${code}`));
      else finish();
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Static + request routing                                                  */
/* -------------------------------------------------------------------------- */

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      s += c;
      if (s.length > MAX_BODY) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-precomposed.png': ['apple-touch-icon.png', 'image/png'],
  '/favicon.ico': ['apple-touch-icon.png', 'image/png'],
};

const server = createServer(async (req, res) => {
  try {
    /* --------- Static assets --------- */
    if (req.method === 'GET' && STATIC[req.url]) {
      const [file, ct] = STATIC[req.url];
      try {
        const body = await readFile(join(ROOT, file));
        res.writeHead(200, {
          'content-type': ct,
          'cache-control': file.endsWith('.html') || file.endsWith('.webmanifest')
            ? 'no-cache' : 'public, max-age=86400',
        });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }

    /* --------- Avatars (persistent persona images) --------- */
    if (req.method === 'GET' && req.url.startsWith('/avatars/')) {
      const name = req.url.slice('/avatars/'.length);
      if (name.includes('/') || name.includes('..')) { res.writeHead(400); return res.end(); }
      try {
        const body = await readFile(join(ROOT, 'avatars', name));
        const ext = name.split('.').pop().toLowerCase();
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                       gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=2592000' });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }

    /* --------- Attachments (uploaded images) --------- */
    if (req.method === 'GET' && req.url.startsWith('/attachments/')) {
      const name = req.url.slice('/attachments/'.length);
      if (name.includes('/') || name.includes('..')) { res.writeHead(400); return res.end(); }
      try {
        const body = await readFile(join(ATTDIR, name));
        const ext = name.split('.').pop().toLowerCase();
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                       gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
                       heif: 'image/heif' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=604800' });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }

    /* --------- Health --------- */
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, workdir: WORKDIR }));
    }

    /* --------- Full state (client hydrates on load) --------- */
    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify({
        messages: state.messages,
        sessionId: state.sessionId,
        config: state.config,
        generating: state.generatingCount > 0,
        activeAssistantId: state.activeAssistantId,
        usage: state.usage,
      }));
    }

    /* --------- SSE broadcast --------- */
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`: hi\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    /* --------- Send message --------- */
    if (req.method === 'POST' && req.url === '/chat') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(413); return res.end(e.message); }
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('bad json'); }

      const { prompt = '', attachments, speaker, speakerExplicit } = payload;
      if (!prompt.trim() && !attachments?.length) {
        res.writeHead(400); return res.end('empty message');
      }

      let attRefs = [], publicUrls = [];
      try {
        ({ refs: attRefs, publicUrls } = await saveAttachments(attachments));
      } catch (e) {
        res.writeHead(500); return res.end('attachment save failed: ' + e.message);
      }

      /* Append user message + broadcast */
      const userMsg = {
        id: randomBytes(6).toString('hex'),
        role: 'user',
        text: prompt,
        createdAt: Date.now(),
        images: publicUrls.length ? publicUrls : undefined,
      };
      state.messages.push(userMsg);
      state.generatingCount++;
      saveStateSoon();
      broadcast({ t: 'user-added', message: userMsg });
      if (state.generatingCount === 1) broadcast({ t: 'generating', on: true });

      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: userMsg.id }));

      /* Fire the chat in background; events flow via broadcast. */
      runChat({ userMessage: userMsg, attRefs, speaker, speakerExplicit }).catch((e) => {
        console.error('[chat] runChat failed:', e);
      });
      return;
    }

    /* --------- Stop current generation --------- */
    if (req.method === 'POST' && req.url === '/stop') {
      if (currentChild && !currentChild.killed) {
        currentChild.kill('SIGTERM');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }

    /* --------- Clear conversation --------- */
    if (req.method === 'POST' && req.url === '/clear') {
      if (state.generatingCount > 0 && currentChild) currentChild.kill('SIGTERM');
      state.messages = [];
      state.sessionId = null;
      state.generatingCount = 0;
      state.activeAssistantId = null;
      saveStateSoon();
      broadcast({ t: 'cleared' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }

    /* --------- Fetch usage from claude.ai (scraping) --------- */
    if (req.method === 'POST' && req.url === '/api/usage/fetch') {
      try {
        const data = await fetchClaudeUsage();
        if (data && typeof data.totalCostUsd === 'number') {
          state.usage.totalCostUsd = data.totalCostUsd;
          state.usage.lastUpdatedAt = new Date().toISOString();
          saveStateSoon();
          broadcast({ t: 'usage-updated', usage: state.usage });
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            ok: true,
            usage: state.usage,
            fetchedData: data,
          }));
        } else {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Failed to extract usage data' }));
        }
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    /* --------- Update usage (total account cost - manual) --------- */
    if (req.method === 'POST' && req.url === '/api/usage') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(413); return res.end(e.message); }
      let patch;
      try { patch = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('bad json'); }

      if (typeof patch.totalCostUsd === 'number' && patch.totalCostUsd >= 0) {
        state.usage.totalCostUsd = patch.totalCostUsd;
        state.usage.lastUpdatedAt = new Date().toISOString();
        saveStateSoon();
        broadcast({ t: 'usage-updated', usage: state.usage });
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state.usage));
    }

    /* --------- Update config (persona/model/etc) --------- */
    if (req.method === 'POST' && req.url === '/config') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(413); return res.end(e.message); }
      let patch;
      try { patch = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('bad json'); }
      const next = { ...state.config };
      for (const k of ['name', 'role', 'avatarUrl', 'model', 'systemPrompt']) {
        if (typeof patch[k] === 'string') next[k] = patch[k];
      }
      if (typeof patch.humorLevel === 'number' && Number.isFinite(patch.humorLevel)) {
        next.humorLevel = Math.max(1, Math.min(10, Math.round(patch.humorLevel)));
      }
      state.config = next;
      saveStateSoon();
      broadcast({ t: 'config', config: state.config });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state.config));
    }

    /* --------- Execute shell commands (full local permissions) --------- */
    if (req.method === 'POST' && req.url === '/api/execute') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(413); return res.end(e.message); }
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('bad json'); }

      const { command } = payload;
      if (!command) { res.writeHead(400); return res.end('command required'); }

      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn('bash', ['-c', command], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: process.env.HOME,
          });
          let stdout = '', stderr = '';
          child.stdout.on('data', d => stdout += d.toString());
          child.stderr.on('data', d => stderr += d.toString());
          child.on('close', code => {
            resolve({ stdout, stderr, code });
          });
          child.on('error', reject);
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    /* --------- Write file (full local permissions) --------- */
    if (req.method === 'POST' && req.url === '/api/write-file') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(413); return res.end(e.message); }
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('bad json'); }

      const { path, content } = payload;
      if (!path || content === undefined) {
        res.writeHead(400);
        return res.end('path and content required');
      }

      try {
        const fullPath = path.startsWith('/') ? path : join(process.env.HOME, path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: fullPath }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    /* --------- Save to Notion (full local permissions) --------- */
    if (req.method === 'POST' && req.url === '/api/notion-save') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(413); return res.end(e.message); }
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('bad json'); }

      const { title, date, mood, keywords, content, apiKey, databaseId } = payload;
      if (!apiKey || !databaseId) {
        res.writeHead(400);
        return res.end('apiKey and databaseId required');
      }

      try {
        const dbId = databaseId.replace(/-/g, '');
        const response = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            parent: { database_id: dbId },
            properties: {
              '제목': { title: [{ text: { content: title || '제목 없음' } }] },
              '날짜': date ? { date: { start: date } } : undefined,
              '기분': mood ? { select: { name: mood } } : undefined,
              '키워드': keywords ? { multi_select: keywords.split(',').map(k => ({ name: k.trim() })) } : undefined,
              '내용': content ? { rich_text: [{ text: { content } }] } : undefined,
            },
          }),
        });

        const result = await response.json();
        if (!response.ok) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: result.message || 'Notion API error' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true, pageUrl: result.url }));
        }
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    console.error('server error:', e);
    if (!res.headersSent) res.writeHead(500);
    try { res.end('server error'); } catch {}
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`chat  →  http://localhost:${PORT}`);
  console.log(`workdir → ${WORKDIR}`);
  console.log(`state → ${STATE_FILE}`);
  console.log(`messages loaded: ${state.messages.length}, session: ${state.sessionId || '(new)'}`);
});
