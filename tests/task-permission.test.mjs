import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Exercise the bundled plugin with owner-selected Host permissions. The Host
// applies a preference only when the plugin omits the creation override.
async function firstQuestion(permissionMode) {
  const tasks = new Map(), disk = new Map(), creations = [];
  let handler, epoch;
  const route = { agentKind: 'codex', providerId: 'local', model: 'model-one', effort: 'high', fastMode: false };
  const config = { schema: 3, bots: [{ id: 'bot1', appId: '12345', enabled: true, groups: [{ groupOpenid: 'group', projectId: 'C:/project', route }] }] };
  const create = async req => {
    creations.push(req);
    const task = { taskId: 'member-task', revision: 1, status: 'active', permissionMode: req.permissionMode ?? permissionMode, route };
    tasks.set(task.taskId, task);
    return task;
  };
  const cindy = {
    onHostMessage(fn) { handler = fn; }, async send() {},
    async fs(req) {
      if (req.op === 'read') return disk.has(req.path) ? { ok: true, content: disk.get(req.path) } : { ok: false, errorCode: 'NOT_FOUND' };
      disk.set(req.path, req.content); return { ok: true };
    },
    targets: {
      async list() { return { targets: [] }; }, async resolve(req) { return req.target; },
      async get() { return { found: false }; },
      async send(req) { const task = await create(req); return { accepted: true, taskId: task.taskId, delivery: 'queue' }; },
    },
    tasks: {
      async capabilities() { return { operations: ['create', 'get', 'send', 'setModel', 'getRun'], createPermissionMode: true }; },
      create,
      async get(req) { if (tasks.has(req.taskId)) return tasks.get(req.taskId); throw Object.assign(new Error('Missing task'), { code: 'TASK_NOT_FOUND' }); },
      async setModel(req) { return { status: 'unchanged', task: tasks.get(req.taskId) }; },
      async send() { return { runId: 'run-one' }; }, async getRun() { return { status: 'completed' }; },
    },
    node: { async request(req) {
      if (req.method.startsWith('qq/connect')) epoch = req.params.epoch;
      return { ok: true, result: req.method === 'qq/status' ? { state: 'connected', appId: '12345', epoch } : { connecting: true } };
    } },
  };
  const sandbox = { cindy, crypto: webcrypto, TextEncoder, Date, queueMicrotask,
    setInterval() {}, setTimeout(fn) { queueMicrotask(fn); }, BroadcastChannel: class { postMessage() {} },
    async fetch(path) { return { ok: true, async json() { return path === '/kv' ? config : path === '/secrets' ? [{ key: 'qq_app_secret', saved: true }] : {}; } }; },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8'), sandbox);
  await handler({ type: 'tool-call', tool: 'get_status', args: {}, callId: 'boot' });
  await handler({ type: 'event', name: 'node-notification', method: 'qq/status', params: { botId: 'bot1', state: 'connected', epoch } });
  await handler({ type: 'event', name: 'node-notification', method: 'qq/message', params: {
    botId: 'bot1', appId: '12345', kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'one',
    groupId: 'group', senderId: 'member', timestamp: new Date().toISOString(), text: '查询活动时间',
  } });
  return { creations, tasks };
}

for (const mode of ['ask', 'auto', 'bypassPermissions']) {
  test('new QQ task inherits owner Host permission: ' + mode, async () => {
    const { creations, tasks } = await firstQuestion(mode);
    assert.equal(creations.length, 1);
    assert.equal(Object.hasOwn(creations[0], 'permissionMode'), false);
    assert.equal(tasks.get('member-task').permissionMode, mode);
  });
}
