# koishi-plugin-runtime-guard

## 项目介绍

这是一个为 Koishi 机器人框架开发的**运行时健壮性与性能守护插件**，包含 6 个相互独立的守护模块。

| 守护 | 缺陷 | 后果 |
|------|------|------|
| `queue` | `cancelQueued()` 直接丢弃任务队列，Promise 既不 resolve 也不 reject | 调用方永久挂起，内存泄漏 |
| `queue` | 发送当前消息与调度下一条并行调度 | 慢速平台上消息乱序（koishi#1402） |
| `observe` | `observeUser/Channel` 遇未结算 diff 时直接 `throw` | 整条消息处理链崩断 |
| `flush` | `_handleMessage` 收尾三次 `$update()` 串行无隔离 | 首个失败即丢失后续全部写入 |
| `console` | 控制台消息直接 `JSON.parse` 并展开调用 listener | 畸形消息产生未捕获 Promise 拒绝 |
| `console` | `notifier/button` 的 `actions[id]` 无存在性检查、无鉴权 | 任意客户端可触发他人回调并使处理崩溃 |
| `installer` | 并发安装无互斥 | 两个包管理器进程同时写 `package.json`，文件损坏 |
| `installer` | 安装失败后 `package.json` 不回滚 | 留下「声明了依赖但没装」的破损状态 |
| `installer` | 等待包管理器退出无超时 | 安装卡死时界面永久转圈 |
| `permission` | `Permissions.check` 每条消息对每条规则重跑正则 | 高频消息下的无谓 CPU 开销 |

## 项目仓库

- GitHub：https://github.com/Minecraft-1314/koishi-plugin-runtime-guard
- Issues：https://github.com/Minecraft-1314/koishi-plugin-runtime-guard/issues

## 快速开始

```bash
# 1. 进入 Koishi 控制台或项目工作区
# 2. 安装插件
npm i koishi-plugin-runtime-guard
# 3. 在 koishi.yml 中启用，无需任何配置，全部修复项默认开启
```

启用后启动 Koishi，日志出现下列内容即表示守护已注册：

```text
[I] runtime-guard active: queue, observe, permission
[I] runtime-guard waiting for optional plugins: flush, console, installer
```

### 依赖声明

| 守护 | 依赖插件 | 运行时探测的能力 | 缺失时行为 |
|------|----------|------------------|-----------|
| `queue` | 无（`koishi` 核心） | `ctx.koishi.session` | 跳过 |
| `observe` | 无（`koishi` 核心） | `ctx.koishi.session` | 跳过 |
| `permission` | 无 | `Permissions` | 跳过 |
| `flush` | 任一 `@koishijs/plugin-database-*` | `database` 写入方法 | 等待，插件加载后生效 |
| `console` | `@koishijs/plugin-console`、`@koishijs/plugin-notifier` | `console` 连接、`notifier` 动作表 | 等待，插件加载后生效 |
| `installer` | `@koishijs/plugin-market` | `installer` 安装器 | 等待，插件加载后生效 |

## 配置项说明

所有配置项在控制台配置页均有独立开关，`enabled` 默认为 `true`。程序化调用 `apply(ctx, {})` 时同样套用默认值，不会静默失效。

### 基本设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | `boolean` | `false` | 调试模式。开启后输出每个守护的安装详情、跳过原因与重试过程 |
| `queue.enabled` | `boolean` | `true` | 消息队列守护总开关 |
| `queue.sequential` | `boolean` | `true` | 严格按队列顺序发送，每条发完再等待 `delay`。关闭则退回 Koishi 原有的并发发送行为 |
| `observe.enabled` | `boolean` | `true` | 数据观察守护总开关 |
| `observe.recoverMergeConflict` | `boolean` | `true` | 遇到未结算 diff 时先落盘再重建缓存，取代直接抛错 |

### 调试模式

默认关闭。开启 `debug` 后，除启动汇总外还会输出每个守护实际替换的方法、被跳过的具体原因，以及数据库写入重试过程。排查「某个守护到底有没有生效」时使用。

```text
[I] runtime-guard:queue patched KoishiSession.cancelQueued and KoishiSession._next
[I] runtime-guard:observe patched 2 session observation method(s)
[I] runtime-guard:flush patched 2 database write method(s)
[I] runtime-guard:console notifier actions are validated and rate limited
[I] runtime-guard:console console payloads will be validated before dispatch
[I] runtime-guard:permission patched Permissions.check with per-entry match memoization
[I] runtime-guard active: queue, observe, flush, console, permission
[I] runtime-guard waiting for optional plugins: installer
[I] runtime-guard installer: waiting for plugin "@koishijs/plugin-market" (provides service "installer")
```

### 数据库写入

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `flush.enabled` | `boolean` | `true` | 数据库写入守护总开关 |
| `flush.retries` | `number` | `2` | 写入失败的重试次数 |
| `flush.retryDelay` | `ms` | `200` | 重试基础间隔，按次数线性退避 |
| `flush.throwOnFailure` | `boolean` | `false` | 重试耗尽后是否继续抛错。默认吞掉并记日志，保证后续 flush 不被中断 |

### 控制台

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `console.enabled` | `boolean` | `true` | 控制台守护总开关 |
| `console.guardNotifier` | `boolean` | `true` | 为通知按钮加存在性检查、异常吸收与限流 |
| `console.notifierRateLimit` | `number` | `10` | 单个按钮在窗口期内的最大点击次数，最小 `1`（设为 `0` 会屏蔽全部按钮） |
| `console.notifierRateWindow` | `ms` | `10000` | 限流窗口 |
| `console.maxPayloadSize` | `number` | `65536` | 单条控制台消息字节上限，超出直接拒绝，最小 `1`（设为 `0` 会拒绝全部消息） |

### 插件安装

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `installer.enabled` | `boolean` | `true` | 插件安装守护总开关 |
| `installer.timeout` | `ms` | `300000` | 等待包管理器退出的最长时间，最小 `1`（设为 `0` 会让每次安装立即超时） |
| `installer.rollback` | `boolean` | `true` | 安装失败（含抛异常）时把 `package.json` 逐字节还原为安装前快照；等待超时时跳过回滚，因为包管理器可能仍在写该文件 |

### 性能与限制

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `permission.enabled` | `boolean` | `true` | 权限性能守护总开关 |
| `permission.memoizeMatch` | `boolean` | `true` | 缓存权限模式匹配结果 |
| `permission.matchCacheSize` | `number` | `1024` | 单条目匹配缓存上限，满则整体清空 |

### 启动后只看到部分守护 active

属于正常行为。`flush` / `console` / `installer` 依赖可选插件提供的服务，对应插件加载后会自动激活。开启 `debug` 可在启动日志中看到每项守护的状态与等待原因。

## 项目贡献者

| 贡献者 | 贡献内容 |
|------|------|
| Minecraft-1314 | 插件完整开发 |

> 欢迎通过 Issues 或 PR 加入贡献者列表。

## 许可协议

本项目采用 MIT 许可证，详情参见 [LICENSE](LICENSE) 文件。

## 支持我们

如果这个项目对您有帮助，欢迎点亮右上角的 Star 支持我们！
