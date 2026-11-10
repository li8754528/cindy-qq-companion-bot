import { fault } from './controller.mjs';

// Read the public pipe envelope: Electron contextBridge can discard custom
// properties on Errors thrown by the convenience API. Never authorize by text.
export async function getHostTask(taskId) {
  const result = await cindy.send({ type: 'tasks-request', kind: 'get', taskId });
  if (result?.ok === true) return result.data;
  const code = result?.ok === false && typeof result.error?.code === 'string'
    ? result.error.code : 'SOURCE_UNCERTAIN';
  throw fault(code, result?.error?.message || '宿主任务来源查询未确认。');
}
