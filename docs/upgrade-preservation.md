# 同来源升级保留配置与凭证

## 正常更新条件

对已批准的manual/root、未验证发布者实例，普通新版内容hash变化不会单独触发换源。现行宿主分类要求：旧批准记录可读、id及namespace匹配、新包SHA有效、入口仍manual、没有替换市场来源。已有可信发布者/官方或旧特许来源还需满足其发布者或包身份约束。

条件满足时，宿主更新代码和批准回执，保持相同instanceKey的KV、data目录与secret key前缀。新版插件还须保留secretBindings key和机器人槽位，并安全处理原配置schema。显示已保存的密码框留空是正常行为，不表示删除。

换id、namespace、安装入口、市场源或可信发布者，或旧批准记录不可读时，不应称为同来源升级。宿主会隔离旧数据，不承诺所有换源自动继承账号，不能为方便而关闭该安全边界。

## 发布及操作

作者可用ghost_forge_pack生成版本包。对现有manual/root实例，使用Cindy“插件 → QQ 群伙伴 → 更多操作 → 从.cindy文件更新…”更新同一实例，保持manual来源、相同id和namespace。不要把ghost_forge_install、另装local或转市场安装当作同来源保留。

出现换来源、重新连接或另装副本提示时，停止并核对目标，不盲目重装。前后核对账号字段、相同key的saved状态及数据身份。get_status显示config_visibility=not-included时，说明没有提供全局配置，不能将空请求列表推断为配置已被清空。

## 真实宿主代码的隔离回归

仓库不包含宿主bundle、运行配置、凭证、账号/设备标识或安装日志。scripts/installed-host-update.test.mjs读取调用者提供的、与实际执行版本匹配的宿主main bundle，使用合成manual/root记录及假密文，在临时目录执行该bundle中的来源分类、完整updateUnlocked文件置换/回执/归档逻辑和数据归档函数。

包检查/解压与无关UI服务使用适配器，因此它不是运行中Cindy的安装操作，也不宣称覆盖真实UI、包解压或全部OS异常。它比单纯把旧KV交给新插件的Mock迁移测试多验证了宿主是否先改变数据作用域。

PowerShell示例（路径由调用者选择，不写入仓库）：

    $env:CINDY_HOST_BUNDLE_PATH = 'matching-installed-host-main.js'
    node --test scripts/installed-host-update.test.mjs

当前回归包括：manual/root正常新版置换后KV、data防重及两条假加密key逐字相同、归档调用为零；不同来源触发真实归档逻辑；缺批准、身份/市场/可信签名变化不豁免；换源确认提示仍存在。

匹配宿主版本/源commit必须另核实，提取文件只在本地。若目标版本改变函数布局，测试会明确失败，应核对匹配实现后更新适配器，不能回退到无关main源码获得绿灯。日常插件单测仍为npm test；此回归按需显式运行。
