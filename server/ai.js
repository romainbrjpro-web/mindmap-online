const TEXT_PROMPT = (term) => `
Write an ULTRA short note about: ${term}

Strict rules:
- Detect the language of the title "${term}" and write the WHOLE note in that same language (e.g. English title => English note, French title => French note).
- 4 lines maximum in total.
- Start with ONE short sentence defining the subject (max 12 words).
- Then 2 to 3 very short bullet points (max 8 words each), only the absolute essentials.
- Simple, common words, no complex sentences.
- No title, no sections, no bold, no introduction, no conclusion.
- Do not repeat the title. No superfluous information.
`;

const IMAGE_PROMPT = (term) => `
Create a realistic educational image representing: ${term}.

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
- not an icon
`;

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
    console.error('API error:', url, data);
    const msg = data?.error?.message || data?.error || text.slice(0, 300);
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

async function generateText(deepseekKey, word) {
  const data = await apiFetch('https://api.deepseek.com/chat/completions', deepseekKey, {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: TEXT_PROMPT(word) }],
    max_tokens: 200,
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
  const imagePrompt = IMAGE_PROMPT(word);

  const data = await apiFetch('https://api.openai.com/v1/images/generations', openaiKey, {
    model: 'gpt-image-2',
    prompt: imagePrompt,
    size: '1024x1024',
    quality: 'low',
    n: 1,
  });

  const base64Image = data.data?.[0]?.b64_json;
  if (base64Image) return `data:image/png;base64,${base64Image}`;

  const url = data.data?.[0]?.url;
  if (url) return urlToDataUri(url);

  console.error('OpenAI image response:', JSON.stringify(data).slice(0, 800));
  throw new Error('gpt-image-2: aucune image retournée (pas de b64_json)');
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
