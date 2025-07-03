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

    const { data, error } = await supabase.storage.from('wordsets').download(file.name);
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

function sanitizePrompt(text, maxWords = 20) {
  return text
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, ' ')
    .split(' ')
    .slice(0, maxWords)
    .join(' ');
}

async function generatePrompts(ws1, ws2) {
  const combined = Array.from(new Set([...ws1, ...ws2]));
  const wordList = combined.join(', ');

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    temperature: 0.5,
    top_p: 0.8,
    messages: [
      {
        role: 'system',
        content:
          'You are a terse, literal prompt generator. Given a word list, return 5 concrete, non-poetic DALL·E prompts.\n' +
          '- Do NOT use emotional language, metaphors, or abstract phrasing.\n' +
          '- Use physical nouns, clear styles, and specific locations.\n' +
          '- Avoid filler words and minimize adjectives.\n' +
          '- Format your output as a plain list, no explanation.'
      },
      {
        role: 'user',
        content: `Wordset: ${wordList}`
      }
    ]
  });

  const content = response.choices[0].message?.content;
  if (!content) throw new Error('No response content from GPT');

  return content
    .split('\n')
    .map(line => line.trim().replace(/^\d+[\).]\s*/, ''))
    .map(line => sanitizePrompt(line))
    .filter(line => line.length > 0);
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

async function loopForever(intervalMs = 30000) {
  while (true) {
    try {
      const wordsets = await fetchAllWordsets();

      if (wordsets.length < 2) {
        console.warn('✗ Not enough wordsets to compose a pair.');
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        continue;
      }

      const [ws1, ws2] = pickTwoDistinct(wordsets);
      console.log(`→ Selected wordsets:\n• ${ws1.join(', ')}\n• ${ws2.join(', ')}`);

      const prompts = await generatePrompts(ws1, ws2);
      const filename = getTimestampedFilename();
      await uploadPromptsToBucket(prompts, filename);
    } catch (err) {
      console.error('✗ Loop iteration failed:', err);
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

loopForever();
