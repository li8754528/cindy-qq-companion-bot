(() => {
  // src/config.mjs
  var BOT_IDS = ["bot1", "bot2", "bot3", "bot4"];
  var secretKey = (id) => id === "bot1" ? "qq_app_secret" : "qq_app_secret_" + id.slice(3);
  var connectMethod = (id) => id === "bot1" ? "qq/connect" : "qq/connect/" + id.slice(3);
  var invalid = (message) => {
    throw Object.assign(new Error(message), { code: "BOT_CONFIG_INVALID" });
  };
  function routeFrom(value) {
    if (value == null) return null;
    if (!["cc", "codex", "pi"].includes(value.agentKind) || typeof value.providerId !== "string" || !value.providerId || value.providerId.length > 128 || typeof value.model !== "string" || !value.model || value.model.length > 256 || typeof value.effort !== "string" || value.effort.length > 32 || ![true, false, "ultrafast"].includes(value.fastMode) || value.agentDeviceId) invalid("\u8BF7\u9009\u62E9\u672C\u673A\u53EF\u7528\u7684\u5B8C\u6574\u6A21\u578B\u4E0E\u63A8\u7406\u5F3A\u5EA6\u3002");
    return Object.fromEntries(["agentKind", "providerId", "model", "effort", "fastMode"].map((k) => [k, value[k]]));
  }
  function groupsFrom(raw) {
    const groups = Array.isArray(raw) ? raw : [];
    if (groups.length > 40) invalid("\u6BCF\u4E2A\u673A\u5668\u4EBA\u6700\u591A\u914D\u7F6E 40 \u4E2A\u7FA4\u3002");
    const seen = /* @__PURE__ */ new Set();
    return groups.map((g) => {
      if (!g || typeof g.groupOpenid !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(g.groupOpenid) || seen.has(g.groupOpenid)) invalid("\u7FA4\u6807\u8BC6\u65E0\u6548\u6216\u91CD\u590D\u3002");
      seen.add(g.groupOpenid);
      const projectId = g.projectId || "";
      if (typeof projectId !== "string" || projectId.length > 4096 || projectId.includes("\0")) invalid("\u9879\u76EE\u6807\u8BC6\u65E0\u6548\u3002");
      return { groupOpenid: g.groupOpenid, label: typeof g.label === "string" ? g.label.slice(0, 60) : "", projectId, route: routeFrom(g.route) };
    });
  }
  function fleetConfig(raw = {}) {
    if (raw.schema !== void 0 && ![1, 2, 3].includes(raw.schema)) throw Object.assign(new Error("\u7FA4\u914D\u7F6E\u6765\u81EA\u4E0D\u517C\u5BB9\u7248\u672C\uFF0C\u5DF2\u4FDD\u7559\u539F\u914D\u7F6E\uFF0C\u672A\u964D\u7EA7\u8986\u76D6\u3002"), { code: "CONFIG_UNSUPPORTED" });
    const input = Array.isArray(raw.bots) ? raw.bots : [{ ...raw, id: "bot1", name: "\u673A\u5668\u4EBA 1" }];
    if (input.length > 4) throw Object.assign(new Error("\u6700\u591A\u914D\u7F6E 4 \u4E2A\u673A\u5668\u4EBA\u3002"), { code: "BOT_LIMIT" });
    const ids = /* @__PURE__ */ new Set(), apps = /* @__PURE__ */ new Set();
    const bots = input.map((b, index) => {
      if (!b || !BOT_IDS.includes(b.id) || ids.has(b.id)) invalid("\u673A\u5668\u4EBA\u7F16\u53F7\u65E0\u6548\u6216\u91CD\u590D\u3002");
      ids.add(b.id);
      const appId = typeof b.appId === "string" ? b.appId.trim() : "";
      if (appId && apps.has(appId)) throw Object.assign(new Error("\u540C\u4E00\u4E2A AppID \u53EA\u80FD\u914D\u7F6E\u4E00\u6B21\u3002"), { code: "BOT_APP_DUPLICATE" });
      if (appId) apps.add(appId);
      const paused = b.paused === true || b.paused !== false && b.enabled === false && !!appId && !!b.targetId;
      return { id: b.id, name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : "\u673A\u5668\u4EBA " + (index + 1), appId, enabled: b.enabled === true && !paused, paused, sandbox: b.sandbox === true, groupMode: "all", groups: raw.schema === 3 ? groupsFrom(b.groups) : [] };
    });
    const config = { schema: 3, bots };
    if (new TextEncoder().encode(JSON.stringify(config)).length > 64e3) invalid("\u7FA4\u914D\u7F6E\u8D85\u8FC7\u5B58\u50A8\u4E0A\u9650\uFF0C\u8BF7\u51CF\u5C11\u914D\u7F6E\u540E\u4FDD\u5B58\uFF1B\u539F\u914D\u7F6E\u672A\u8986\u76D6\u3002");
    return config;
  }

  // src/controller.mjs
  var PLUGIN_VERSION = "1.6.4";
  var TALK_IDLE_MS = 2 * 60 * 60 * 1e3;
  var DONE = /* @__PURE__ */ new Set(["replied", "failed", "cancelled", "expired", "no_reply", "uncertain"]);
  var SEND_STATES = /* @__PURE__ */ new Set(["replying", "proactive_sending"]);
  var STATES = /* @__PURE__ */ new Set([...DONE, "queued", "sending", "waiting", "replying", "reply_rejected", "proactive_sending"]);
  var identifier = (x) => typeof x === "string" && x.length > 0 && x.length <= 256;
  function validateCurrentState(d) {
    if (!Array.isArray(d.histories) || d.histories.length > 80 || new Set(d.jobs.map((j) => j?.id)).size !== d.jobs.length) throw fault("STATE_INVALID", "\u4F1A\u8BDD\u6216\u8BF7\u6C42\u8EAB\u4EFD\u635F\u574F\u3002");
    for (const j of d.jobs) {
      if (!j || !identifier(j.id) || !STATES.has(j.state) || !Number.isSafeInteger(j.createdAt) || j.createdAt < 0 || j.taskId !== void 0 && !identifier(j.taskId) || j.finalFingerprint !== void 0 && !/^[a-f0-9]{64}$/.test(j.finalFingerprint) || j.finalText !== void 0 && (typeof j.finalText !== "string" || !j.finalText.trim() || j.finalText.length > 1800)) throw fault("STATE_INVALID", "\u53D1\u9001\u72B6\u6001\u635F\u574F\uFF0C\u672A\u8986\u76D6\u6216\u91CD\u653E\u3002");
      if (!j.legacy && (!identifier(j.appId) || !identifier(j.groupId) || !identifier(j.senderId) || !identifier(j.messageId) || typeof j.finalEligible !== "boolean" || j.finalEligible && (!identifier(j.taskId) || !identifier(j.talkId)))) throw fault("STATE_INVALID", "\u539F\u8BF7\u6C42\u7ED1\u5B9A\u635F\u574F\u3002");
      if (SEND_STATES.has(j.state) && (!j.finalFingerprint || !j.finalText)) throw fault("STATE_INVALID", "\u53D1\u9001\u610F\u56FE\u4E0D\u5B8C\u6574\uFF0C\u672A\u91CD\u653E\u3002");
    }
    for (const h of d.histories) if (!identifier(h.id) || typeof h.key !== "string" || h.key.length > 16e3 || !Number.isSafeInteger(h.updatedAt) || h.updatedAt < 0 || h.taskId !== void 0 && !identifier(h.taskId)) throw fault("STATE_INVALID", "\u6210\u5458\u4F1A\u8BDD\u6620\u5C04\u635F\u574F\u3002");
  }
  function fault(code, message) {
    return Object.assign(new Error(message), { code });
  }
  function configFrom(raw = {}) {
    return { appId: typeof raw.appId === "string" ? raw.appId.trim() : "", enabled: raw.enabled === true, sandbox: raw.sandbox === true, groupMode: "all", groups: groupsFrom(raw.groups) };
  }
  async function digest(value) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  var BridgeController = class {
    constructor(host) {
      this.host = host;
      this.cfg = configFrom();
      this.jobs = [];
      this.groups = [];
      this.histories = [];
      this.connection = "idle";
      this.connectionCode = "";
      this.writeChain = Promise.resolve();
      this.receiving = Promise.resolve();
      this.pumping = false;
      this.targetFlight = null;
      this.runtimeGeneration = 0;
      this.connectionEpoch = null;
    }
    now() {
      return this.host.now?.() ?? Date.now();
    }
    snapshot() {
      return { version: PLUGIN_VERSION, connection: this.connection, connectionCode: this.connectionCode, config: this.cfg, groups: this.groups, conversationCount: this.histories.filter((h) => this.now() - h.updatedAt < TALK_IDLE_MS).length, jobs: this.jobs.filter((j) => j.finalEligible || j.state === "queued").concat(this.jobs.filter((j) => !j.finalEligible && j.state !== "queued").slice(-24)).reverse().map(({ id, groupId, senderId, imageCount, state, createdAt, code, slotReleased, finalEligible, taskId, runId, delivery }) => ({ id, groupId, senderId, imageCount, state, createdAt, code, slotReleased, finalEligible, taskId, runId, delivery, mode: "member" })) };
    }
    changed() {
      this.host.changed?.(this.snapshot());
    }
    save() {
      const jobs = this.jobs.map(({ text, preview, questionContent, ...j }) => j);
      const data = JSON.parse(JSON.stringify({ schema: 5, jobs, groups: this.groups, histories: this.histories }));
      const run = this.writeChain.then(() => this.host.write(data));
      this.writeChain = run.catch(() => {
      });
      return run;
    }
    async init() {
      const d = await this.host.read();
      if (!d) {
        this.changed();
        return;
      }
      if (![1, 2, 3, 5].includes(d.schema) || !Array.isArray(d.jobs) || !Array.isArray(d.groups) || d.jobs.length > 200) throw fault("STATE_UNSUPPORTED", "\u63D2\u4EF6\u6570\u636E\u4E0D\u517C\u5BB9\uFF0C\u672A\u8986\u76D6\u6216\u91CD\u653E\u3002");
      this.jobs = d.jobs;
      this.groups = d.groups.slice(-40);
      if (d.schema === 5) {
        validateCurrentState(d);
        this.histories = d.histories;
        for (const j of this.jobs) {
          if (SEND_STATES.has(j.state)) {
            j.state = "uncertain";
            j.code = "QQ_SEND_UNCERTAIN";
            j.finalEligible = false;
            delete j.finalText;
          } else if (j.state === "sending") {
            j.state = "uncertain";
            j.code = "DELIVERY_UNCERTAIN";
            j.finalEligible = false;
            j.nativeSubmissionUnknown = true;
            j.blockMember = true;
          } else if (j.state === "reply_rejected") {
            j.state = "failed";
            j.code = "HOST_RESTARTED_BEFORE_FALLBACK";
            j.finalEligible = false;
            delete j.finalText;
          } else if (j.state === "queued") {
            j.state = "cancelled";
            j.code = "HOST_RESTARTED";
            j.finalEligible = false;
          } else if (j.state === "waiting") {
            j.slotReleased = true;
            j.blockMember = false;
            j.code = "HOST_RESTARTED_WAITING";
          }
        }
      } else {
        this.histories = [];
        for (const j of this.jobs) {
          j.legacy = true;
          j.finalEligible = false;
          if (!DONE.has(j.state)) {
            j.state = "uncertain";
            j.code = "MIGRATED_LEGACY_REQUEST";
          }
          delete j.text;
          delete j.questionContent;
          delete j.preview;
          delete j.finalText;
        }
      }
      await this.save();
      this.changed();
    }
    allows() {
      return true;
    }
    matches(j) {
      return this.cfg.enabled && j.appId === this.cfg.appId && !!j.sandbox === this.cfg.sandbox;
    }
    groupConfig(id) {
      return this.cfg.groups.find((g) => g.groupOpenid === id);
    }
    conversationKey(j) {
      return JSON.stringify([this.host.botId || "bot1", j.appId, !!j.sandbox, j.groupId, j.senderId, j.configKey]);
    }
    bindTalk(j) {
      const key = this.conversationKey(j);
      let h = this.histories.findLast((h2) => h2.key === key && this.now() - h2.updatedAt < TALK_IDLE_MS && !this.jobs.some((x) => x.talkId === h2.id && x.nativeSubmissionUnknown));
      if (!h) {
        this.histories = this.histories.filter((h2) => this.now() - h2.updatedAt < TALK_IDLE_MS || this.jobs.some((j2) => j2.talkId === h2.id && j2.finalEligible));
        if (this.histories.length >= 80) throw fault("SESSION_LIMIT", "\u8FDE\u7EED\u4F1A\u8BDD\u5DF2\u6EE1\uFF0C\u672A\u521B\u5EFA\u4EFB\u52A1\uFF1B\u8BF7\u7ED3\u675F\u95F2\u7F6E\u4F1A\u8BDD\u3002");
        h = { id: crypto.randomUUID(), key, groupId: j.groupId, senderId: j.senderId, updatedAt: this.now(), accepted: false };
        this.histories.push(h);
      }
      j.talkId = h.id;
      return h;
    }
    talkFor(j) {
      return this.histories.find((h) => h.id === j.talkId);
    }
    async configure(raw, reconnect = false) {
      const old = this.cfg;
      this.cfg = configFrom(raw);
      const generation = ++this.runtimeGeneration;
      for (const j of this.jobs) if (!this.matches(j) && !DONE.has(j.state)) {
        j.state = "cancelled";
        j.code = "CONFIG_CHANGED";
        j.finalEligible = false;
        delete j.finalText;
        delete j.text;
      }
      await this.save();
      if (generation !== this.runtimeGeneration) return this.snapshot();
      if (!this.cfg.enabled || !/^[0-9]{4,30}$/.test(this.cfg.appId)) {
        try {
          if (old.enabled || this.connectionEpoch) await this.host.node("qq/disconnect", {});
          this.connectionEpoch = null;
          this.connection = this.cfg.enabled ? "needs_config" : "idle";
          this.connectionCode = this.cfg.enabled ? "CONFIG_REQUIRED" : "";
        } catch (e) {
          this.connection = "error";
          this.connectionCode = e.code || "NODE_REQUEST_FAILED";
        }
      } else if (reconnect || !old.enabled || old.appId !== this.cfg.appId || old.sandbox !== this.cfg.sandbox || this.connection !== "connected") {
        this.connection = "connecting";
        this.connectionCode = "";
        this.changed();
        try {
          await this.host.defaultSupport?.();
          if (generation !== this.runtimeGeneration) return this.snapshot();
          this.connectionEpoch = this.now() + ":" + generation;
          await this.host.node("qq/connect", { appId: this.cfg.appId, sandbox: this.cfg.sandbox, epoch: this.connectionEpoch });
        } catch (e) {
          if (generation === this.runtimeGeneration) {
            this.connection = ["QQ_SECRET_REQUIRED", "PERMISSION_DENIED", "HOST_UNSUPPORTED"].includes(e.code) ? "needs_config" : "error";
            this.connectionCode = e.code || "CONNECT_FAILED";
          }
        }
      }
      this.changed();
      await this.pump();
      return this.snapshot();
    }
    receive(m) {
      const run = this.receiving.then(() => this.accept(m));
      this.receiving = run.catch(() => {
      });
      return run;
    }
    async accept(m) {
      if (!this.cfg.enabled || m.appId !== this.cfg.appId || m.kind !== "group" || m.rawEventType !== "GROUP_AT_MESSAGE_CREATE" || m.senderIsBot) return;
      if (![m.messageId, m.groupId, m.senderId].every((x) => typeof x === "string" && x.length > 0 && x.length <= 160)) return;
      const messageAt = Date.parse(m.timestamp);
      if (!Number.isFinite(messageAt) || messageAt < this.now() - 864e5 || messageAt > this.now() + 6e4) {
        this.connectionCode = "EVENT_TIME_INVALID";
        this.changed();
        return;
      }
      this.jobs = this.jobs.filter((j2) => j2.finalEligible || j2.state === "uncertain" || !DONE.has(j2.state) || j2.createdAt >= this.now() - 864e5);
      const id = "qq:" + await digest([this.host.botId || "bot1", m.appId, this.cfg.sandbox, m.groupId, m.messageId]);
      if (this.jobs.some((j2) => j2.id === id) || this.jobs.some((j2) => j2.legacy && j2.appId === m.appId && j2.messageId === m.messageId)) return;
      if (!this.groups.some((g) => g.id === m.groupId)) this.groups.push({ id: m.groupId, firstSeenAt: this.now() });
      this.groups = this.groups.slice(-40);
      if (this.jobs.length >= 200) {
        this.connectionCode = "INBOX_FULL";
        this.changed();
        await this.save();
        return;
      }
      const cfg = this.groupConfig(m.groupId), text = typeof m.text === "string" ? m.text.trim() : "";
      const imageCount = Number.isInteger(m.imageCount) && m.imageCount > 0 && m.imageCount <= 4 ? m.imageCount : 0;
      const j = { id, appId: m.appId, sandbox: this.cfg.sandbox, groupId: m.groupId, messageId: m.messageId, senderId: m.senderId, msgIdx: typeof m.msgIdx === "string" && m.msgIdx.trim() && m.msgIdx.length <= 256 ? m.msgIdx : void 0, createdAt: messageAt, imageCount, text, state: "queued", finalEligible: false, ...cfg ? { projectId: cfg.projectId, route: cfg.route, configKey: JSON.stringify([cfg.projectId, cfg.route]) } : {} };
      if (!cfg?.projectId || !cfg.route) {
        j.state = "failed";
        j.code = "GROUP_CONFIG_REQUIRED";
      } else if (!text && !imageCount || text.length > 12e3 || m.hasAttachments && (!imageCount || m.attachmentCode)) {
        j.state = "failed";
        j.code = m.attachmentCode || "QUESTION_CONTENT_INVALID";
      } else if (this.jobs.filter((j2) => ["queued", "sending"].includes(j2.state)).length >= 12) {
        j.state = "failed";
        j.code = "QUEUE_FULL";
      }
      if (j.state === "queued") try {
        this.bindTalk(j);
      } catch (e) {
        j.state = "failed";
        j.code = e.code;
      }
      this.jobs.push(j);
      await this.save();
      this.changed();
      await this.pump();
    }
    prompt(j) {
      return JSON.stringify({ request_id: j.id, question: j.text });
    }
    async pump() {
      if (this.pumping || !this.cfg.enabled || this.connection !== "connected") return;
      const j = this.jobs.find((j2) => j2.state === "queued");
      if (!j) return;
      this.pumping = true;
      const guard = () => {
        if (!this.jobs.includes(j) || !this.matches(j) || j.state === "cancelled") throw fault("CONFIG_CHANGED", "\u539F\u673A\u5668\u4EBA\u914D\u7F6E\u5DF2\u6539\u53D8\uFF0C\u672A\u53D1\u9001\u3002");
      };
      try {
        const current = this.groupConfig(j.groupId);
        if (JSON.stringify([current?.projectId, current?.route]) !== j.configKey) throw fault("GROUP_CONFIG_CHANGED", "\u7FA4\u9879\u76EE\u6216\u6A21\u578B\u914D\u7F6E\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0 @\u3002");
        await this.host.resolve(j.projectId);
        guard();
        let attachments;
        if (j.imageCount) {
          if (!await this.host.imageSupport?.()) throw fault("IMAGE_HOST_UNSUPPORTED", "\u5BBF\u4E3B\u6CA1\u6709\u56FE\u7247\u6295\u9012\u80FD\u529B\u3002");
          attachments = await this.host.images(j, this.connectionEpoch);
          guard();
          if (attachments?.length !== j.imageCount) throw fault("IMAGE_TRANSFER_INVALID", "\u56FE\u7247\u672A\u5B8C\u6574\u83B7\u53D6\u3002");
        }
        const h = this.jobs.some((x) => x !== j && x.talkId === j.talkId && x.nativeSubmissionUnknown) ? this.bindTalk(j) : this.talkFor(j);
        if (!h) throw fault("SESSION_UNAVAILABLE", "\u4F1A\u8BDD\u5DF2\u7ED3\u675F\u3002");
        j.state = "sending";
        j.sendKey = j.id;
        await this.save();
        guard();
        this.targetFlight = this.host.send({ taskId: h.taskId, projectId: j.projectId, route: j.route, requestKey: j.sendKey, text: this.prompt(j), ...attachments ? { attachments } : {} }, guard);
        const receipt = await this.targetFlight;
        guard();
        if (receipt.accepted !== true || typeof receipt.taskId !== "string" || !receipt.taskId) throw fault("DELIVERY_UNCERTAIN", "\u95EE\u9898\u53D7\u7406\u7ED3\u679C\u4E0D\u786E\u5B9A\uFF0C\u672A\u91CD\u53D1\u3002");
        h.taskId = receipt.taskId;
        h.updatedAt = this.now();
        h.accepted = true;
        j.taskId = receipt.taskId;
        if (receipt.runId) j.runId = receipt.runId;
        j.state = "waiting";
        j.finalEligible = true;
        j.slotReleased = true;
        j.blockMember = false;
        delete j.text;
        await this.save();
      } catch (e) {
        if (j.state !== "cancelled") {
          j.nativeSubmissionUnknown = j.state === "sending" && !e.beforeSend;
          j.state = j.nativeSubmissionUnknown ? "uncertain" : "failed";
          j.blockMember = !!j.nativeSubmissionUnknown;
          j.code = e.code || "DELIVERY_UNCERTAIN";
          j.finalEligible = false;
          delete j.text;
          await this.save();
        }
      } finally {
        this.targetFlight = null;
        this.pumping = false;
        this.changed();
      }
      await this.pump();
    }
    async forCaller(id, session) {
      if (this.targetFlight) await this.targetFlight.catch(() => {
      });
      const j = this.jobs.find((j2) => j2.id === id);
      if (!j || j.legacy || !session || j.taskId !== session) throw fault("QUESTION_FORBIDDEN", "\u4EC5\u63A5\u6536\u539F\u95EE\u9898\u7684\u4EFB\u52A1\u53EF\u5904\u7406\u672C\u8BF7\u6C42\u3002");
      return j;
    }
    async question(id, session) {
      const j = await this.forCaller(id, session);
      return { request_id: j.id, group_id: j.groupId, sender_id: j.senderId, state: j.state, code: j.code, image_count: j.imageCount };
    }
    async reply(id, text, session) {
      const j = await this.forCaller(id, session);
      if (typeof text !== "string" || !text.trim() || text.length > 1800) throw fault("REPLY_TOO_LONG", "\u8BF7\u5C06\u6700\u7EC8\u7B54\u6848\u7F29\u77ED\u52301800\u5B57\u7B26\u4EE5\u5185\u3002");
      const final = text.trim(), fingerprint = await digest(final);
      if (j.finalFingerprint && j.finalFingerprint !== fingerprint) throw fault("FINAL_CONFLICT", "\u540C\u4E00\u8BF7\u6C42\u5DF2\u6709\u53E6\u4E00\u4EFD\u6700\u7EC8\u7B54\u6848\uFF0C\u672A\u53D1\u9001\u3002");
      if (j.state === "replied") return { sent: true, duplicate: true, request_id: id, message_id: j.replyId, delivery: j.delivery };
      if (!j.finalEligible || j.state !== "waiting") throw fault("QUESTION_NOT_WAITING", "\u6B64\u8BF7\u6C42\u4E0D\u80FD\u91CD\u590D\u53D1\u9001\uFF0C\u8BF7\u67E5\u770B\u539F\u72B6\u6001\u3002");
      if (!this.matches(j)) throw fault("CONFIG_CHANGED", "\u539F\u673A\u5668\u4EBA\u5DF2\u6682\u505C\u6216\u66F4\u6362\uFF0C\u672A\u53D1\u9001\u3002");
      j.state = "replying";
      j.finalFingerprint = fingerprint;
      j.finalText = final;
      try {
        await this.save();
        return await this.deliver(j, "reply");
      } catch (e) {
        if (!["replied", "failed", "uncertain", "cancelled"].includes(j.state)) {
          j.state = "uncertain";
          j.code = e.code || "STATE_WRITE_FAILED";
          j.finalEligible = false;
        }
        throw e;
      } finally {
        this.changed();
        await this.pump();
      }
    }
    async deliver(j, stage) {
      const guard = () => {
        if (!this.matches(j) || !this.jobs.includes(j)) throw fault("CONFIG_CHANGED", "\u539F\u673A\u5668\u4EBA\u5DF2\u6539\u53D8\uFF0C\u672A\u53D1\u9001\u3002");
      };
      let result;
      try {
        guard();
        result = await this.host.node(stage === "reply" ? "qq/reply" : "qq/final-active", { appId: j.appId, sandbox: j.sandbox, epoch: this.connectionEpoch, requestId: j.id, groupId: j.groupId, messageId: j.messageId, msgIdx: j.msgIdx, text: j.finalText });
      } catch (e) {
        j.state = ["CONFIG_CHANGED", "QQ_NOT_CONNECTED", "INVALID_REPLY", "FINAL_STATE_REQUIRED", "FINAL_INBOX_FULL", "PERMISSION_DENIED"].includes(e.code) ? "failed" : "uncertain";
        j.code = e.code || "QQ_SEND_UNCERTAIN";
        j.finalEligible = false;
        delete j.finalText;
        await this.save();
        throw fault(j.code, "\u6700\u7EC8\u53D1\u9001\u672A\u786E\u8BA4\uFF0C\u8BF7\u67E5\u770B\u63D2\u4EF6\u72B6\u6001\u4E0E\u539F\u7FA4\uFF1B\u4E0D\u4F1A\u91CD\u53D1\u3002");
      }
      if (result?.sent === true && typeof result.messageId === "string" && result.messageId.trim() && result.messageId.length <= 512) {
        j.state = "replied";
        j.delivery = stage === "reply" ? "passive" : "proactive";
        j.replyId = result.messageId;
        j.sentAt = this.now();
        j.finalEligible = false;
        delete j.finalText;
        delete j.code;
        delete j.blockMember;
        const h = this.talkFor(j);
        if (h) h.updatedAt = this.now();
        await this.save();
        return { sent: true, request_id: j.id, message_id: j.replyId, delivery: j.delivery };
      }
      if (stage === "reply" && result?.outcome === "rejected") {
        j.state = "reply_rejected";
        j.replyFailure = result.code;
        await this.save();
        guard();
        j.state = "proactive_sending";
        await this.save();
        guard();
        return this.deliver(j, "active");
      }
      j.state = result?.outcome === "rejected" ? "failed" : "uncertain";
      j.code = result?.code || "QQ_SEND_UNCERTAIN";
      j.finalEligible = false;
      delete j.finalText;
      await this.save();
      throw fault(j.code, j.state === "failed" ? "\u6700\u7EC8\u7B54\u6848\u53D1\u9001\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u3002" : "\u6700\u7EC8\u7B54\u6848\u53D1\u9001\u7ED3\u679C\u4E0D\u786E\u5B9A\uFF0C\u672A\u8865\u53D1\u3002");
    }
    async releaseWaiting(id) {
      const j = this.jobs.find((j2) => j2.id === id);
      if (!j || j.state !== "waiting") throw fault("QUESTION_NOT_WAITING", "\u53EA\u6709\u7B49\u5F85\u6700\u7EC8\u7B54\u6848\u7684\u8BF7\u6C42\u53EF\u4EE5\u91CA\u653E\u6392\u961F\u4F4D\u7F6E\u3002");
      j.slotReleased = true;
      j.blockMember = false;
      j.code = "WAITING_FINAL_RELEASED";
      await this.save();
      this.changed();
      await this.pump();
      return this.snapshot();
    }
    async status(state, code = "", epoch) {
      if (epoch !== void 0 && epoch !== this.connectionEpoch) return;
      if (!this.cfg.enabled && state !== "idle") return;
      this.connection = state;
      this.connectionCode = code;
      this.changed();
      await this.pump();
    }
    async tick() {
      let dirty = false;
      for (const j of this.jobs.filter((j2) => j2.state === "waiting")) {
        if (j.runId && this.host.getRun) try {
          const run = await this.host.getRun(j.runId);
          if (j.state === "waiting" && j.finalEligible && this.jobs.includes(j) && run.runId === j.runId && run.taskId === j.taskId && ["completed", "failed", "cancelled", "interrupted"].includes(run.status) && (!j.slotReleased || j.blockMember !== false || j.code !== "MODEL_ENDED_WITHOUT_REPLY")) {
            j.slotReleased = true;
            j.blockMember = false;
            j.code = "MODEL_ENDED_WITHOUT_REPLY";
            dirty = true;
          }
        } catch {
        }
        if (this.now() - j.createdAt > 10 * 60 * 1e3 && !["WAITING_FINAL_ATTENTION", "MODEL_ENDED_WITHOUT_REPLY", "WAITING_FINAL_RELEASED"].includes(j.code)) {
          j.code = "WAITING_FINAL_ATTENTION";
          dirty = true;
        }
      }
      if (dirty) await this.save();
      this.changed();
      await this.pump();
    }
  };

  // src/fleet.mjs
  var BridgeFleet = class {
    constructor(host) {
      this.host = host;
      this.controllers = /* @__PURE__ */ new Map();
      this.config = fleetConfig();
      this.desired = this.config;
      this.configuring = Promise.resolve();
      this.recovery = /* @__PURE__ */ new Map();
      this.repairing = false;
      this.lastRecovery = /* @__PURE__ */ new Map();
    }
    async init() {
      for (const id of BOT_IDS) {
        const h = this.host.forBot(id);
        const node = h.node;
        const bridge = new BridgeController({ ...h, botId: id, node: (method, params) => node(method === "qq/connect" ? connectMethod(id) : method, { ...params, botId: id }), changed: () => this.changed() });
        this.controllers.set(id, bridge);
        await bridge.init();
      }
    }
    snapshot() {
      return { version: PLUGIN_VERSION, config: this.config, bots: this.config.bots.map((b) => ({ ...this.controllers.get(b.id)?.snapshot() || { connection: "needs_config", connectionCode: "BOOT_PENDING", jobs: [] }, id: b.id, name: b.name, nextReconnectAt: this.recovery.get(b.id)?.due || null, lastAutoRecoveryAt: this.lastRecovery.get(b.id) || null })), hostImageAttachments: void 0 };
    }
    changed() {
      this.host.changed?.(this.snapshot());
    }
    configure(raw, reconnectId) {
      const cfg = fleetConfig(raw);
      this.desired = cfg;
      const run = this.configuring.then(async () => {
        const old = this.config;
        this.config = cfg;
        for (const id of BOT_IDS) {
          const next = cfg.bots.find((b) => b.id === id), before = old.bots.find((b) => b.id === id);
          if (JSON.stringify(next) !== JSON.stringify(before) || reconnectId === id || !this.controllers.get(id).configured) {
            await this.controllers.get(id).configure(next || { enabled: false, groupMode: "all" }, reconnectId === id);
            this.controllers.get(id).configured = true;
          }
          if (!next?.enabled) this.recovery.delete(id);
          else this.schedule(id);
        }
        this.changed();
        return this.snapshot();
      });
      this.configuring = run.catch(() => {
      });
      return run;
    }
    async receive(message) {
      const b = this.controllers.get(message.botId || "bot1");
      if (b) await b.receive(message);
    }
    async status(params) {
      const id = params.botId || "bot1", b = this.controllers.get(id);
      if (!b) return;
      await b.status(params.state, params.code, params.epoch);
      if (b.connection === "connected") {
        if (this.recovery.has(id)) this.lastRecovery.set(id, b.now());
        this.recovery.delete(id);
      } else this.schedule(id);
    }
    async stopped() {
      for (const [id, b] of this.controllers) {
        await b.status("error", "NODE_STOPPED");
        this.schedule(id, true);
      }
      this.changed();
    }
    repairAllowed(id) {
      const b = this.controllers.get(id), desired = this.desired.bots.find((x) => x.id === id);
      return b?.cfg.enabled && desired?.enabled && desired.appId === b.cfg.appId && !!desired.sandbox === b.cfg.sandbox;
    }
    schedule(id, immediately = false) {
      const b = this.controllers.get(id);
      if (!this.repairAllowed(id) || b.connection !== "error" || !["NODE_STOPPED", "QQ_CONNECTION_FAILED", "NODE_REQUEST_FAILED", "CONNECT_FAILED"].includes(b.connectionCode)) return;
      if (!this.recovery.has(id)) this.recovery.set(id, { due: b.now() + (immediately ? 0 : 5e3), attempts: 0 });
    }
    async recover() {
      if (this.repairing) return;
      this.repairing = true;
      const run = this.configuring.then(async () => {
        for (const [id, b] of this.controllers) {
          this.schedule(id);
          const retry = this.recovery.get(id);
          if (!retry || b.now() < retry.due) continue;
          if (!this.repairAllowed(id) || b.connection === "needs_config") {
            this.recovery.delete(id);
            continue;
          }
          if (b.connection === "connected") {
            this.recovery.delete(id);
            continue;
          }
          const generation = b.runtimeGeneration;
          try {
            const health = await b.host.node("qq/status", { health: true });
            if (!this.repairAllowed(id) || generation !== b.runtimeGeneration) continue;
            if (health.appId === b.cfg.appId && health.epoch === b.connectionEpoch && ["connected", "connecting"].includes(health.state)) {
              await b.status(health.state, health.state === "connecting" ? "QQ_RECONNECTING" : "", health.epoch);
              if (health.state === "connected") {
                this.recovery.delete(id);
                this.lastRecovery.set(id, b.now());
              } else retry.due = b.now() + 15e3;
              continue;
            }
            await b.configure(b.cfg, true);
            if (b.connection === "needs_config") {
              this.recovery.delete(id);
              continue;
            }
          } catch (error2) {
            await b.status(["PERMISSION_DENIED", "QQ_SECRET_REQUIRED"].includes(error2.code) ? "needs_config" : "error", error2.code || "NODE_REQUEST_FAILED");
            if (b.connection === "needs_config") {
              this.recovery.delete(id);
              continue;
            }
          }
          retry.attempts++;
          retry.due = b.now() + Math.min(6e4, 5e3 * 2 ** Math.min(retry.attempts, 4));
        }
        this.changed();
      });
      this.configuring = run.catch(() => {
      });
      try {
        await run;
      } finally {
        this.repairing = false;
      }
    }
    async tick() {
      await this.recover();
      for (const b of this.controllers.values()) await b.tick();
    }
    async clearHistory(id) {
      const b = this.controllers.get(id);
      if (!b) throw fault("BOT_CONFIG_INVALID", "\u673A\u5668\u4EBA\u7F16\u53F7\u65E0\u6548\u3002");
      b.histories = [];
      await b.save();
      this.changed();
      return this.snapshot();
    }
    async clearBot(id) {
      const run = this.configuring.then(async () => {
        const b = this.controllers.get(id);
        if (!b || this.config.bots.some((bot) => bot.id === id)) throw fault("BOT_STILL_CONFIGURED", "\u8BF7\u5148\u79FB\u9664\u673A\u5668\u4EBA\u914D\u7F6E\uFF0C\u518D\u6E05\u7406\u8BB0\u5F55\u3002");
        if (b.cfg.enabled || b.connection !== "idle") throw fault("BOT_BUSY", "\u6B64\u673A\u5668\u4EBA\u5C1A\u672A\u5B8C\u5168\u505C\u6B62\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6E05\u7406\u3002");
        b.runtimeGeneration++;
        b.histories = [];
        b.groups = [];
        await b.save();
        this.recovery.delete(id);
        this.lastRecovery.delete(id);
        this.changed();
        return this.snapshot();
      });
      this.configuring = run.catch(() => {
      });
      return run;
    }
    owner(requestId) {
      const b = [...this.controllers.values()].find((b2) => b2.jobs.some((j) => j.id === requestId));
      if (!b) throw fault("QUESTION_FORBIDDEN", "\u672A\u627E\u5230\u5F53\u524D\u8BF7\u6C42\u3002");
      return b;
    }
    question(id, session) {
      return this.owner(id).question(id, session);
    }
    reply(id, text, session) {
      return this.owner(id).reply(id, text, session);
    }
  };

  // src/image-transfer.mjs
  async function collectImages(node, job, epoch) {
    const info = await node("qq/images", { appId: job.appId, requestId: job.id, groupId: job.groupId, messageId: job.messageId, epoch });
    if (typeof info?.transferId !== "string") throw fault("IMAGE_TRANSFER_INVALID", "\u56FE\u7247\u4F20\u8F93\u672A\u80FD\u5F00\u59CB\u3002");
    try {
      if (!Array.isArray(info.images) || info.images.length !== job.imageCount || info.images.length > 4 || info.images.some((i) => !Number.isSafeInteger(i.bytes) || i.bytes < 1 || i.bytes > 5 * 1024 * 1024) || info.images.reduce((n, i) => n + i.bytes, 0) > 20 * 1024 * 1024) throw fault("IMAGE_TRANSFER_INVALID", "\u56FE\u7247\u6570\u91CF\u6216\u5927\u5C0F\u65E0\u6548\u3002");
      const attachments = [];
      for (let index = 0; index < info.images.length; index++) {
        const image = info.images[index], chunks = [];
        let offset = 0;
        while (offset < image.bytes) {
          const part = await node("qq/image-chunk", { transferId: info.transferId, index, offset });
          const end = Math.min(offset + 192 * 1024, image.bytes), length = end - offset;
          if (part.offset !== offset || part.nextOffset !== end || part.done !== (end === image.bytes) || typeof part.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.base64) || part.base64.length !== Math.ceil(length / 3) * 4) throw fault("IMAGE_TRANSFER_INVALID", "\u56FE\u7247\u4F20\u8F93\u4E0D\u5B8C\u6574\u3002");
          chunks.push(part.base64);
          offset = end;
        }
        attachments.push({ base64: chunks.join(""), name: /^qq-image-[1-4]\.(png|jpg|webp)$/.test(image.name || "") ? image.name : "qq-image-" + (index + 1) });
      }
      return attachments;
    } finally {
      await node("qq/images-release", { transferId: info.transferId }).catch(() => {
      });
    }
  }

  // src/proactive.mjs
  var RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
  var MAX_RECORDS = 1e4;
  function sendErrorMessage(code) {
    if (code === "QQ_NOT_CONNECTED") return "\u6240\u9009\u673A\u5668\u4EBA\u8FDE\u63A5\u4E0D\u53EF\u7528\u6216\u5DF2\u66F4\u6362\uFF0C\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u6062\u590D\u8FDE\u63A5\u540E\u4F7F\u7528\u65B0\u7684\u8BF7\u6C42\u7F16\u53F7\u53D1\u9001\u3002";
    if (code === "PERMISSION_DENIED") return "Cindy \u672A\u6279\u51C6\u6B64\u673A\u5668\u4EBA\u7684\u8FDE\u63A5\u6743\u9650\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u6743\u9650\u540E\u4F7F\u7528\u65B0\u7684\u8BF7\u6C42\u7F16\u53F7\u53D1\u9001\u3002";
    if (code === "CONFIG_CHANGED") return "\u673A\u5668\u4EBA\u914D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u6D88\u606F\u672A\u53D1\u9001\uFF0C\u8BF7\u6838\u5BF9\u673A\u5668\u4EBA\u548C\u7FA4\u540E\u4F7F\u7528\u65B0\u7684\u8BF7\u6C42\u7F16\u53F7\u53D1\u9001\u3002";
    if (code === "PROACTIVE_STATE_WRITE_FAILED") return "\u53D1\u9001\u524D\u65E0\u6CD5\u4FDD\u5B58\u4E3B\u52A8\u6D88\u606F\u72B6\u6001\uFF0C\u6D88\u606F\u672A\u53D1\u51FA\uFF0C\u8BF7\u6062\u590D\u63D2\u4EF6\u6570\u636E\u5199\u5165\u540E\u4F7F\u7528\u65B0\u7684\u8BF7\u6C42\u7F16\u53F7\u53D1\u9001\u3002";
    if (["QQ_API_40034100", "QQ_HTTP_429"].includes(code)) return "QQ \u4E3B\u52A8\u6D88\u606F\u9891\u7387\u6216\u914D\u989D\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u8BF7\u7B49\u5F85\u914D\u989D\u6062\u590D\u540E\u4F7F\u7528\u65B0\u7684\u8BF7\u6C42\u7F16\u53F7\u53D1\u9001\u3002";
    if (["QQ_API_40034101", "QQ_API_40054003"].includes(code)) return "\u673A\u5668\u4EBA\u4E0D\u662F\u8BE5\u7FA4\u6210\u5458\uFF0C\u8BF7\u5C06\u6240\u9009\u673A\u5668\u4EBA\u52A0\u5165\u76EE\u6807\u7FA4\u3002";
    if (["QQ_API_40034105", "QQ_HTTP_401", "QQ_HTTP_403"].includes(code)) return "QQ \u62D2\u7EDD\u4E3B\u52A8\u6D88\u606F\uFF0C\u8BF7\u68C0\u67E5\u6240\u9009\u673A\u5668\u4EBA\u7684\u51ED\u8BC1\u548C\u4E3B\u52A8\u6D88\u606F\u6743\u9650\u3002";
    if (code === "QQ_API_40054002") return "\u673A\u5668\u4EBA\u88AB\u7981\u8A00\uFF0C\u8BF7\u7B49\u5F85\u89E3\u7981\u3002";
    if (/^QQ_(API_\d+|HTTP_4\d\d)$/.test(code)) return "QQ \u62D2\u7EDD\u4E3B\u52A8\u6D88\u606F\uFF08" + code + "\uFF09\uFF0C\u8BF7\u68C0\u67E5\u5185\u5BB9\u3001\u7FA4\u6210\u5458\u8D44\u683C\u548C\u673A\u5668\u4EBA\u6743\u9650\u3002";
    return "\u4E3B\u52A8\u6D88\u606F\u53D1\u9001\u7ED3\u679C\u4E0D\u786E\u5B9A\uFF0C\u8BF7\u67E5\u770B\u76EE\u6807\u7FA4\uFF1B\u4E0D\u8981\u66F4\u6362\u8BF7\u6C42\u7F16\u53F7\u91CD\u53D1\u3002";
  }
  var ProactiveSender = class {
    constructor(host) {
      this.host = host;
      this.records = [];
      this.writeChain = Promise.resolve();
      this.preparing = Promise.resolve();
    }
    now() {
      return this.host.now?.() ?? Date.now();
    }
    snapshot() {
      return this.records.filter((r) => r.createdAt > this.now() - RETENTION_MS).slice(-24).reverse().map(({ fingerprint, workerId, ...record }) => ({ ...record }));
    }
    allowsSession(sessionId) {
      return typeof sessionId === "string" && !!sessionId && !this.host.isQQSession(sessionId);
    }
    save() {
      const data = JSON.parse(JSON.stringify({ schema: 1, records: this.records }));
      const write = this.writeChain.then(() => this.host.write(data));
      this.writeChain = write.catch(() => {
      });
      return write;
    }
    async init() {
      const data = await this.host.read();
      if (!data) return;
      if (data.schema !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RECORDS || new Set(data.records.map((r) => r?.requestKey)).size !== data.records.length || data.records.some((r) => !r || typeof r.requestKey !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(r.requestKey) || typeof r.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(r.fingerprint) || typeof r.workerId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(r.workerId) || !BOT_IDS.includes(r.botId) || typeof r.appId !== "string" || !/^\d{4,30}$/.test(r.appId) || typeof r.sandbox !== "boolean" || typeof r.groupId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(r.groupId) || !Number.isFinite(r.createdAt) || !["sending", "sent", "failed", "uncertain"].includes(r.state) || r.state === "sent" && (typeof r.messageId !== "string" || !r.messageId) || r.state === "failed" && (typeof r.code !== "string" || !r.code))) throw fault("PROACTIVE_STATE_INVALID", "\u4E3B\u52A8\u6D88\u606F\u8BB0\u5F55\u635F\u574F\uFF0C\u8BF7\u4FDD\u7559\u63D2\u4EF6\u6570\u636E\u5E76\u8054\u7CFB\u4F5C\u8005\u3002");
      this.records = data.records.filter((r) => r.createdAt > this.now() - RETENTION_MS);
      for (const record of this.records) if (record.state === "sending") {
        record.state = "uncertain";
        record.code = "QQ_SEND_UNCERTAIN";
      }
      await this.save();
    }
    validate(args, sessionId) {
      if (!BOT_IDS.includes(args.bot_id) || typeof args.group_openid !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(args.group_openid) || typeof args.text !== "string" || !args.text.trim() || args.text.length > 1800 || typeof args.request_key !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(args.request_key)) throw fault("INVALID_GROUP_MESSAGE", "\u8BF7\u6307\u5B9A\u673A\u5668\u4EBA\u3001\u6709\u6548\u7684 group_openid\u30011\u20131800 \u5B57\u7B26\u7684\u6587\u5B57\u548C 1\u201380 \u4F4D\u8BF7\u6C42\u7F16\u53F7\u3002");
      if (!this.allowsSession(sessionId)) throw fault("PROACTIVE_FORBIDDEN", "\u4E3B\u52A8\u6D88\u606F\u987B\u7531\u4E3B\u4EBA\u5728 Cindy \u4EFB\u52A1\u4E2D\u53D1\u8D77\uFF1B\u7FA4\u5185\u95EE\u7B54\u4EFB\u52A1\u53EA\u80FD\u4F7F\u7528 reply_to_qq \u56DE\u590D\u539F\u95EE\u9898\u3002");
    }
    receipt(record) {
      return {
        sent: true,
        bot_id: record.botId,
        app_id: record.appId,
        sandbox: record.sandbox,
        group_openid: record.groupId,
        request_key: record.requestKey,
        message_id: record.messageId,
        ...record.timestamp ? { timestamp: record.timestamp } : {}
      };
    }
    async send(args, sessionId, callId) {
      this.validate(args, sessionId);
      const prepare = this.preparing.then(async () => {
        const context2 = this.host.context(args.bot_id);
        if (!context2) throw fault("BOT_CONFIG_INVALID", "\u6240\u9009\u673A\u5668\u4EBA\u6CA1\u6709\u914D\u7F6E\u3002");
        const payload = JSON.stringify([args.bot_id, context2.appId, context2.sandbox, args.group_openid, args.text]);
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
        const fingerprint = [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
        this.records = this.records.filter((r) => r.createdAt > this.now() - RETENTION_MS);
        const old = this.records.find((r) => r.requestKey === args.request_key);
        if (old) {
          if (old.fingerprint !== fingerprint) throw fault("GROUP_MESSAGE_CONFLICT", "\u540C\u4E00\u8BF7\u6C42\u7F16\u53F7\u5DF2\u7528\u4E8E\u4E0D\u540C\u7684\u673A\u5668\u4EBA\u3001\u7FA4\u6216\u5185\u5BB9\uFF0C\u8BF7\u68C0\u67E5\u539F\u53D1\u9001\u8BB0\u5F55\u3002");
          if (old.state === "sent") return { receipt: this.receipt(old) };
          if (old.state === "failed") throw fault(old.code, sendErrorMessage(old.code));
          throw fault("QQ_SEND_UNCERTAIN", sendErrorMessage("QQ_SEND_UNCERTAIN"));
        }
        if (!context2.enabled || context2.connection !== "connected") throw fault("QQ_NOT_CONNECTED", "\u6240\u9009\u673A\u5668\u4EBA\u5C1A\u672A\u8FDE\u63A5\u6216\u5DF2\u6682\u505C\uFF0C\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u6062\u590D\u8FDE\u63A5\u3002");
        if (!this.host.current(context2)) throw fault("CONFIG_CHANGED", "\u673A\u5668\u4EBA\u914D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u8BF7\u68C0\u67E5\u76EE\u6807\u540E\u91CD\u65B0\u8C03\u7528\u3002");
        if (this.records.length >= MAX_RECORDS) throw fault("PROACTIVE_OUTBOX_FULL", "\u4E3B\u52A8\u6D88\u606F\u8BB0\u5F55\u5DF2\u6EE1\uFF0C\u8BF7\u7B49\u5F85\u4E03\u5929\u8BB0\u5F55\u8FC7\u671F\u540E\u518D\u53D1\u9001\u3002");
        const record2 = {
          requestKey: args.request_key,
          workerId: crypto.randomUUID(),
          fingerprint,
          botId: args.bot_id,
          appId: context2.appId,
          sandbox: context2.sandbox,
          groupId: args.group_openid,
          createdAt: this.now(),
          state: "sending"
        };
        this.records.push(record2);
        try {
          await this.save();
        } catch {
          record2.state = "failed";
          record2.code = "PROACTIVE_STATE_WRITE_FAILED";
          throw fault(record2.code, sendErrorMessage(record2.code));
        }
        return { record: record2, context: context2 };
      });
      this.preparing = prepare.then(() => {
      }, () => {
      });
      const prepared = await prepare;
      if (prepared.receipt) return prepared.receipt;
      const { record, context } = prepared;
      try {
        if (!this.host.current(context)) throw fault("CONFIG_CHANGED", "\u673A\u5668\u4EBA\u914D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u6D88\u606F\u672A\u53D1\u9001\u3002");
        const result = await this.host.send({
          botId: record.botId,
          appId: record.appId,
          epoch: context.epoch,
          groupId: record.groupId,
          requestId: record.workerId,
          text: args.text
        }, callId);
        if (!this.host.current(context) || result?.sent !== true || typeof result.messageId !== "string" || !result.messageId) throw fault("QQ_SEND_UNCERTAIN", sendErrorMessage("QQ_SEND_UNCERTAIN"));
        record.messageId = result.messageId;
        if (typeof result.timestamp === "string") record.timestamp = result.timestamp;
        record.state = "sent";
      } catch (error2) {
        const code = error2.code || "QQ_SEND_UNCERTAIN";
        const rejected = /^(QQ_API_\d{3,10}|QQ_HTTP_4\d\d)$/.test(code) || ["CONFIG_CHANGED", "QQ_NOT_CONNECTED", "PERMISSION_DENIED"].includes(code);
        record.state = rejected ? "failed" : "uncertain";
        record.code = rejected ? code : "QQ_SEND_UNCERTAIN";
        await this.save().catch(() => {
        });
        throw fault(record.code, rejected && !/^QQ_(API|HTTP)_/.test(code) ? error2.message : sendErrorMessage(record.code));
      }
      try {
        await this.save();
      } catch {
        return { ...this.receipt(record), state_saved: false, warning: "QQ \u5DF2\u786E\u8BA4\u6D88\u606F\u53D1\u9001\uFF0C\u4F46\u56DE\u6267\u4FDD\u5B58\u5931\u8D25\u3002\u8BF7\u68C0\u67E5\u76EE\u6807\u7FA4\uFF0C\u4E0D\u8981\u66F4\u6362\u8BF7\u6C42\u7F16\u53F7\u91CD\u53D1\uFF1B\u63D2\u4EF6\u91CD\u542F\u540E\u6B64\u8BB0\u5F55\u53EF\u80FD\u663E\u793A\u4E3A\u7ED3\u679C\u4E0D\u786E\u5B9A\u3002" };
      }
      return this.receipt(record);
    }
  };

  // src/state-store.mjs
  var clone = (value) => JSON.parse(JSON.stringify(value));
  var error = () => Object.assign(new Error("\u63D2\u4EF6\u72B6\u6001\u65E0\u6CD5\u6838\u5B9E\uFF0C\u5DF2\u4FDD\u7559\u539F\u6587\u4EF6\uFF0C\u672A\u91CD\u653E\u53D1\u9001\u3002"), { code: "STATE_RECOVERY_REQUIRED" });
  async function hash(value) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  var StateStore = class {
    constructor(io, name, legacy) {
      this.io = io;
      this.paths = [name + ".a.json", name + ".b.json"];
      this.legacy = legacy;
      this.seq = 0;
      this.tail = Promise.resolve();
      this.blocked = false;
    }
    async read() {
      const raws = await Promise.all(this.paths.map((p) => this.io.read(p)));
      if (raws.every((x) => x === null)) {
        if (await this.io.read(this.paths[0] + ".started") !== null) throw error();
        return this.legacy ? this.legacy() : null;
      }
      const copies = [];
      for (const raw of raws) {
        if (raw === null) throw error();
        let x;
        try {
          x = JSON.parse(raw);
        } catch {
          throw error();
        }
        if (x.format !== 1 || !Number.isSafeInteger(x.seq) || x.seq < 1 || !x.payload || x.hash !== await hash([x.seq, x.payload])) throw error();
        copies.push(x);
      }
      if (copies[0].seq !== copies[1].seq || copies[0].hash !== copies[1].hash) throw error();
      this.seq = copies[0].seq;
      return clone(copies[0].payload);
    }
    write(payload) {
      const frozen = clone(payload);
      const run = this.tail.then(async () => {
        if (this.blocked) throw error();
        const record = { format: 1, seq: ++this.seq, payload: frozen };
        record.hash = await hash([record.seq, record.payload]);
        const text = JSON.stringify(record);
        if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw Object.assign(new Error("\u63D2\u4EF6\u72B6\u6001\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u672A\u53D1\u9001\u3002"), { code: "STATE_CAPACITY_FULL" });
        try {
          await this.io.write(this.paths[0] + ".started", "1");
          for (const path of this.paths) {
            await this.io.write(path, text);
            if (await this.io.read(path) !== text) throw error();
          }
        } catch (e) {
          this.blocked = true;
          throw e;
        }
      });
      this.tail = run.catch(() => {
      });
      return run;
    }
  };

  // src/main.mjs
  var channel = new BroadcastChannel("qq-companion-bot-ui");
  async function readState(path) {
    const result = await cindy.fs({ op: "read", root: "data", path });
    if (!result.ok) {
      if (new RegExp("not found|\u4E0D\u5B58\u5728|ENOENT", "i").test(result.message || "") || ["NOT_FOUND", "FILE_NOT_FOUND", "ENOENT"].includes(result.errorCode)) return null;
      throw fault("STATE_READ_FAILED", "\u65E0\u6CD5\u8BFB\u53D6\u63D2\u4EF6\u6570\u636E\uFF0C\u8BF7\u4FDD\u7559\u6570\u636E\u5E76\u68C0\u67E5\u63D2\u4EF6\u72B6\u6001\u3002");
    }
    try {
      return JSON.parse(result.content);
    } catch {
      throw fault("STATE_INVALID", "\u63D2\u4EF6\u6570\u636E\u635F\u574F\uFF0C\u8BF7\u4FDD\u7559\u539F\u6570\u636E\u5E76\u8054\u7CFB\u4F5C\u8005\u3002");
    }
  }
  var imageSupport = async () => {
    if (typeof cindy.tasks?.capabilities !== "function") return false;
    const caps = await cindy.tasks.capabilities();
    return Array.isArray(caps?.messageAttachments?.kinds) && caps.messageAttachments.kinds.includes("image");
  };
  var defaultSupport = async () => {
    const caps = await cindy.tasks?.capabilities?.();
    if (!["get", "send"].every((op) => caps?.operations?.includes(op) && typeof cindy.tasks?.[op] === "function") || !["list", "resolve", "send", "get"].every((op) => typeof cindy.targets?.[op] === "function")) throw fault("HOST_UNSUPPORTED", "\u5F53\u524D Cindy \u7F3A\u5C11\u9879\u76EE\u6295\u9012\u6216\u72EC\u7ACB\u4EFB\u52A1\u7EED\u804A\u80FD\u529B\u3002");
  };
  async function sendQuestion(params, assertCurrent) {
    assertCurrent();
    await defaultSupport();
    assertCurrent();
    let task;
    if (params.taskId) try {
      task = await cindy.tasks.get({ taskId: params.taskId });
      assertCurrent();
      if (task.status !== "active") task = null;
    } catch (error2) {
      if (error2.code === "TASK_NOT_FOUND") task = null;
      else {
        error2.beforeSend = true;
        throw error2;
      }
    }
    if (task) {
      const caps = await cindy.tasks.capabilities();
      if (!caps.operations?.includes("setModel") || typeof cindy.tasks.setModel !== "function") throw Object.assign(fault("HOST_UNSUPPORTED", "\u5BBF\u4E3B\u7F3A\u5C11\u7FA4\u6A21\u578B\u540C\u6B65\u80FD\u529B\u3002"), { beforeSend: true });
      try {
        const selected = await cindy.tasks.setModel({ taskId: task.taskId, expectedRevision: task.revision, route: params.route });
        task = selected.task;
        assertCurrent();
      } catch (error2) {
        error2.beforeSend = true;
        throw error2;
      }
      if (!task || task.taskId !== params.taskId) throw Object.assign(fault("TASK_SOURCE_CONFLICT", "\u4EFB\u52A1\u56DE\u6267\u4E0D\u5339\u914D\u3002"), { beforeSend: true });
      const run = await cindy.tasks.send({ taskId: task.taskId, expectedRevision: task.revision, requestKey: params.requestKey, text: params.text, ...params.attachments ? { attachments: params.attachments } : {} });
      if (!run?.runId) throw fault("DELIVERY_UNCERTAIN", "\u4EFB\u52A1\u53D7\u7406\u7ED3\u679C\u4E0D\u786E\u5B9A\uFF0C\u672A\u91CD\u53D1\u3002");
      return { accepted: true, taskId: task.taskId, runId: run.runId };
    }
    const receipt = await cindy.targets.send({ target: { kind: "project", id: params.projectId }, requestKey: params.requestKey, text: params.text, title: "QQ \u6210\u5458\u8FDE\u7EED\u4F1A\u8BDD", route: params.route, delivery: "queue", ...params.attachments ? { attachments: params.attachments } : {} });
    if (!receipt?.accepted || !receipt.taskId) throw fault("DELIVERY_UNCERTAIN", "\u9879\u76EE\u6295\u9012\u7ED3\u679C\u4E0D\u786E\u5B9A\uFF0C\u672A\u91CD\u53D1\u3002");
    await recordSource(receipt.taskId);
    assertCurrent();
    return receipt;
  }
  var connectionScopes = /* @__PURE__ */ new Map();
  var migratedQQSessions = /* @__PURE__ */ new Set();
  var rawIO = {
    read: async (path) => {
      const value = await cindy.fs({ op: "read", root: "data", path });
      if (value.ok) return value.content;
      if (["NOT_FOUND", "FILE_NOT_FOUND", "ENOENT"].includes(value.errorCode) || /not found|不存在|ENOENT/i.test(value.message || "")) return null;
      throw fault("STATE_READ_FAILED", "\u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF0C\u672A\u91CD\u653E\u3002");
    },
    write: async (path, content) => {
      const value = await cindy.fs({ op: "write", root: "data", path, content });
      if (!value.ok) throw fault("STATE_WRITE_FAILED", "\u72B6\u6001\u4FDD\u5B58\u5931\u8D25\uFF0C\u672A\u53D1\u9001\u3002");
    }
  };
  var stores = new Map(["bot1", "bot2", "bot3", "bot4"].map((id) => [id, new StateStore(rawIO, "member-state-" + id, () => readState(id === "bot1" ? "bridge-state.json" : "bridge-state-" + id + ".json"))]));
  var sourceStore = new StateStore(rawIO, "member-sources");
  var sourcesReady = false;
  var sourceWrite = Promise.resolve();
  async function recordSource(id) {
    if (typeof id !== "string" || !id || id.length > 160) throw fault("TASK_SOURCE_CONFLICT", "\u4EFB\u52A1\u8EAB\u4EFD\u65E0\u6548\u3002");
    migratedQQSessions.add(id);
    const run = sourceWrite.then(() => {
      if (migratedQQSessions.size > 1e4) throw fault("SOURCE_CAPACITY_FULL", "\u6765\u6E90\u8BB0\u5F55\u5DF2\u6EE1\uFF0C\u672A\u53D1\u9001\u3002");
      return sourceStore.write({ schema: 1, sessionIds: [...migratedQQSessions] });
    });
    sourceWrite = run.catch(() => {
    });
    await run;
  }
  async function ownerSession(id) {
    if (!sourcesReady || typeof id !== "string" || !id) throw fault("PROACTIVE_FORBIDDEN", "\u6765\u6E90\u672A\u6838\u5B9E\uFF0C\u4E3B\u52A8\u53D1\u9001\u4E0D\u53EF\u7528\u3002");
    if (migratedQQSessions.has(id) || [...controller.controllers.values()].some((b) => b.jobs.some((j) => j.taskId === id) || b.histories.some((h) => h.taskId === id))) return false;
    try {
      const task = await cindy.tasks.get({ taskId: id });
      if (task?.taskId === id) return false;
      throw fault("SOURCE_UNCERTAIN", "\u4EFB\u52A1\u6765\u6E90\u4E0D\u660E\u786E\u3002");
    } catch (error2) {
      if (error2.code === "TASK_NOT_FOUND") return true;
      throw error2;
    }
  }
  var controller = new BridgeFleet({ forBot: (id) => ({
    botId: id,
    read: () => stores.get(id).read(),
    write: (state) => stores.get(id).write(state),
    resolve: (projectId) => cindy.targets.resolve({ target: { kind: "project", id: projectId } }),
    send: sendQuestion,
    defaultSupport,
    imageSupport,
    getRun: async (runId) => {
      const caps = await cindy.tasks.capabilities();
      if (!caps.operations?.includes("getRun") || typeof cindy.tasks.getRun !== "function") throw fault("HOST_UNSUPPORTED", "\u7F3A\u5C11\u539F\u751F\u8FD0\u884C\u72B6\u6001\u8BFB\u53D6\u80FD\u529B\u3002");
      return cindy.tasks.getRun({ runId });
    },
    images: (job, epoch) => collectImages(controller.controllers.get(id).host.node, job, epoch),
    node: async (method, params) => {
      if (method.startsWith("qq/connect")) {
        const secrets = await (await fetch("/secrets")).json();
        if (!secrets.some((s) => s.key === secretKey(id) && s.saved)) throw fault("QQ_SECRET_REQUIRED", "\u8BF7\u4FDD\u5B58\u6B64\u673A\u5668\u4EBA\u7684AppSecret\u3002");
      }
      const result = await cindy.node.request({ method, params, timeoutMs: method === "qq/reply" || method === "qq/final-active" ? 4e4 : 3e4 });
      if (!result.ok) {
        const code = result.errorCode === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : /^(QQ_[A-Z_]+|IMAGE_[A-Z_]+|INVALID_REPLY|REPLY_CONFLICT|FINAL_CONFLICT|FINAL_STATE_REQUIRED|FINAL_INBOX_FULL)$/.test(result.message || "") ? result.message : "QQ_SEND_UNCERTAIN";
        throw fault(code, "QQ\u64CD\u4F5C\u672A\u786E\u8BA4\uFF0C\u672A\u91CD\u53D1\u3002");
      }
      if (method.startsWith("qq/connect")) connectionScopes.set(id, { appId: params.appId, sandbox: params.sandbox === true, epoch: params.epoch });
      else if (method === "qq/disconnect") connectionScopes.delete(id);
      return result.result;
    }
  }), changed: () => channel.postMessage({ type: "snapshot", snapshot: snapshot() }) });
  var proactive = new ProactiveSender({
    read: () => readState("proactive-state.json"),
    write: async (state) => {
      const result = await cindy.fs({ op: "write", root: "data", path: "proactive-state.json", content: JSON.stringify(state) });
      if (!result.ok) throw fault("PROACTIVE_STATE_WRITE_FAILED", "\u65E0\u6CD5\u4FDD\u5B58\u4E3B\u52A8\u6D88\u606F\u72B6\u6001\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u6570\u636E\u3002");
    },
    isQQSession: (sessionId) => !sourcesReady || migratedQQSessions.has(sessionId) || [...controller.controllers.values()].some((b) => b.jobs.some((j) => j.taskId === sessionId) || b.histories.some((h) => h.taskId === sessionId)),
    context: (id) => {
      const cfg = controller.config.bots.find((b2) => b2.id === id), b = controller.controllers.get(id);
      return cfg && b ? { botId: id, appId: cfg.appId, sandbox: cfg.sandbox, enabled: cfg.enabled, connection: b.connection, generation: b.runtimeGeneration, epoch: b.connectionEpoch } : null;
    },
    current: (context) => {
      const b = controller.controllers.get(context.botId), cfg = controller.desired.bots.find((b2) => b2.id === context.botId), connected = connectionScopes.get(context.botId);
      return !!b && !!cfg?.enabled && cfg.appId === context.appId && cfg.sandbox === context.sandbox && b.cfg.enabled && b.connection === "connected" && b.runtimeGeneration === context.generation && b.connectionEpoch === context.epoch && connected?.appId === context.appId && connected.sandbox === context.sandbox && connected.epoch === context.epoch;
    },
    send: async (params, callId) => {
      const result = await cindy.node.request({ method: "qq/send-group", params, callId, timeoutMs: 3e4 });
      if (!result.ok) {
        const code = result.errorCode === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : /^(QQ_API_\d{3,10}|QQ_HTTP_4\d\d|QQ_NOT_CONNECTED|QQ_SEND_UNCERTAIN|INVALID_GROUP_MESSAGE|GROUP_MESSAGE_CONFLICT)$/.test(result.message || "") ? result.message : "QQ_SEND_UNCERTAIN";
        throw fault(code, sendErrorMessage(code));
      }
      return result.result;
    }
  });
  var bootError = null;
  var checkedAt = null;
  var proactiveError = null;
  var snapshot = () => ({ ...controller.snapshot(), bootError, checkedAt, proactiveMessages: proactive.snapshot(), proactiveError });
  function failBoot(error2, message) {
    bootError = { code: error2.code || "BOOT_FAILED", message };
    checkedAt = Date.now();
    channel.postMessage({ type: "boot-error", error: bootError });
    channel.postMessage({ type: "snapshot", snapshot: snapshot() });
  }
  var ready = (async () => {
    if (typeof cindy.targets?.send !== "function") throw fault("HOST_UNSUPPORTED", "\u5F53\u524D Cindy \u7F3A\u5C11\u9879\u76EE\u6295\u9012\u63A5\u53E3\u3002");
    const raw = await (await fetch("/kv")).json(), config = fleetConfig(raw);
    if (raw.schema !== 3) {
      if (await rawIO.read("config-legacy-1.5.1.json") === null) await rawIO.write("config-legacy-1.5.1.json", JSON.stringify(raw));
      const saved = await fetch("/kv", { method: "PUT", body: JSON.stringify(config) });
      if (!saved.ok) throw fault("CONFIG_SAVE_FAILED", "\u65E7\u914D\u7F6E\u8F6C\u6362\u540E\u65E0\u6CD5\u4FDD\u5B58\u3002");
    }
    const previousSessions = await readState("qq-source-session-compat.json");
    if (previousSessions) {
      if (previousSessions.schema !== 1 || !Array.isArray(previousSessions.sessionIds) || previousSessions.sessionIds.length > 1e4 || previousSessions.sessionIds.some((id) => typeof id !== "string" || !id || id.length > 160)) throw fault("STATE_INVALID", "\u539F QQ \u4F1A\u8BDD\u6743\u9650\u8BB0\u5F55\u635F\u574F\uFF0C\u8BF7\u4FDD\u7559\u6570\u636E\u5E76\u8054\u7CFB\u4F5C\u8005\u3002");
      for (const id of previousSessions.sessionIds) migratedQQSessions.add(id);
    }
    const prior = await sourceStore.read();
    if (prior) {
      if (prior.schema !== 1 || !Array.isArray(prior.sessionIds) || prior.sessionIds.length > 1e4 || prior.sessionIds.some((id) => typeof id !== "string" || !id || id.length > 160)) throw fault("STATE_INVALID", "\u7FA4\u8BF7\u6C42\u6765\u6E90\u8BB0\u5F55\u635F\u574F\u3002");
      for (const id of prior.sessionIds) migratedQQSessions.add(id);
    }
    for (const id of ["bot1", "bot2", "bot3", "bot4"]) {
      const legacy = await readState(id === "bot1" ? "bridge-state.json" : "bridge-state-" + id + ".json");
      if (legacy) {
        if (![1, 2, 3].includes(legacy.schema) || !Array.isArray(legacy.jobs) || legacy.histories !== void 0 && !Array.isArray(legacy.histories)) throw fault("STATE_UNSUPPORTED", "\u65E7\u6765\u6E90\u6570\u636E\u4E0D\u517C\u5BB9\uFF0C\u672A\u6E05\u7A7A\u3002");
        for (const item of [...legacy.jobs, ...legacy.histories || []]) if (item.taskId) {
          if (typeof item.taskId !== "string" || item.taskId.length > 160) throw fault("STATE_INVALID", "\u65E7\u6765\u6E90\u8EAB\u4EFD\u635F\u574F\u3002");
          migratedQQSessions.add(item.taskId);
        }
      }
    }
    await sourceStore.write({ schema: 1, sessionIds: [...migratedQQSessions] });
    await controller.init();
    for (const b of controller.controllers.values()) for (const j of b.jobs) if (j.taskId) migratedQQSessions.add(j.taskId);
    await sourceStore.write({ schema: 1, sessionIds: [...migratedQQSessions] });
    sourcesReady = true;
    await controller.configure(config);
    checkedAt = Date.now();
    try {
      await proactive.init();
    } catch (error2) {
      proactiveError = { code: error2.code || "PROACTIVE_STATE_INVALID", message: error2.message || "\u4E3B\u52A8\u6D88\u606F\u8BB0\u5F55\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u6570\u636E\u3002" };
    }
  })().catch((error2) => {
    failBoot(error2, "\u63D2\u4EF6\u542F\u52A8\u81EA\u68C0\u672A\u901A\u8FC7\uFF0C\u8BF7\u68C0\u67E5\u6743\u9650\u6216\u4FDD\u5B58\u7684\u6570\u636E\uFF1B\u4FEE\u590D\u540E\u91CD\u65B0\u542F\u7528\u63D2\u4EF6\u3002");
  });
  var uiRequests = /* @__PURE__ */ new Map();
  setInterval(async () => {
    await ready;
    if (!bootError) {
      try {
        await controller.tick();
      } catch (error2) {
        failBoot(error2, "\u72B6\u6001\u4FDD\u5B58\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u53D1\u9001\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u6570\u636E\u3002");
      }
    }
  }, 15e3);
  async function selfCheck() {
    await ready;
    if (!bootError) {
      for (const b of controller.controllers.values()) for (const j of b.jobs) if (!j.legacy && j.nativeSubmissionUnknown && j.projectId && j.sendKey) {
        try {
          const receipt = await cindy.targets.get({ requestKey: j.sendKey });
          if (receipt.found === true && receipt.status === "accepted" && receipt.target?.kind === "project" && receipt.target.id === j.projectId && typeof receipt.taskId === "string" && receipt.taskId && receipt.taskId.length <= 160) {
            await recordSource(receipt.taskId);
            j.taskId = receipt.taskId;
            j.state = "waiting";
            j.finalEligible = true;
            j.slotReleased = true;
            j.blockMember = false;
            j.nativeSubmissionUnknown = false;
            j.code = "HOST_RECEIPT_RECOVERED";
            const h = b.talkFor(j);
            if (h) h.taskId = receipt.taskId;
            await b.save();
          }
        } catch {
        }
      }
      for (const cfg of controller.config.bots) {
        const b = controller.controllers.get(cfg.id);
        if (!cfg.enabled) {
          if (b.connection === "error") await controller.configure(controller.desired, cfg.id);
          continue;
        }
        if (b.connection === "needs_config") continue;
        try {
          const health = await b.host.node("qq/status", { health: true });
          if (health.appId === b.cfg.appId && health.epoch === b.connectionEpoch && ["connected", "connecting"].includes(health.state)) await controller.status({ botId: cfg.id, state: health.state, epoch: health.epoch });
          else await controller.status({ botId: cfg.id, state: "error", code: "NODE_STOPPED", epoch: b.connectionEpoch });
        } catch (error2) {
          await controller.status({ botId: cfg.id, state: ["PERMISSION_DENIED", "QQ_SECRET_REQUIRED"].includes(error2.code) ? "needs_config" : "error", code: error2.code || "NODE_REQUEST_FAILED", epoch: b.connectionEpoch });
        }
      }
      await controller.tick();
    }
    checkedAt = Date.now();
    return snapshot();
  }
  ready.then(async () => {
    try {
      await selfCheck();
    } catch (error2) {
      failBoot(error2, "\u542F\u52A8\u540E\u7684\u81EA\u68C0\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u6743\u9650\u548C\u4FDD\u5B58\u7684\u6570\u636E\u3002");
    }
    channel.postMessage({ type: "snapshot", snapshot: snapshot() });
  });
  channel.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "ui-request" || typeof msg.id !== "string") return;
    if (uiRequests.has(msg.id)) {
      channel.postMessage(await uiRequests.get(msg.id));
      return;
    }
    const run = (async () => {
      try {
        let data;
        if (msg.action === "targets") data = await cindy.targets.list({ targetKind: "project" });
        else {
          await ready;
          if (msg.action === "snapshot") data = snapshot();
          else if (msg.action === "self-check") data = await selfCheck();
          else {
            if (bootError) throw fault(bootError.code, bootError.message);
            if (msg.action === "reload") {
              await controller.configure(await (await fetch("/kv")).json(), msg.botId);
              data = snapshot();
            } else if (msg.action === "pick-model") {
              if (typeof cindy.pickModel !== "function") throw fault("HOST_UNSUPPORTED", "\u5F53\u524D Cindy \u7F3A\u5C11\u7EDF\u4E00\u6A21\u578B\u9009\u62E9\u5668\uFF0C\u8BF7\u5347\u7EA7\u5BA2\u6237\u7AEF\u3002");
              data = await cindy.pickModel({ allowRemote: false, ...msg.initial ? { initial: msg.initial } : {}, ...msg.mobilePageId ? { mobilePageId: msg.mobilePageId } : {} });
            } else if (msg.action === "release-waiting") {
              const b = controller.controllers.get(msg.botId);
              if (!b) throw fault("BOT_CONFIG_INVALID", "\u673A\u5668\u4EBA\u4E0D\u5B58\u5728\u3002");
              await b.releaseWaiting(msg.requestId);
              data = snapshot();
            } else if (msg.action === "clear-history") {
              await controller.clearHistory(msg.botId);
              data = snapshot();
            } else if (msg.action === "clear-bot") {
              await controller.clearBot(msg.botId);
              data = snapshot();
            } else throw fault("INVALID_UI_REQUEST", "\u4E0D\u652F\u6301\u7684\u64CD\u4F5C\u3002");
          }
        }
        return { type: "ui-response", id: msg.id, ok: true, data };
      } catch (error2) {
        return { type: "ui-response", id: msg.id, ok: false, error: { code: error2.code || "REQUEST_FAILED", message: error2.message || "\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u6743\u9650\u3001\u9879\u76EE\u548C\u6A21\u578B\u914D\u7F6E\u3002" } };
      }
    })();
    uiRequests.set(msg.id, run);
    if (uiRequests.size > 64) uiRequests.delete(uiRequests.keys().next().value);
    channel.postMessage(await run);
  };
  cindy.onHostMessage(async (msg) => {
    await ready;
    if (msg.type === "event" && msg.name === "node-notification" && !bootError) {
      try {
        if (msg.method === "qq/message") await controller.receive(msg.params);
        else if (msg.method === "qq/status") await controller.status(msg.params);
        else if (msg.method === "qq/tick") await controller.tick();
      } catch (error2) {
        failBoot(error2, "\u6D88\u606F\u5904\u7406\u6216\u4FDD\u5B58\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u53D1\u9001\uFF0C\u8BF7\u4FDD\u7559\u6570\u636E\u68C0\u67E5\uFF1B\u672A\u81EA\u52A8\u91CD\u53D1\u3002");
      }
    }
    if (msg.type === "event" && msg.name === "node-status" && ["stopped", "crashed"].includes(msg.state) && !bootError) {
      await controller.stopped();
      setTimeout(async () => {
        if (!bootError) {
          try {
            await controller.recover();
          } catch {
          }
        }
      }, 2e3);
    }
    if (msg.type !== "tool-call") return;
    try {
      let result;
      const args = msg.args || {};
      if (msg.tool === "get_status") {
        const view = snapshot(), caller = args.session_context?.session_id;
        let isOwner = false, callerScope = { kind: "unverified", code: "CALLER_CONTEXT_REQUIRED" };
        if (caller) try {
          isOwner = await ownerSession(caller);
          callerScope = { kind: isOwner ? "owner" : "qq-request" };
        } catch (error2) {
          callerScope = { kind: "unverified", code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error2.code || "") ? error2.code : "SOURCE_UNCERTAIN" };
        }
        if (!isOwner) {
          view.bots = view.bots.map((b) => {
            const scoped = callerScope.kind === "qq-request" ? b.jobs.filter((j) => j.taskId === caller) : [], groups = new Set(scoped.map((j) => j.groupId));
            return { ...b, jobs: scoped, groups: (b.groups || []).filter((g) => groups.has(g.id)), config: { appId: b.config?.appId, enabled: b.config?.enabled, sandbox: b.config?.sandbox }, conversationCount: void 0 };
          }).filter((b) => b.jobs.length);
          delete view.config;
        }
        result = {
          ...view,
          caller_scope: callerScope,
          config_visibility: isOwner ? "full" : "not-included",
          ...!isOwner ? { proactiveMessages: [], proactiveError: null, scope_message: callerScope.kind === "unverified" ? "\u8C03\u7528\u6765\u6E90\u672A\u6838\u5B9E\uFF0C\u672A\u63D0\u4F9B\u5168\u5C40\u673A\u5668\u4EBA\u914D\u7F6E\uFF1B\u7A7A\u7684\u53EF\u89C1\u8BF7\u6C42\u5217\u8868\u4E0D\u4EE3\u8868\u8D26\u53F7\u6216\u51ED\u8BC1\u88AB\u5220\u9664\u3002" : "\u4EC5\u663E\u793A\u672C\u4EFB\u52A1\u8BF7\u6C42\uFF1B\u672A\u63D0\u4F9B\u5168\u5C40\u673A\u5668\u4EBA\u914D\u7F6E\u3002" } : {},
          hostImageAttachments: await imageSupport().catch(() => false),
          ...isOwner ? { hostTaskCapabilities: await (async () => cindy.tasks?.capabilities?.())().catch(() => null) } : {}
        };
      } else if (bootError) throw fault(bootError.code, bootError.message);
      else if (msg.tool === "get_question") result = await controller.question(args.request_id, args.session_context?.session_id);
      else if (msg.tool === "reply_to_qq") result = await controller.reply(args.request_id, args.text, args.session_context?.session_id);
      else if (msg.tool === "send_group_message") {
        if (proactiveError) throw fault(proactiveError.code, proactiveError.message);
        if (!await ownerSession(args.session_context?.session_id)) throw fault("PROACTIVE_FORBIDDEN", "\u7FA4\u95EE\u7B54\u53EA\u80FD\u56DE\u590D\u539F\u8BF7\u6C42\uFF0C\u4E0D\u80FD\u4E3B\u52A8\u9009\u62E9\u7FA4\u53D1\u9001\u3002");
        result = await proactive.send(args, args.session_context?.session_id, msg.callId);
      } else throw fault("UNKNOWN_TOOL", "\u4E0D\u652F\u6301\u7684\u5DE5\u5177\u3002");
      await cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result });
    } catch (error2) {
      await cindy.send({ type: "tool-result", callId: msg.callId, ok: false, errorCode: error2.code || "QQ_PLUGIN_FAILED", message: error2.message || "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63D2\u4EF6\u8BBE\u7F6E\u3002" });
    }
  });
})();
