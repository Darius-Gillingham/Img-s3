// File: serverC.js
// Commit: convert to reading wordsets from Supabase and generating prompt output directly

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

console.log('=== Running serverC.js ===');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const OUTPUT_DIR = path.join(__dirname, './data/generated');

function pickTwoDistinct(arr) {
  const first = arr[Math.floor(Math.random() * arr.length)];
  let second = first;
  while (second === first && arr.length > 1) {
    second = arr[Math.floor(Math.random() * arr.length)];
  }
  return [first, second];
}

async function loadWordsetsFromSupabase(limit = 100) {
  const { data, error } = await supabase
    .from('wordsets')
    .select('*')
    .limit(limit);

  if (error) {
    console.error('✗ Failed to fetch wordsets from Supabase:', error);
    return [];
  }

  return data.map(ws => [
    ws.noun1, ws.noun2, ws.verb,
    ws.adjective1, ws.adjective2,
    ws.style, ws.setting, ws.era, ws.mood
  ]);
}

async function generatePromptsFromWordsets(ws1, ws2) {
  const combined = Array.from(new Set([...ws1, ...ws2]));
  const wordList = combined.join(', ');

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    temperature: 1.4,
    top_p: 0.95,
    messages: [
      {
        role: 'system',
        content:
          'You are an AI prompt composer. You will be given a set of words. Generate 5 distinct and imaginative DALL·E prompts using most or all of the words. Each prompt must be linearly independent — that is, no two should feel similar in structure, style, tone, or scene.'
      },
      {
        role: 'user',
        content: `Wordset: ${wordList}`
      }
    ]
  });

  const content = response.choices[0].message?.content;
  if (!content) throw new Error('No response content from GPT');

  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error('GPT output is not a JSON array');
    return parsed;
  } catch {
    return content
      .split('\n')
      .map(line => line.trim().replace(/^\d+[\).]\s*/, ''))
      .filter(line => line.length > 0);
  }
}

function getOutputFilename() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `generated-prompts-${timestamp}.json`;
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const wordsets = await loadWordsetsFromSupabase();
  if (wordsets.length < 2) {
    console.warn('✗ Not enough wordsets to compose a pair.');
    return;
  }

  const [ws1, ws2] = pickTwoDistinct(wordsets);
  console.log(`→ Selected wordsets:\n• ${ws1.join(', ')}\n• ${ws2.join(', ')}`);

  const prompts = await generatePromptsFromWordsets(ws1, ws2);

  const filename = getOutputFilename();
  const filepath = path.join(OUTPUT_DIR, filename);

  await fs.writeFile(filepath, JSON.stringify({ prompts }, null, 2), 'utf-8');
  await fs.writeFile(filepath + '.done', '', 'utf-8');

  console.log(`✓ Saved ${prompts.length} prompts and flagged ${filename} as complete`);
}

run().catch(err => {
  console.error('✗ serverC failed:', err);
});
