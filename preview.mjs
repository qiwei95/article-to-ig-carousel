import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = text => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
const escape = text => text.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export async function readSpec(dir) {
  const source = normalize(await readFile(join(dir, 'article.md'), 'utf8'));
  if (!source) throw new Error('article.md 没有正文。');
  const raw = await readFile(join(dir, 'carousel.json'), 'utf8');
  const spec = JSON.parse(raw);
  if (!spec || !Array.isArray(spec.questions) ||
      spec.questions.some(question => typeof question !== 'string' || !question.trim())) {
    throw new Error('carousel.json 需要 questions 数组。');
  }
  if (spec.questions.length) throw new Error('待你确认\n' + spec.questions.map(q => '• ' + q).join('\n'));

  const { caption, slides, sourceUrl, qa } = spec;
  if (typeof spec.sample !== 'boolean' || !['checked', 'pending'].includes(qa)) {
    throw new Error('请填写 sample 和 qa。');
  }
  if (typeof caption !== 'string' || !caption.trim() || caption.length > 2200) {
    throw new Error('Caption 需要有内容，最多 2,200 字符。');
  }
  if (typeof sourceUrl !== 'string' || (sourceUrl && !['https:', 'http:'].includes(new URL(sourceUrl).protocol))) {
    throw new Error('sourceUrl 请填原文链接，或用空字符串。');
  }
  const single = spec.format === 'single';
  if (!Array.isArray(slides) || (single ? slides.length !== 1 : slides.length < 5 || slides.length > 6)) {
    throw new Error(single ? '单图贴文只可以有一张。' : 'Carousel 请安排 5–6 张。');
  }
  for (const [index, slide] of slides.entries()) {
    const keys = { title: 68, body: 210, evidence: Infinity };
    for (const [key, max] of Object.entries(keys)) {
      if (typeof slide?.[key] !== 'string' || !slide[key].trim() || [...slide[key]].length > max) {
        throw new Error(`第 ${index + 1} 张的 ${key} 为空或太长。`);
      }
    }
    if (slide.points !== undefined && (!Array.isArray(slide.points) || slide.points.length > 4 ||
        slide.points.some(point => typeof point !== 'string' || !point.trim() || [...point].length > 100))) {
      throw new Error(`第 ${index + 1} 张的 points 最多可放 4 条短句。`);
    }
    if (slide.note !== undefined && (typeof slide.note !== 'string' || [...slide.note].length > 120)) {
      throw new Error(`第 ${index + 1} 张的 note 请缩短到 120 字符以内。`);
    }
    if (!source.includes(normalize(slide.evidence))) {
      throw new Error(`第 ${index + 1} 张的依据在原文里找不到。`);
    }
  }
  const sourceDigest = sha(source);
  const url = sourceUrl && new URL(sourceUrl);
  if (url) {
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return { spec, sourceDigest, urlDigest: url ? sha(url.href) : null, specDigest: sha(raw) };
}

const css = `
  * { box-sizing: border-box }
  body { margin: 0 }
  .card {
    width: 1080px; height: 1080px; padding: 80px;
    display: flex; flex-direction: column; overflow: hidden;
    background: #fffdf7; color: #1f2b28;
    font: 500 40px/1.45 "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  .cover, .final { color: #fffdf7; background: #193c35 }
  .copy { margin-block: auto; max-height: 845px; min-height: 0; overflow: hidden }
  h1 { margin: 0 0 28px; font-size: 80px; line-height: 1.17; white-space: pre-line; overflow-wrap: anywhere }
  .cover h1 { font-size: 98px }
  p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere }
  .points { margin: 30px 0 0; padding-left: 1.15em; line-height: 1.35 }
  .points li { margin-bottom: 13px; overflow-wrap: anywhere }
  .points li::marker { color: #ad6236 }
  .final .points li::marker { color: #f8bc78 }
  .note {
    margin-top: 29px; padding: 16px 23px; font-size: 32px;
    border-left: 5px solid #ad6236; background: #f6ecda; overflow-wrap: anywhere;
  }
  .cover .note, .final .note { border-color: #f8bc78; background: #ffffff16 }
  .footer { font-size: 25px; display: flex; align-items: center; gap: 30px; height: 36px }
  .progress { display: flex; flex: 1; gap: 9px; height: 6px }
  .progress i { flex: 1; background: currentColor; opacity: .24 }
  .progress i.current { background: #ad6236; opacity: 1 }
  .cover i.current, .final i.current { background: #f8bc78 }
`;

function card(slide, number, total) {
  const role = number === 1 ? 'cover' : number === total ? 'final' : '';
  const progress = Array.from({ length: total }, (_, i) =>
    `<i class="${i + 1 === number ? 'current' : ''}"></i>`).join('');
  const points = slide.points?.length
    ? `<ul class="points">${slide.points.map(point => `<li>${escape(point)}</li>`).join('')}</ul>`
    : '';
  const note = slide.note ? `<div class="note">${escape(slide.note)}</div>` : '';
  const footer = total > 1
    ? `<footer class="footer"><div class="progress">${progress}</div><span>${number} / ${total}</span></footer>`
    : '';
  return `<!DOCTYPE html><html lang="zh-Hans"><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
    <style>${css}</style><article class="card ${role}">
      <section class="copy"><h1>${escape(slide.title)}</h1><p>${escape(slide.body)}</p>${points}${note}</section>
      ${footer}
    </article></html>`;
}

async function render(dir) {
  const { spec, sourceDigest, urlDigest, specDigest } = await readSpec(dir);
  const executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
  const images = [];
  let contactSheet;
  const output = join(dir, 'media');
  await mkdir(output, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
    for (const [index, slide] of spec.slides.entries()) {
      await page.setContent(card(slide, index + 1, spec.slides.length));
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const fits = await page.locator('.copy').evaluate(el =>
        el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth);
      if (!fits) throw new Error(`第 ${index + 1} 张文字超出版面，请缩短后重新预览。`);
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 });
      images.push(jpeg);
    }
    if (images.length === 1) {
      contactSheet = images[0];
    } else {
      const thumbs = images.map(jpeg => `<img src="data:image/jpeg;base64,${jpeg.toString('base64')}">`).join('');
      await page.setViewportSize({ width: 1060, height: 1300 });
      await page.setContent(`<!DOCTYPE html><meta charset="UTF-8"><style>
        body{margin:0;background:#eceee9}main{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:20px}
        img{width:100%;display:block;border-radius:3px}</style><main>${thumbs}</main>`);
      await page.locator('main img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      contactSheet = await page.locator('main').screenshot({ type: 'jpeg', quality: 88 });
    }
  } finally {
    await browser.close();
  }

  const files = [];
  for (const [index, jpeg] of images.entries()) {
    const name = `slide-${String(index + 1).padStart(2, '0')}.jpg`;
    await writeFile(join(output, name), jpeg);
    files.push({ name, sha256: sha(jpeg) });
  }
  await writeFile(join(dir, 'preview.jpg'), contactSheet);
  const manifest = { sourceDigest, urlDigest, specDigest, previewDigest: sha(contactSheet), files };
  const version = sha(JSON.stringify(manifest));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version, ...manifest }, null, 2) + '\n');
  console.log(JSON.stringify({ version, slides: files.map(file => file.name), preview: join(dir, 'preview.jpg') }));
}

export async function verifyPreview(dir) {
  const { spec, sourceDigest, urlDigest, specDigest } = await readSpec(dir);
  const { version, ...manifest } = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (version !== sha(JSON.stringify(manifest)) || manifest.sourceDigest !== sourceDigest ||
      manifest.urlDigest !== urlDigest || manifest.specDigest !== specDigest ||
      manifest.files.length !== spec.slides.length) throw new Error('稿件已改动，请重新生成预览。');
  if (manifest.previewDigest !== sha(await readFile(join(dir, 'preview.jpg')))) {
    throw new Error('预览图已改动，请重新生成预览。');
  }
  const media = [];
  for (const [index, file] of manifest.files.entries()) {
    if (file.name !== `slide-${String(index + 1).padStart(2, '0')}.jpg`) {
      throw new Error('图卡顺序异常，请重新生成预览。');
    }
    const bytes = await readFile(join(dir, 'media', file.name));
    if (sha(bytes) !== file.sha256) throw new Error(`${file.name} 已改动，请重新生成预览。`);
    media.push({ ...file, bytes });
  }
  return { spec, sourceDigest, urlDigest, version, media };
}

async function main() {
  const [mode, directory, version] = process.argv.slice(2);
  if (mode !== '--check') return render(resolve(mode || 'example'));
  if (!directory || !version) throw new Error('用法: node preview.mjs --check <稿件目录> <已批准的版本号>');
  const dir = resolve(directory);
  const draft = await verifyPreview(dir);
  if (draft.spec.sample) throw new Error('这是示例稿，不能发布。');
  if (draft.spec.qa !== 'checked') throw new Error('请先逐页对照原文，也检查 Caption。');
  if (draft.version !== version) throw new Error('批准的版本与当前预览不一致。');
  console.log(JSON.stringify({
    version,
    caption: draft.spec.caption,
    files: draft.media.map(declared => join(dir, 'media', declared.name)),
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
