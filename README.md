# dsh-update-center

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

## 一键更新是怎么做的

1. 点击「立即更新」后，Host 把更新计划写到 `~/.dsh/dsh-update/plans/`，启动一个 detached 更新助手，然后自己退出；
2. 助手等 Web 端口释放后执行
   `npm install -g --no-fund --no-audit --prefix <npm 全局前缀> @deepseek-ai/dsh@<最新版本>`
   （放在旧进程退出之后，避免 Windows 上正在运行的 `.node` 文件被锁）；
3. 用原进程的启动参数重新拉起 `dsh web`，并轮询端口确认启动成功；
4. 页面断线后由 DSH 自带的连接恢复逻辑自动重连；新版本 Host 返回时，DSH 内置的「服务版本变化」对话框会提示刷新，刷新即进入新版本。

如果 npm 安装失败，助手仍会尽量按旧版本把 DSH 拉起来，并把错误与日志路径写回状态文件，
下次打开设置页可以看到「上次更新未完成」和日志位置。

日志：`~/.dsh/dsh-update/logs/update-*.log`；状态：`~/.dsh/dsh-update/state.json`
（`DSH_HOME` 存在时以它为准）。

## 安装

在 DSH Web 的 **设置 → 插件** 里添加，spec 填：

```
github:a1179162858-collab/dsh-update-center
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

## Credits

本项目的插件代码、文档、验证与发布流程，全部由 **DeepSeek-V4.1-Flash** 与 **DeepSeek Harness** 完成。

## License

MIT
