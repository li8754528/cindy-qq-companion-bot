import { BridgeController, fault, PLUGIN_VERSION } from "./controller.mjs";
import { BOT_IDS, fleetConfig, connectMethod } from "./config.mjs";
export class BridgeFleet {
  constructor(host) { this.host = host; this.controllers = new Map(); this.config = fleetConfig(); this.desired = this.config; this.configuring = Promise.resolve(); this.recovery = new Map(); this.repairing = false; this.lastRecovery = new Map(); }
  async init() {
    for (const id of BOT_IDS) {
      const h = this.host.forBot(id);
      const node = h.node;
      const bridge = new BridgeController({ ...h, botId: id, node: (method, params) => node(method === "qq/connect" ? connectMethod(id) : method, { ...params, botId: id }), changed: () => this.changed() });
      this.controllers.set(id, bridge); await bridge.init();
    }
  }
  snapshot() { return { version: PLUGIN_VERSION, config: this.config, bots: this.config.bots.map(b => ({ ...(this.controllers.get(b.id)?.snapshot() || { connection: "needs_config", connectionCode: "BOOT_PENDING", jobs: [] }), id: b.id, name: b.name, nextReconnectAt: this.recovery.get(b.id)?.due || null, lastAutoRecoveryAt: this.lastRecovery.get(b.id) || null })), hostImageAttachments: undefined }; }
  changed() { this.host.changed?.(this.snapshot()); }
  configure(raw, reconnectId) {
    // Settings writes are serialized; invalid duplicate identities never partly reconnect.
    const cfg = fleetConfig(raw);
    this.desired = cfg;
    const run = this.configuring.then(async () => {
      const old = this.config; this.config = cfg;
      for (const id of BOT_IDS) {
        const next = cfg.bots.find(b => b.id === id), before = old.bots.find(b => b.id === id);
        if (JSON.stringify(next) !== JSON.stringify(before) || reconnectId === id || !this.controllers.get(id).configured) {
          await this.controllers.get(id).configure(next || { enabled: false, groupMode: "all" }, reconnectId === id);
          this.controllers.get(id).configured = true;
        }
        if (!next?.enabled) this.recovery.delete(id);
        else this.schedule(id);
      }
      this.changed(); return this.snapshot();
    });
    this.configuring = run.catch(() => {}); return run;
  }
  async receive(message) { const b = this.controllers.get(message.botId || "bot1"); if (b) await b.receive(message); }
  async status(params) { const id = params.botId || "bot1", b = this.controllers.get(id); if (!b) return; await b.status(params.state, params.code, params.epoch); if (b.connection === "connected") { if (this.recovery.has(id)) this.lastRecovery.set(id, b.now()); this.recovery.delete(id); } else this.schedule(id); }
  async stopped() { for (const [id,b] of this.controllers) { await b.status("error", "NODE_STOPPED"); this.schedule(id, true); } this.changed(); }
  repairAllowed(id) {
    const b = this.controllers.get(id), desired = this.desired.bots.find(x => x.id === id);
    return b?.cfg.enabled && desired?.enabled && desired.appId === b.cfg.appId && !!desired.sandbox === b.cfg.sandbox;
  }
  schedule(id, immediately = false) {
    const b = this.controllers.get(id);
    if (!this.repairAllowed(id) || b.connection !== "error" || !["NODE_STOPPED", "QQ_CONNECTION_FAILED", "NODE_REQUEST_FAILED", "CONNECT_FAILED"].includes(b.connectionCode)) return;
    if (!this.recovery.has(id)) this.recovery.set(id, { due: b.now() + (immediately ? 0 : 5000), attempts: 0 });
  }
  async recover() {
    if (this.repairing) return; this.repairing = true;
    const run = this.configuring.then(async () => {
      for (const [id,b] of this.controllers) {
        this.schedule(id); const retry = this.recovery.get(id);
        if (!retry || b.now() < retry.due) continue;
        if (!this.repairAllowed(id) || b.connection === "needs_config") { this.recovery.delete(id); continue; }
        if (b.connection === "connected") { this.recovery.delete(id); continue; }
        const generation = b.runtimeGeneration;
        try {
          // An update can deliver an old worker's stop event late. Probe the current
          // worker before reconnecting so a healthy SDK session is not torn down.
          const health = await b.host.node("qq/status", { health: true });
          if (!this.repairAllowed(id) || generation !== b.runtimeGeneration) continue;
          if (health.appId === b.cfg.appId && health.epoch === b.connectionEpoch && ["connected", "connecting"].includes(health.state)) {
            await b.status(health.state, health.state === "connecting" ? "QQ_RECONNECTING" : "", health.epoch);
            if (health.state === "connected") { this.recovery.delete(id); this.lastRecovery.set(id, b.now()); }
            else retry.due = b.now() + 15000;
            continue;
          }
          // Restore the connection only. Never replay target sends or QQ replies.
          await b.configure(b.cfg, true);
          if (b.connection === "needs_config") { this.recovery.delete(id); continue; }
        } catch (error) { await b.status(["PERMISSION_DENIED", "QQ_SECRET_REQUIRED"].includes(error.code) ? "needs_config" : "error", error.code || "NODE_REQUEST_FAILED"); if (b.connection === "needs_config") { this.recovery.delete(id); continue; } }
        retry.attempts++; retry.due = b.now() + Math.min(60000, 5000 * 2 ** Math.min(retry.attempts, 4));
      }
      this.changed();
    });
    this.configuring = run.catch(() => {});
    try { await run; } finally { this.repairing = false; }
  }
  async tick() { await this.recover(); for (const b of this.controllers.values()) await b.tick(); }
  async clearHistory(id) { const b = this.controllers.get(id); if (!b) throw fault("BOT_CONFIG_INVALID", "机器人编号无效。"); b.histories = []; await b.save(); this.changed(); return this.snapshot(); }
  async clearBot(id) {
    const run = this.configuring.then(async () => {
      const b = this.controllers.get(id);
      if (!b || this.config.bots.some(bot => bot.id === id)) throw fault("BOT_STILL_CONFIGURED", "请先移除机器人配置，再清理记录。");
      if (b.cfg.enabled || b.connection !== "idle") throw fault("BOT_BUSY", "此机器人尚未完全停止，请稍后重试清理。");
      // Disabling has already invalidated the runtime generation. Late receipts
      // may finish, but cannot restore removed jobs or dispatch a new message.
      b.runtimeGeneration++;
      b.histories = []; b.groups = []; await b.save();
      this.recovery.delete(id); this.lastRecovery.delete(id); this.changed(); return this.snapshot();
    });
    this.configuring = run.catch(() => {}); return run;
  }
  owner(requestId) { const b = [...this.controllers.values()].find(b => b.jobs.some(j => j.id === requestId)); if (!b) throw fault("QUESTION_FORBIDDEN", "未找到当前请求。"); return b; }
  question(id, session) { return this.owner(id).question(id, session); }
  reply(id, text, session) { return this.owner(id).reply(id, text, session); }
}
