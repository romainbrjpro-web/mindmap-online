const TEXT_PROMPT = (word) => `Generate a structured note about: ${word}

Use the most relevant sections depending on the subject.

Be concise (8 lines max), easy to read, skip lines.

Do not repeat the title.`;

const IMAGE_PROMPT = (word) => `Create a realistic educational image representing: ${word}.

The image must be useful as a visual memory aid for an Obsidian knowledge note.

If a person appears in the image:
- prefer an adult man
- use a woman only if it is more appropriate for the concept

Style:
- realistic
- clear central subject
- visually rich
- modern and clean
- strong composition
- easy to understand at small size
- no watermark
- not an icon`;

async function apiFetch(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || text.slice(0, 200);
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

async function generateText(deepseekKey, word) {
  const data = await apiFetch('https://api.deepseek.com/chat/completions', deepseekKey, {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: TEXT_PROMPT(word) }],
    max_tokens: 1000,
  });
  return data.choices?.[0]?.message?.content || null;
}

async function urlToDataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Impossible de télécharger l\'image');
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function generateImage(openaiKey, word) {
  const prompt = IMAGE_PROMPT(word);

  const data = await apiFetch('https://api.openai.com/v1/images/generations', openaiKey, {
    model: 'gpt-image-2',
    prompt,
    size: '1024x1024',
    quality: 'medium',
    response_format: 'b64_json',
    n: 1,
  });

  const item = data.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return urlToDataUri(item.url);
  throw new Error('gpt-image-2: aucune image retournée par l\'API');
}

async function generateNote(deepseekKey, openaiKey, word) {
  const [textResult, imageResult] = await Promise.allSettled([
    generateText(deepseekKey, word),
    generateImage(openaiKey, word),
  ]);

  const text = textResult.status === 'fulfilled' ? textResult.value : null;
  const image = imageResult.status === 'fulfilled' ? imageResult.value : null;

  const errors = [];
  if (textResult.status === 'rejected') errors.push(`Texte: ${textResult.reason.message}`);
  if (imageResult.status === 'rejected') errors.push(`Image: ${imageResult.reason.message}`);

  if (!text && !image) {
    throw new Error(errors.join(' | ') || 'Génération échouée');
  }

  let note = '';
  if (image) note += image;
  if (text) note += (note ? '\n\n' : '') + text;

  return { note, text, image, imageModel: image ? 'gpt-image-2' : null, warnings: errors };
}

module.exports = { generateNote };
