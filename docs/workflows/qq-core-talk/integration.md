# 核心问答与已安装主动群发的交付合并

work_unit: qq-core-talk-release-integration-20261105
goal: 将已审核的单次问答与 /talk 两小时续聊更新到实际已安装版本，同时保留另一工作交付的主动群发。
source: 核心 efe52085dceb04cf712dc1fcf1e026b978ed2b8b（reviewer-2 r3 APPROVE，114 项测试）与已交付主动群发 7918a4f6989a38ee56c14d1e6e7983bba7982bde。
branch: feat/qq-core-talk-20261105
version: 1.5.1
scope: 两父版本合并冲突与 /talk 状态/proactive 权限接线；不扩张到原伙伴并发或七天查询任务清理。
authorization: 用户要求核心交付、审核后提交/推送和原位更新；保留工作区其他成果与原账号配置。
execution: Lead 合并及门禁，原指定 Orca Worker reviewer-2 独立合并审核。
current_gate: independent integration review
next_entry_point: reviewer-2 审核冻结合并结果，通过后提交 merge、推送与原位更新。

2026-11-05：提交已审核的核心前，实时 ghost_info/get_status 发现已安装实例变为 1.5.0，含 send_group_message，且 bootError=STATE_WRITE_FAILED。此前“安装目标仍1.3.0”前提失效。1.4.0 不再作为最终安装包，避免覆盖另一工作。未更改该工作树或用户配置。

合并决策：保留核心 sendQuestion/openTalk/定长键及会话状态机，保留主动群发工具、Node/SDK 接口、主动状态与连接环境校验。schema3 含 tasks 的扩展 WIP 数据仍在处理前完整备份并保留旧 QQ 会话限制，但不降级核心 /talk 的 schema3。主动工具的 QQ 来源检查包含 /talk.taskId，避免首发送失败时已创建的 QQ 任务被当主人任务。

基线 1.5.0 的源码备份路径在 7918a4f 已修为安全段长；集成沿用此路径。现场 STATE_WRITE_FAILED 的直接底层回执尚未读取，不把旧路径缺陷断言成当前现场根因；安装后复查真实状态。

验收：原 114 核心测试全部保留；主动群发回归与核心模式配套（get 能力、schema3 保留），新增 /talk 重启与 proactive 来源隔离。当前1.5.1包必须拥有四个工具，Cindy 0.1.124公开接口可运行，无伴随宿主部署。真实 QQ 收发未实测；宿主 run 返回 failed/reconciling 的既有超时行为留后续版本。

Lead 门禁：build PASS (.verification/integration-build-tests-20261105.log)，tests 143/143 PASS (integration-final-tests-20261105.log)，UI smoke PASS (integration-ui-smoke-20261105-rerun.log)，合并冲突已解决，staged/unstaged diff 和 syntax PASS (integration-final-diff-20261105.log / integration-syntax-20261105.log)。UI 首轮的损坏状态样本为所有文件返回 schema99，新增兼容记录读取先触发 STATE_INVALID；已改成只对指定 bridge-state.json 提供 schema99，其余文件 NOT_FOUND，维持原 STATE_UNSUPPORTED 与伙伴列表断言。

最终独立审核：Orca Worker reviewer-2 (iosepi80qwifatrdpjy2kvhl)，task_id=qq-core-talk-release-integration-review，attempt_id=r1；此前 r3 APPROVE 只覆盖核心 efe5208，不代替本次合并审核。
