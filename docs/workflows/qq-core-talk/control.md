# QQ 核心问答交付记录

work_unit: qq-core-talk-20261105
type: development
goal: 普通 @ 一次性答复；本人同群 /talk 开启续聊，普通 @ 也继续；两小时无有效活动结束。
success_signal: 随包运行回归与设置页 smoke 通过，reviewer-2 完整审核通过，再提交、推送、原位更新。
non_goals: 原伙伴独立并发、七天任务信息删除；保留扩展 WIP，见 TODO.md。
scope: qq-companion-core，相对已交付 1.3.0 的完整差异；无宿主改动。
branch: feat/qq-core-talk-20261105
base_ref: c9b421d56b4733361193e2c9bdedcec2858036c7
delivery: local-closeout + 用户已授权的提交/推送/原位插件更新；不创建或合并 PR。
authorization: 用户确认核心功能优先，并发及七天清理 TODO；功能完成后由新 reviewer 审核，没问题才提交并更新。
execution: Lead 收口与验证；Orca Worker reviewer-2 独立最终审核。
host: Cindy 0.1.125 / ac785430449042f120a296b881a25ae52333f1e1；核心最低 0.1.124。
current_gate: independent final review
next_entry_point: reviewer-2 对冻结源码和包做完整审核；通过后由 Lead 提交/推送/原位更新。运行收尾回执写入本地 .verification，不变更审核后的行为代码。

## 已确认契约与切片

1. 单次问答：插件不持久保存正文或问答历史，去重编号/状态保留；不选伙伴各自新建辅助模型对话；已选伙伴用现有公开 targets.send。升级清理旧自动历史，不开启 /talk。
2. 连续问答：按机器人/AppID/环境/群/发言人/伙伴匹配；2 小时滑动活动期限，最多 80 个会话、每个 8 轮缓存；有效输入及确认答复延期，无效或重复不延期。裸 /talk 静态回群确认。
3. 恢复与失败：默认模型 /talk 复用实际 taskId 和最新 revision；重启不重放正文；已删除/归档任务普通追问结束旧会话并静态提示，明确 /talk 用新的 UUID/create 键重新开启；TIMEOUT 不判删除，send 未知保持 uncertain。

原扩展计划经过 Orca reviewer PLAN_PASS；本工作单元仅缩小到已批准核心行为，状态/恢复设计由 Lead 自检，最终覆盖由 reviewer-2 独立审核。此前 1.3.0 APPROVE 和 77 项扩展目录测试均不是本版本最终交付批准。

## 验证与审核

完整输出放 `.verification/`。gate 结果只用一行命令、PASS/FAIL、日志路径。

- build/test：r3 PASS node scripts/build.cjs / node scripts/test.cjs（114/114），日志 .verification/core-r3-build-20261105.log / core-r3-tests-20261105.log。
- ui-smoke：r3 PASS node scripts/ui-smoke.cjs，日志 .verification/core-r3-ui-smoke-20261105.log；随包 main.js + mock Host + Chrome，320/800px 明暗布局。
- diff/syntax：r3 PASS git diff --check / node --check，日志 .verification/core-r3-diff-check-20261105.log / core-r3-syntax-20261105.log。
- Forge pack：已通过校验生成 1.4.0 候选包；交接前重打包并冻结 .verification/review-source-sha256.json 与 package-sha256.log。
- 独立审核：task_id=qq-core-talk-final-review；worker_id=iosepi80qwifatrdpjy2kvhl，session_id=38516bc8-e088-4f3c-8d17-b03745a6e1cf；r1/r2 报告在 .verification/reviewer-2-core-final-r1-20261105.md 与 r2 同名文件，r1 三项已由 r2 闭环；当前修复新增 N1/N2 后派 r3。
- accepted finding T1：代码已补失效任务恢复；随包删除/归档、普通续聊、新 /talk 创建键与未知结果不重试回归通过，待 reviewer-2 复核。

r1 findings 全部 accepted，r2 实施：

- R2-F1：正式 taskSlot requestKey 上限 128，真实消息编号会超限。默认 tasks create/send 改用浏览器 Web Crypto SHA-256 确定性摘要；talk UUID 创建键及 targets 原键保持兼容。四槽、137 字符合成消息编号、单次/裸 talk/续聊/talk 问题随包回归通过。原请求编号及回群会话校验保持原样。
- R2-F2：已确认宿主 pre-receipt 拒绝码标 failed；talk send 遇 TASK_NOT_FOUND 结束旧talk，TASK_BUSY 再 get 确认非active后结束（仍active的附件压力不结束）；TIMEOUT/HOST_NOT_READY/无码错误保持 uncertain，无重发。回归通过。
- R2-F3：晚到失效 get 在任何重建缓存前检查 generation/config/jobs/talk，删除机器人和清缓存均不能恢复记录。实际 BridgeFleet clearBot/clearHistory 回归通过。
- 缺 get 能力的宿主在连接前以 HOST_UNSUPPORTED 提示配置问题，保持诊断且不自动连接。
  已经 GitHub get_ref 核对 v0.1.124=a5bd13c69b9f984ebee5fe32c737e489b6ab47dc，并读取该版本 taskSlot/pluginTaskService，确认 create/get/send 及 get 处理存在；相关官方源码副本在 .verification/host-task-slot-0.1.124.txt、host-task-service-0.1.124.txt。

100 回归首轮有 1 项测试夹具错误（不存在连接时仍发送 idle 事件覆盖诊断），已修正为只在真实 mock connect 后发送状态；当前 100/100，不削弱行为断言。

r2 新 findings 裁决与 r3 修复：

- R2-N1 accepted：显式 /talk 在首个输入发送前保存创建的 taskId，发送失败不丢创建身份；失效预检对默认路由的所有 talk 生效，包括旧状态缺 taskId。create 回执重放返回 TASK_NOT_FOUND 或非 active 时统一 lostTalk，明确 /talk 换新 UUID 并在新任务发送前保存身份，普通追问只静态提示。114 回归含首 send HOST_NOT_READY/TASK_BUSY × 删除/归档 × 裸/带问题重开，以及缺 taskId 的旧状态恢复矩阵。
- R2-N2 accepted：正式 taskSlot 在 handler 完成后还可能抛 PERMISSION_DENIED，无法确定输入未派发，因此该码在 tasks.send 路径保守标 uncertain，不自动重发；其余有确定前置拒绝证据的四码仍 failed。新的回归确认该标签和去重。

## 风险与边界

- 真实 QQ 群收发、图片 CDN/平台限制未实测：owner=Lead/用户，destination=交付说明与实际使用反馈。
- 伙伴 canonical 会话原生历史非发言人强隔离：owner=Lead，destination=README/manual 和下一阶段伙伴独立任务。
- Cindy 自身任务/媒体仍保留：owner=Lead，destination=TODO 七天定向清理。
- 普通正文不落盘，重启取消 queued，LIVE 标 uncertain：owner=Lead，destination=README/manual；防止自动重发。
- 扩展 WIP 与当前交付分离：owner=Lead，destination=documents/qq-parallel-20261105/control.md；不改正式 Host 或真实数据库。
