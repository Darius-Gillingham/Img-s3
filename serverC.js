import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import OpenAI from 'openai';

dotenv.config();
console.log('=== Running serverC.js ===');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getTimestampedFilename(index) {
  const now = new Date();
  const tag = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `image-${tag}-${index + 1}.png`;
}

async function fetchAllWordsets() {
  const { data: files, error } = await supabase.storage.from('wordsets').list('', {
    limit: 100,
    sortBy: { column: 'name', order: 'desc' }
  });

  if (error || !files) {
    console.warn('✗ Failed to list wordsets:', error);
    return [];
  }

  const wordsets = [];

  for (const file of files) {
    if (!file.name.endsWith('.json')) continue;

    const { data, error } = await supabase.storage.from('wordsets').download(file.name);
    if (error || !data) continue;

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

function pickOneRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildPrompt(wordset) {
  return `No text overlay. A visual interpretation of: ${wordset.join(', ')}.`;
}

async function downloadImageBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function uploadImage(buffer, filename) {
  const { error } = await supabase.storage
    .from('generated-images')
    .upload(filename, buffer, {
      contentType: 'image/png',
      upsert: false
    });

  if (error) {
    console.error(`✗ Failed to upload ${filename}:`, error);
  } else {
    console.log(`✓ Uploaded image: ${filename}`);
  }
}

async function generateImage(prompt, index) {
  console.log(`→ Generating image for prompt: "${prompt}"`);

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024'
  });

  const url = response.data?.[0]?.url;
  if (!url) throw new Error('No image URL returned.');

  const buffer = await downloadImageBuffer(url);
  const filename = getTimestampedFilename(index);
  await uploadImage(buffer, filename);
}

async function loopForever(batchSize = 5, intervalMs = 60000) {
  while (true) {
    try {
      const wordsets = await fetchAllWordsets();
      if (wordsets.length < 1) {
        console.warn('✗ No wordsets found.');
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }

      console.log(`→ Generating ${batchSize} images using one wordset per prompt`);

      for (let i = 0; i < batchSize; i++) {
        const ws = pickOneRandom(wordsets);
        const prompt = buildPrompt(ws);
        try {
          await generateImage(prompt, i);
        } catch (err) {
          console.error(`✗ Failed image #${i + 1}:`, err.message);
        }
      }
    } catch (err) {
      console.error('✗ Outer loop error:', err);
    }

    console.log('✓ Batch complete. Waiting before next run...\n');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

loopForever();
