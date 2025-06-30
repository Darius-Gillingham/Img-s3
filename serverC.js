// File: serverC.js
// Commit: read wordsets from Supabase `wordsets/` bucket and upload prompts to `prompts/` bucket

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

dotenv.config();
console.log('=== Running serverC.js ===');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getTimestampFilename(prefix = 'generated-prompts') {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}-${timestamp}.json`;
}

async function fetchAllWordsets() {
  const { data: files, error } = await supabase.storage.from('wordsets').list('', {
    limit: 100,
    sortBy: { column: 'name', order: 'desc' }
  });

  if (error || !files || files.length === 0) {
    console.warn('✗ Failed to list wordset files:', error);
    return [];
  }

  const wordsets = [];

  for (const file of files) {
    if (!file.name.endsWith('.json')) continue;

    const { data, error } = await supabase.storage
      .from('wordsets')
      .download(file.name);

    if (error || !data) {
      console.warn(`✗ Failed to download ${file.name}:`, error);
      continue;
    }

    const text = await data.text();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.wordsets)) {
        wordsets.push(...parsed.wordsets);
      }
    } catch {
      console.warn(`✗ Failed to parse ${file.name}`);
    }
  }

  return wordsets;
}

function pickTwoDistinct(arr) {
  const first = arr[Math.floor(Math.random() * arr.length)];
  let second = first;
  while (second === first && arr.length > 1) {
    second = arr[Math.floor(Math.random() * arr.length)];
  }
  return [first, second];
}

async function generatePrompts(ws1, ws2) {
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

async function uploadPromptsToBucket(prompts, filename) {
  const json = JSON.stringify({ prompts }, null, 2);
  const { error } = await supabase.storage
    .from('prompts')
    .upload(filename, new Blob([json], { type: 'application/json' }), {
      upsert: false
    });

  if (error) {
    console.error('✗ Failed to upload prompt file:', error);
    return;
  }

  console.log(`✓ Uploaded prompt file: ${filename}`);
}

async function run() {
  const wordsets = await fetchAllWordsets();

  if (wordsets.length < 2) {
    console.warn('✗ Not enough wordsets to compose a pair.');
    return;
  }

  const [ws1, ws2] = pickTwoDistinct(wordsets);
  console.log(`→ Selected wordsets:\n• ${ws1.join(', ')}\n• ${ws2.join(', ')}`);

  const prompts = await generatePrompts(ws1, ws2);
  const filename = getTimestampFilename();
  await uploadPromptsToBucket(prompts, filename);
}

run().catch(err => {
  console.error('✗ serverC failed:', err);
});
