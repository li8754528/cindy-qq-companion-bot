export const BOT_IDS = ["bot1", "bot2", "bot3", "bot4"];
export const secretKey = id => id === "bot1" ? "qq_app_secret" : "qq_app_secret_" + id.slice(3);
export const connectMethod = id => id === "bot1" ? "qq/connect" : "qq/connect/" + id.slice(3);
export function fleetConfig(raw = {}) {
  const input = Array.isArray(raw.bots) ? raw.bots : [{ ...raw, id: "bot1", name: "机器人 1" }];
  if (input.length > 4) throw Object.assign(new Error("最多配置 4 个机器人。"), { code: "BOT_LIMIT" });
  const ids = new Set(), apps = new Set();
  const bots = input.map((b, index) => {
    if (!b || typeof b !== "object" || !BOT_IDS.includes(b.id) || ids.has(b.id)) throw Object.assign(new Error("机器人配置编号无效或重复。"), { code: "BOT_CONFIG_INVALID" });
    ids.add(b.id);
    const appId = typeof b.appId === "string" ? b.appId.trim() : "";
    if (appId && apps.has(appId)) throw Object.assign(new Error("同一个 AppID 只能配置一次。"), { code: "BOT_APP_DUPLICATE" });
    if (appId) apps.add(appId);
    const targetId = typeof b.targetId === "string" ? b.targetId : "";
    const paused = b.paused === true || (b.paused !== false && b.enabled === false && !!appId && !!targetId);
    return { id: b.id, name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : "机器人 " + (index + 1), appId, targetId, enabled: b.enabled === true && !paused, paused, sandbox: b.sandbox === true, groupMode: "all" };
  });
  return { schema: 2, bots };
}
