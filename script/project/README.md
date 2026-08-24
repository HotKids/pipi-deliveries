# Pipi Deliveries for Scripting

Pipi Deliveries for Scripting 是 Pipi Deliveries 的 iOS 脚本版。当前测试版为 `0.5`，快递状态、排序、缓存周期及查询优先级以 Android `v1.2.13` 为基线。

## 功能

- 绑定手机号并通过统一账号通道同步关联快递；
- 输入运单号查询快递，在需要时补充收寄件手机号后四位；
- 手动查件保留专用查询能力，并在无结果时使用 K100 兜底；
- 对同一查询来源的物流轨迹进行增量合并，已签收状态不会被后续非签收结果回退；
- 京东、菜鸟等账号快递优先使用接口 5 返回的本地物流轨迹；顺丰来源由手动/K100 查询链补全状态与轨迹；
- 未产生物流轨迹的手动查询进入本地队列，出现有效轨迹后再加入列表；
- 已签收快递保留七日，已取消快递保留四小时；签收满二十四小时后停止主动刷新；
- 支持应用内列表、物流详情、状态变更通知、快捷指令及 App Intent 刷新；
- 快递列表支持右滑标记签收、左滑删除，并在执行前进行确认；
- 提供仅保存在本机的诊断日志，可在设置中查看、复制或清空；
- 提供 Small 状态概览和 Medium 三行物流动态主屏幕小组件；
- 使用 Android 版同源的本地承运商图标，不加载在线图标。

## 安装

1. 在 iPhone 或 iPad 上安装 Scripting；
2. 导入 `pipi-deliveries.scripting`；
3. 运行“派派助手”，按提示允许剪贴板与文件访问，并在“设置”中保存 16 位 Access Key；
4. 在“管理账号”中添加手机号，或直接在首页输入运单号查询；
5. 在主屏幕添加 Scripting 小组件，并选择“派派助手”。

测试阶段的 Access Key 由项目维护者提供。KDBot 接入后，管理员及白名单用户可通过 `/token` 获取当前账户唯一的 Access Key；重新生成后旧 Access Key 立即失效。

## 隐私说明

手机号绑定与快递查询所需的完整手机号、短信验证码、随机安装身份、运单号、手机号尾号及必要的运单摘要会经 Cloudflare Worker 临时中转至相关服务。Worker 按当前设计不持久化保存上述业务请求内容，项目不运行独立的数据存储服务器，也不将这些数据用于快递查询之外的用途。

Access Key、手机号绑定记录、快递列表与物流缓存均保存在本机。为保证覆盖导入后仍可恢复，Access Key 会写入当前脚本的 Keychain 与 App Group 本地恢复文件；旧版本曾使用的 Scripting 共享本地存储仅在迁移时读取，并在迁移成功后移除。业务状态写入 App Group 本地目录，详情路由仍只保存在 Keychain。测试包不包含固定 Access Key、上游凭据或私钥。

App Group 本地恢复文件可由同一设备上的其他 Scripting 脚本读取。因此，纯脚本版本无法在“覆盖导入后自动恢复 Access Key”的同时，提供独立原生应用级别的 Keychain 隔离。

更新或重新导入同名脚本时，Access Key、手机号绑定记录、快递列表、物流缓存、待查队列及本地诊断日志会继续保留；只有执行对应的移除、解绑或删除操作时，才会删除相应数据。

诊断日志仅记录接口类型、状态版本、绑定数量、耗时及错误类别，最多保留一百条且七日后自动过期；不记录手机号、验证码、Access Key、运单号或网络响应正文，也不会自动上传。

## 平台限制

- WidgetKit 的刷新时机由 iOS 调度，不能保证严格的固定周期；需要立即更新时可运行应用、快捷指令或 App Intent；
- Medium 小组件最多显示三条物流动态，桌面小组件内不能上下滚动；
- 购物订单会在前台同步期间通过隔离的临时 WebView 尝试提取真实运单号；页面未返回、超时或服务规则变化时会保留原订单卡片，稍后同步时重试；
- 本项目运行于 Scripting 宿主内，不是独立 IPA；Access Key 用于访问控制，无法作为“脚本源码未经修改”的不可伪造证明。

## 共同迭代

`contracts/express-policy.v1.json` 是为 Android 与 Scripting 共同维护预留的行为契约，集中记录状态文案、排序、保留周期、查询队列、承运商查询代码、手机尾号规则、图标映射及小组件容量。`contracts/fixtures/` 保存跨端回归样例；当前 Scripting 测试版已直接使用由该 JSON 生成的 `express-policy.generated.ts`。脚本端通过独立适配层固定账号同步通道，同时保留手动查件所需的专用查询能力，避免影响 Android 的共享契约。

修改共享规则后，运行：

```sh
node tools/generate-contract.mjs
sh tools/test.sh
```

生成测试包：

```sh
sh tools/package.sh
```

界面、Keychain、WidgetKit 及通知等平台能力仍分别由 Android 和 Scripting 的平台层实现；承运商图标与业务契约保持同源。

## 项目结构

```text
assets/            Android 同源承运商图标
components/        共用快递行与图标组件
contracts/         跨端行为契约与回归样例
pages/             首页、详情、手机号管理与设置
services/          状态、存储、绑定、查询、同步与凭据
widget/            Small / Medium 小组件
app_intents.tsx    App Intent 刷新入口
intent.tsx         快捷指令刷新入口
index.tsx          应用入口
widget.tsx         小组件入口
script.json        Scripting 项目元数据
```
