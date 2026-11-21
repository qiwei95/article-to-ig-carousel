import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyPreview } from './preview.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const idPattern = /^\d+$/;
const requestOptions = { redirect: 'error' };

function target(env) {
  const username = (env.IG_USERNAME || '').trim().replace(/^@/, '').toLowerCase();
  const id = env.IG_USER_ID || '';
  const token = env.IG_ACCESS_TOKEN;
  const version = env.IG_GRAPH_VERSION || 'v25.0';
  if (!/^[a-z0-9._]{1,30}$/.test(username) || !idPattern.test(id) || !token || !/^v\d+\.0$/.test(version)) {
    throw new Error('请先在本地配置目标 IG 用户名、IG User ID、Instagram Login access token 和 Graph API 版本。');
  }
  return { username, id, token, version };
}

async function requestJson(fetcher, url, options, service) {
  try {
    const response = await fetcher(url, { ...requestOptions, signal: AbortSignal.timeout(30_000), ...options });
    const result = await response.json();
    if (!response.ok || result.error) {
      const code = result.error?.code;
      const subcode = result.error?.error_subcode;
      const detail = [code, subcode].filter(Number.isInteger).join('/');
      const failure = new Error(`${service} HTTP ${response.status}${detail ? '，错误码 ' + detail : ''}`);
      failure.isRejection = response.status >= 400 && response.status < 500 && Boolean(result.error);
      throw failure;
    }
    return result;
  } catch (error) {
    if (error.message.startsWith(service + ' HTTP ')) throw error;
    throw new Error(`${service} 连接失败或没有返回可读的结果。`);
  }
}

function graphClient(account, fetcher) {
  return (path, params, post = false) => {
    const url = new URL(`https://graph.instagram.com/${account.version}/${path}`);
    const headers = { Authorization: `Bearer ${account.token}` };
    const options = { headers };
    if (post) {
      options.method = 'POST';
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(params);
    } else {
      url.search = new URLSearchParams(params).toString();
    }
    return requestJson(fetcher, url, options, 'Instagram');
  };
}

async function checkAccount(account, graph) {
  const profile = await graph(account.id, { fields: 'id,username' });
  if (profile.id !== account.id || profile.username?.toLowerCase() !== account.username) {
    throw new Error('Instagram 返回的账号和本地设置不一致，请确认 IG User ID 及 @账号。');
  }
  const { data } = await graph(`${account.id}/content_publishing_limit`, { fields: 'config,quota_usage' });
  const usage = data?.[0]?.quota_usage;
  const limit = data?.[0]?.config?.quota_total;
  if (!Number.isInteger(usage) || !Number.isInteger(limit)) {
    throw new Error('Instagram 没有返回可核对的发布额度。');
  }
  return { username: profile.username, id: profile.id, usage, limit };
}

function cloudUploader(env, fetcher) {
  const cloud = env.CLOUDINARY_CLOUD_NAME;
  const key = env.CLOUDINARY_API_KEY;
  const secret = env.CLOUDINARY_API_SECRET;
  if (!/^[a-z0-9_-]+$/i.test(cloud || '') || !key || !secret) {
    throw new Error('请先配置 Cloudinary 图床。Meta 需要能读取图卡的 HTTPS 网址。');
  }
  return async (media, jobId) => {
    const fields = {
      overwrite: 'false',
      public_id: `ig-carousel/${jobId}/${media.sha256}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const signature = createHash('sha256')
      .update(Object.entries(fields).map(([name, value]) => `${name}=${value}`).join('&') + secret)
      .digest('hex');
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    body.set('file', new Blob([media.bytes], { type: 'image/jpeg' }), media.name);
    body.set('api_key', key);
    body.set('signature', signature);
    const result = await requestJson(fetcher, `https://api.cloudinary.com/v1_1/${cloud}/image/upload`,
      { method: 'POST', body }, 'Cloudinary');
    if (result.public_id !== fields.public_id || result.format !== 'jpg' ||
        !result.secure_url?.startsWith(`https://res.cloudinary.com/${cloud}/image/upload/`)) {
      throw new Error('Cloudinary 没有返回预期的 JPEG 地址。');
    }
    return result.secure_url;
  };
}

async function readLedger(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

function responseId(result) {
  if (typeof result.id !== 'string' || !idPattern.test(result.id)) {
    throw new Error('Instagram 没有返回可识别的 ID。');
  }
  return result.id;
}

async function waitForContainer(graph, id, pause) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { status_code: status } = await graph(id, { fields: 'status_code' });
    if (status === 'FINISHED') return;
    if (status !== 'IN_PROGRESS') {
      const error = new Error(`Instagram 媒体容器状态为 ${status || '未知'}。`);
      error.containerStatus = status;
      throw error;
    }
    if (attempt < 4) await pause(60_000);
  }
  throw new Error('Instagram 还在处理图卡，可以用同一版本查询或继续。');
}

export async function publish(dir, approvedVersion, {
  env = process.env, fetcher = fetch, pause = sleep, stateRoot = join(root, '.publish-state'),
} = {}) {
  const draft = await verifyPreview(dir);
  if (draft.spec.sample) throw new Error('这是示例稿，不能发布。');
  if (draft.spec.format === 'single') throw new Error('这张单图请使用 Instagram 网页发布。');
  if (draft.spec.qa !== 'checked') throw new Error('请先逐页对照原文，也检查 Caption。');

  const mode = env.IG_PUBLISH_MODE || 'preview';
  if (mode !== 'review') throw new Error('目前是预览模式。');
  if (!approvedVersion) throw new Error('请先确认这次预览，再用同一版本发布。');
  if (approvedVersion !== draft.version) throw new Error('批准的版本与当前预览不一致。');
  const account = target(env);
  const graph = graphClient(account, fetcher);
  const mediaDir = join(stateRoot, account.id);
  const lock = join(mediaDir, 'publishing');
  const path = join(mediaDir, 'posts.json');

  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('这个账号已有发布任务。请先确认该任务的结果。');
    throw error;
  }

  try {
    const profile = await checkAccount(account, graph);
    const records = await readLedger(path);
    const save = async () => {
      const temp = path + '.tmp';
      await writeFile(temp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, path);
    };
    let record = records.find(item => item.sourceDigest === draft.sourceDigest ||
      (draft.urlDigest && item.urlDigest === draft.urlDigest));
    const receipt = () => ({
      username: account.username,
      mediaId: record.mediaId,
      permalink: record.permalink || null,
    });
    const link = async () => {
      if (!record.permalink) {
        const { permalink } = await graph(record.mediaId, { fields: 'permalink' });
        if (typeof permalink !== 'string' || !/^https:\/\/(www\.)?instagram\.com\/p\//.test(permalink)) {
          throw new Error('Instagram 已回传发布 ID，但贴文链接还没查到。');
        }
        record.permalink = permalink;
        await save();
      }
      return receipt();
    };
    if (record?.mediaId) return link();
    if (record?.attemptedAt) {
      const status = (await graph(record.parent, { fields: 'status_code' })).status_code;
      throw new Error(`上一次发文结果待核对（Instagram 容器状态 ${status || '未知'}）。请先打开 IG 确认，避免重复发布。`);
    }
    if (profile.usage >= profile.limit) throw new Error('Instagram 的发布额度已用完，请等额度恢复。');
    const upload = cloudUploader(env, fetcher);
    if (!record || record.version !== draft.version || Date.now() - Date.parse(record.startedAt) >= 23 * 60 * 60_000) {
      if (record) records.splice(records.indexOf(record), 1);
      record = { sourceDigest: draft.sourceDigest, urlDigest: draft.urlDigest,
        version: draft.version, startedAt: new Date().toISOString(), urls: [], children: [] };
      records.push(record);
      await save();
    }
    for (const [index, media] of draft.media.entries()) {
      if (!record.urls[index]) {
        record.urls[index] = await upload(media, draft.version);
        await save();
      }
      if (!record.children[index]) {
        record.children[index] = responseId(await graph(`${account.id}/media`,
          { image_url: record.urls[index], is_carousel_item: true }, true));
        await save();
      }
    }

    try {
      // Wait for all checks to settle before resetting containers.
      const statuses = await Promise.allSettled(record.children.map(id => waitForContainer(graph, id, pause)));
      const failure = statuses.find(result => result.status === 'rejected' &&
        ['ERROR', 'EXPIRED'].includes(result.reason.containerStatus)) ||
        statuses.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (!record.parent) {
        record.parent = responseId(await graph(`${account.id}/media`, {
          media_type: 'CAROUSEL',
          children: record.children.join(','),
          caption: draft.spec.caption,
        }, true));
        await save();
      }
      await waitForContainer(graph, record.parent, pause);
    } catch (error) {
      if (['ERROR', 'EXPIRED'].includes(error.containerStatus)) {
        record.children = [];
        delete record.parent;
        await save();
      }
      throw error;
    }

    record.attemptedAt = new Date().toISOString();
    await save();
    try {
      record.mediaId = responseId(await graph(`${account.id}/media_publish`, { creation_id: record.parent }, true));
    } catch (error) {
      if (error.isRejection) {
        delete record.attemptedAt;
        await save();
        throw error;
      }
      throw new Error(`IG 发布结果待核对。请先查看 @${account.username}，再决定下一步。`);
    }
    await save();
    return link();
  } finally {
    await rmdir(lock);
  }
}

async function main() {
  const [command, dir, flag, version] = process.argv.slice(2);
  if (command === 'check-account' && !dir) {
    const account = target(process.env);
    console.log(JSON.stringify(await checkAccount(account, graphClient(account, fetch))));
    return;
  }
  if (command !== 'publish' || !dir || (flag !== undefined && (flag !== '--approved' || !version))) {
    throw new Error('用法: node --env-file=.env publish.mjs check-account | publish <稿件目录> [--approved <版本号>]');
  }
  console.log(JSON.stringify(await publish(resolve(dir), version)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
