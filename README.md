# dsh-update-center

**中文** | [English](README.en.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 界面加一个「更新中心」的插件：

- **设置 → 通用**：新增「DSH 更新」一行，显示当前版本 / 最新版本，支持检查更新、一键更新，
  以及**可展开/收起**的「更新重点」（解析 GitHub Releases 的中文更新说明，列出当前版本到最新版本之间的所有版本）；
- **主界面左下角**：检测到新版本时弹出小窗口询问是否更新，可以「立即更新」「忽略此版本」「稍后」，
  更新重点同样支持放大展开 / 缩小隐藏；
- **每次打开页面**自动检查一次 npm 上 `@deepseek-ai/dsh` 的 `latest`（Host 侧有 10 分钟缓存，不会频繁打网络）。

> 界面语言跟随 DSH 的语言设置（内置中文 / English 字典）。

## 界面与行为

| 位置 | 内容 |
| --- | --- |
| 设置 → 通用 | 当前版本、最新版本；检查更新；一键更新；忽略此版本 / 取消忽略；更新重点展开 |
| 左下角弹窗 | 新版本号、当前版本、「更新重点」折叠区、立即更新 / 忽略此版本 / 稍后；更新中显示进度提示 |
| 忽略语义 | 按版本号忽略：忽略 `v0.2.1-rc.5` 后不再为它弹窗，新的版本出现时仍会提醒 |

更新说明来自 `github.com/deepseek-ai/deepseek-harness` 的 `dsh-v*` Release 正文；只解析中文段落。
GitHub 不可达时仍会提示更新，只是「更新重点」显示为空。

## 一键更新是怎么做的（v1.3.0：先下载到隔离目录，再本地切换）

更新分成两个阶段，**联网安装永远不碰正在运行的安装目录**：

**阶段 1 — 下载并校验（DSH 照常使用）**

1. 点「检查更新 / 更新」后，Host 把计划写到 `~/.dsh/dsh-update/plans/`，启动 detached 的
   `stage-helper.mjs`，自己**不退出**；
2. helper 拿 `update.lock` 独占锁，执行
   `node <npm-cli.js> install -g --no-fund --no-audit --fetch-timeout=60000 --fetch-retries=5 --prefix <隔离目录> @deepseek-ai/dsh@<最新版本>`；
3. 下载有进度就自动续期，**10 分钟无输出或累计 45 分钟**才判定卡死，并 `taskkill /T /F` 杀掉整棵 npm 进程树；
4. 校验隔离目录里的 `lib/bin.js`、`package.json` 版本，并跑一次 `node bin.js --version`；
   失败就删掉隔离目录——**正式安装一个字节都没动，DSH 也不停**；
5. 成功后在 `state.json` 记录 `staged: { version, dir }`，页面出现「新版本已就绪」和
   **「重启并应用」**按钮（这就是你要求的“点一下再切换”）。

**阶段 2 — 切换（几秒钟，和手动回滚同一套动作）**

1. 你点「重启并应用」→ `switch-helper.mjs` 拿锁，确认旧 Host 进程已退出（不退出就放弃、不改任何文件）；
2. 当前安装目录改名成 `dsh.bak-<时间戳>`（保留），隔离目录里的 `dsh` 改名进正式位置；
3. 启动新版本，要求**连续监听 6 秒**才算成功；
4. 起不来 → 杀掉新进程 → 把备份改回来 → 拉起旧版本，`state.json` 记 `rolled-back`。

### npm 为什么要用 `node + npm-cli.js` 而不是 `npm.cmd`

更新助手是没有控制台的 detached 进程。在这种环境里 spawn Windows 的 `npm.cmd` 会立刻失败并打印
`指定的网络名不再可用。`（`ERROR_NETNAME_DELETED`），npm 一行都没跑——2026-11-05 的 11:17 与 11:37
两次更新都是这么失败的（同样的命令在普通终端里正常）。改用 `node <nodejs>/node_modules/npm/bin/npm-cli.js`
（`shell: false`）后一次成功：`added 616 packages in 1m`。
`npm-invocation.mjs` 负责这个选择，Host 与两个 helper 共用。

为什么不再“就地安装”：2026-11-09 的更新就是 npm 下载卡住 15 分钟被强杀，随后删半成品目录和
还原备份都遇到 `EPERM`，把 DSH 留在缺失状态。隔离安装让这类环境问题最多变成“这次没更新成功”。

其他护栏：隔离安装需要约 2 GiB 空间（不足直接拒绝）；`state.json` 全程**原子写入**；
设置行和左下角弹窗在下载/切换期间禁用按钮并显示进度。

日志：`~/.dsh/dsh-update/logs/stage-*.log`、`switch-*.log`；状态：`~/.dsh/dsh-update/state.json`
（`DSH_HOME` 存在时以它为准）。回归测试：
`node scripts/helper-safety-tests.mjs`（19 项，旧就地助手）与
`node scripts/staged-update-tests.mjs`（17 项，隔离安装 + 切换 + 回滚），都在系统临时目录里跑，
不接触真实 DSH。

## 安装

在 DSH Web 的 **设置 → 插件** 里添加，spec 填：

```
github:HansyLin-xCoFe/dsh-update-center
```

或者使用 `plugin_manager` 工具 / 插件管理器的安装入口，target 同样填上面这个地址。
安装后插件会自动出现在「设置 → 通用」和左下角，无需改 `cordis.patch.yml`。

本地开发时也可以直接 link 这个目录（package 根目录），改完重启 `dsh web` 即可加载新的 Host 半。

要求：DSH `>= 0.2.1-rc.2`（Web 形态），Node 18+，npm 在 PATH 中且对 npm 全局前缀有写权限。

## 安全边界

- `/dsh-update/*` 只接受**直接 loopback** 且同源（`Host` 必须是 127.0.0.1 / localhost / [::1]，
  带 `Origin` 时必须与 `Host` 一致）的请求，其他来源返回 403；
- 更新动作只执行写死的 npm 全局安装命令，不接受客户端传任意命令或任意版本；
- 不会读取或上传任何 DSH 会话内容；只读取本机 DSH 安装的版本、npm registry 与 GitHub Releases。

## 开发

```
plugin/
├─ package.json          # dsh.bundle.patch + dsh.client 声明
├─ cordis.patch.yml      # 插入 Host 行
├─ index.js              # Host 半：版本比较、npm / GitHub 查询、忽略状态、更新计划
├─ client.js             # Client 半：General 设置行 + 左下角弹窗
├─ update-helper.mjs     # detached 更新助手
├─ locale/{zh,en}.json   # 插件显示元数据
└─ icon.svg              # 插件图标
```

无构建步骤，全部是原生 ESM / 浏览器 JS。Host 半修改后需要重启 DSH；Client 半会被 HMR 热更
（最稳是刷新页面）。插件 Config 未暴露可调项，更新源常量在 `index.js` 顶部
（`REGISTRY_LATEST_URL` / `RELEASES_URL`）。

## 更新记录

- **1.3.0**（2026-11-09）：更新改为**隔离安装 + 手动切换**。下载/校验在独立的 `.dsh-stage-*` 目录完成，
  DSH 继续运行；校验通过后页面出现「重启并应用」，切换只做本地改名（约 10 秒），失败自动换回旧版本。
  联网安装不再触碰正式安装目录，网络卡死/半成品/EPERM 最多导致“这次没更新成功”，不会再删坏 DSH。
  新增 `stage-helper.mjs`、`switch-helper.mjs`、`update-common.mjs`，回归测试 17 项。
- **1.2.0**（2026-11-05）：修好「一键更新在无控制台环境下起不来 npm」的根因 —— 改用
  `node + npm-cli.js`（`shell:false`）而不是 `npm.cmd`，并让助手自动改写旧版本 Host 写下的
  `npm.cmd` 计划；`state.json` 改为原子写入；新增 npm 调用方式、锁竞争、回滚、宿主不退出等
  19 项回归测试。
  **真机验证**：2026-11-05 11:57，在本机从 `0.2.1-rc.4` 点「一键更新」成功升到 `0.2.1-rc.5`
  （`state.json` 记录 `phase: done, ok: true`，约 40 秒完成 npm 安装）。
- **1.1.0**（2026-11-05）：安全加固 —— 单实例锁、旧进程退出校验、安装目录先备份后安装、
  安装失败与启动失败自动回滚、磁盘空间检查、npm 超时，以及「另一个更新正在进行」的 UI 提示。
  修复 2026-11-05 两个并发 `npm install -g` 删掉全局安装的事故（复盘见
  `projects/dsh-update-center/docs/incident-2026-11-05-global-install-deleted.md`）。
- **1.0.0**（2026-11-03）：首个版本：设置通用页 + 左下角弹窗、检查更新、更新重点、忽略版本、一键更新。

## Credits

本项目的插件代码、文档、验证与发布流程，全部由 **DeepSeek-V4.1-Flash** 与 **DeepSeek Harness** 完成。

感谢 **@核动力浅水重炮舰** 提供的 token —— 首次发布与 v1.2.0 版本推送靠它完成。

## License

MIT
