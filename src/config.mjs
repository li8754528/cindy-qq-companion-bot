export const BOT_IDS = ['bot1','bot2','bot3','bot4'];
export const secretKey = id => id === 'bot1' ? 'qq_app_secret' : 'qq_app_secret_' + id.slice(3);
export const connectMethod = id => id === 'bot1' ? 'qq/connect' : 'qq/connect/' + id.slice(3);
const invalid = message => { throw Object.assign(new Error(message), {code:'BOT_CONFIG_INVALID'}); };
export function routeFrom(value) {
  if (value == null) return null;
  if (!['cc','codex','pi'].includes(value.agentKind) || typeof value.providerId !== 'string' || !value.providerId || value.providerId.length > 128 || typeof value.model !== 'string' || !value.model || value.model.length > 256 || typeof value.effort !== 'string' || value.effort.length > 32 || ![true,false,'ultrafast'].includes(value.fastMode) || value.agentDeviceId) invalid('请选择本机可用的完整模型与推理强度。');
  return Object.fromEntries(['agentKind','providerId','model','effort','fastMode'].map(k=>[k,value[k]]));
}
export function groupsFrom(raw) {
  const groups = Array.isArray(raw) ? raw : [];
  if (groups.length > 40) invalid('每个机器人最多配置 40 个群。');
  const seen = new Set();
  return groups.map(g => {
    if (!g || typeof g.groupOpenid !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(g.groupOpenid) || seen.has(g.groupOpenid)) invalid('群标识无效或重复。');
    seen.add(g.groupOpenid);
    const projectId = g.projectId || '';
    if (typeof projectId !== 'string' || projectId.length > 4096 || projectId.includes('\u0000')) invalid('项目标识无效。');
    return {groupOpenid:g.groupOpenid,label:typeof g.label==='string'?g.label.slice(0,60):'',projectId,route:routeFrom(g.route)};
  });
}
export function fleetConfig(raw = {}) {
  if(raw.schema!==undefined&&![1,2,3].includes(raw.schema))throw Object.assign(new Error('群配置来自不兼容版本，已保留原配置，未降级覆盖。'),{code:'CONFIG_UNSUPPORTED'});
  const input = Array.isArray(raw.bots) ? raw.bots : [{...raw,id:'bot1',name:'机器人 1'}];
  if (input.length > 4) throw Object.assign(new Error('最多配置 4 个机器人。'), {code:'BOT_LIMIT'});
  const ids = new Set(), apps = new Set();
  const bots = input.map((b,index) => {
    if (!b || !BOT_IDS.includes(b.id) || ids.has(b.id)) invalid('机器人编号无效或重复。');
    ids.add(b.id);
    const appId = typeof b.appId === 'string' ? b.appId.trim() : '';
    if (appId && apps.has(appId)) throw Object.assign(new Error('同一个 AppID 只能配置一次。'),{code:'BOT_APP_DUPLICATE'});
    if (appId) apps.add(appId);
    const paused = b.paused === true || (b.paused !== false && b.enabled === false && !!appId && !!b.targetId);
    return {id:b.id,name:typeof b.name==='string'&&b.name.trim()?b.name.trim().slice(0,60):'机器人 '+(index+1),appId,enabled:b.enabled===true&&!paused,paused,sandbox:b.sandbox===true,groupMode:'all',groups:raw.schema===3?groupsFrom(b.groups):[]};
  });
  const config={schema:3,bots};
  if (new TextEncoder().encode(JSON.stringify(config)).length > 64000) invalid('群配置超过存储上限，请减少配置后保存；原配置未覆盖。');
  return config;
}
