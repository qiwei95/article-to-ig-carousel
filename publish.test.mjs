import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSpec, sha } from './preview.mjs';
import { publish } from './publish.mjs';

const env = {
  IG_PUBLISH_MODE: 'review',
  IG_USERNAME: 'sample.account',
  IG_USER_ID: '123',
  IG_ACCESS_TOKEN: 'synthetic-token',
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'synthetic-key',
  CLOUDINARY_API_SECRET: 'synthetic-secret',
};

async function writeSpec(dir, changes) {
  const path = join(dir, 'carousel.json');
  const spec = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...spec, ...changes }));
}

async function makeDraft(t) {
  const temp = await mkdtemp(join(tmpdir(), 'carousel-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = join(temp, 'draft');
  await cp(new URL('./example/', import.meta.url), dir, { recursive: true });
  await writeSpec(dir, { sample: false });
  const { sourceDigest, urlDigest, specDigest } = await readSpec(dir);
  const files = [];
  await mkdir(join(dir, 'media'));
  for (let i = 1; i <= 5; i += 1) {
    const name = `slide-0${i}.jpg`;
    const bytes = Buffer.from(`synthetic slide ${i}`);
    await writeFile(join(dir, 'media', name), bytes);
    files.push({ name, sha256: sha(bytes) });
  }
  const preview = 'synthetic preview';
  await writeFile(join(dir, 'preview.jpg'), preview);
  const previewDigest = sha(preview);
  const manifest = { sourceDigest, urlDigest, specDigest, previewDigest, files };
  const version = sha(JSON.stringify(manifest));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version, ...manifest }));
  return { dir, version, stateRoot: join(temp, 'state') };
}

function mockServices({ ambiguous = false, username = 'sample.account' } = {}) {
  const calls = { upload: 0, publish: 0, children: [] };
  const fetcher = async (uri, options) => {
    const url = new URL(uri);
    const reply = body => Response.json(body);
    if (url.hostname === 'api.cloudinary.com') {
      calls.upload += 1;
      const fields = new URLSearchParams();
      for (const key of ['overwrite', 'public_id', 'timestamp']) fields.set(key, options.body.get(key));
      const signed = [...fields.entries()].map(([key, value]) => `${key}=${value}`).join('&');
      assert.equal(options.body.get('signature'), createHash('sha256').update(signed + env.CLOUDINARY_API_SECRET).digest('hex'));
      const publicId = fields.get('public_id');
      const jpeg = Buffer.from(await options.body.get('file').arrayBuffer());
      assert.equal(sha(jpeg), publicId.split('/').at(-1));
      return reply({ public_id: publicId, format: 'jpg',
        secure_url: `https://res.cloudinary.com/test-cloud/image/upload/${publicId}.jpg` });
    }
    assert.equal(url.hostname, 'graph.instagram.com');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    const path = url.pathname.replace('/v25.0/', '');
    if (path === '123') return reply({ id: '123', username });
    if (path === '123/content_publishing_limit') return reply({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] });
    if (path === '900') return reply({ permalink: 'https://www.instagram.com/p/FAKE-TEST-POST/' });
    if (path === '123/media') {
      const body = JSON.parse(options.body);
      if (body.media_type === 'CAROUSEL') {
        assert.equal(body.children, '401,402,403,404,405');
        assert.match(body.caption, /交接/);
        return reply({ id: '500' });
      }
      assert.equal(body.is_carousel_item, true);
      calls.children.push(body.image_url);
      return reply({ id: String(400 + calls.children.length) });
    }
    if (path === '123/media_publish') {
      calls.publish += 1;
      assert.deepEqual(JSON.parse(options.body), { creation_id: '500' });
      if (ambiguous) throw new Error('response lost');
      return reply({ id: '900' });
    }
    assert.match(path, /^(40[1-5]|500)$/);
    return reply({ status_code: path === '500' && calls.publish ? 'PUBLISHED' : 'FINISHED' });
  };
  return { fetcher, calls };
}

test('preview and approval gate external writes', async t => {
  const { dir, version, stateRoot } = await makeDraft(t);
  const fetcher = () => assert.fail('Expected zero network requests');
  const options = { env, fetcher, stateRoot };
  await assert.rejects(publish(dir, undefined, options), /先确认/);
  await assert.rejects(publish(dir, 'stale-version', options), /不一致/);
  await assert.rejects(publish(dir, version, { ...options, env: {} }), /预览模式/);
  await writeSpec(dir, { questions: ['这组数据的出处是什么？'] });
  await assert.rejects(publish(dir, version, options), /待你确认/);
});

test('changed preview and a wrong IG account block publishing', async t => {
  const { dir, version, stateRoot } = await makeDraft(t);
  const { fetcher, calls } = mockServices({ username: 'other-account' });
  const options = { env, fetcher, stateRoot };
  await assert.rejects(publish(dir, version, options), /账号和本地设置不一致/);
  assert.equal(calls.upload, 0);
  await writeFile(join(dir, 'media', 'slide-01.jpg'), 'changed-media');
  await assert.rejects(publish(dir, version, options), /slide-01.jpg 已改动/);
});

test('approved version produces one ordered carousel and returns the saved permalink on retry', async t => {
  const { dir, version, stateRoot } = await makeDraft(t);
  const { fetcher, calls } = mockServices();
  const first = await publish(dir, version, { env, fetcher, stateRoot });
  const next = await publish(dir, version, { env, fetcher, stateRoot });
  assert.deepEqual(next, first);
  assert.equal(first.permalink, 'https://www.instagram.com/p/FAKE-TEST-POST/');
  assert.equal(calls.publish, 1);
  assert.equal(calls.upload, 5);
});

test('uncertain publish receipt is held before any second publish request', async t => {
  const { dir, version, stateRoot } = await makeDraft(t);
  const { fetcher, calls } = mockServices({ ambiguous: true });
  const options = { env, fetcher, stateRoot };
  await assert.rejects(publish(dir, version, options), /发布结果待核对/);
  await assert.rejects(publish(dir, version, options), /容器状态 PUBLISHED/);
  assert.equal(calls.publish, 1);
});
