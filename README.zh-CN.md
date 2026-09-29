# 9router-go for DeepSeek Harness

[English](README.md) | 简体中文

独立的 DSH bundle：把未经修改的 [9router-go](https://github.com/luqman-v1/9router-go) 可执行文件作为仅监听回环地址的 sidecar 启动，校验上游 GitHub Release 下载内容，并可选地跟随新版本。**本包不包含**上游可执行文件及其 Dashboard。

## 许可与信任

开发期核对的结果：上游仓库没有 `LICENSE` 文件，GitHub 报告 `license: null`。它最初参考的 `decolua/9router` 采用 MIT，**并不**因此为这个 Go 实现确立许可。未经版权持有者许可，不要连同本 bundle 再分发上游可执行文件。启用 `autoInstall` 会有意在你的账号下下载并运行上游**未签名**的可执行文件；插件会校验其 GitHub Release 的 SHA-256 摘要与原生文件头，但这不能替代代码签名或安全审计。只有在你能接受上游项目的代码、各提供方条款及其许可影响时再使用。

## 安装

**桌面端用户请阅读 [INSTALL-DESKTOP.md](INSTALL-DESKTOP.md)**：Desktop 应用独占自己的 profile，`dsh` CLI 无法在其中安装，需要用它的 Plugins 页面或随包提供的安装脚本。

从 DSH 源码检出安装到已有的 Web profile（或由 `web` 模板新建的一次性 profile）：

```powershell
pnpm dsh plugin --profile web add ..\dsh-9router-go
pnpm dsh --profile web --dump-config
```

独立的 DSH CLI 安装可以针对源码检出使用 `dsh plugin --profile web add <插件绝对路径>`；包发布到该安装所解析的源之后，也可以用 `dsh plugin --profile web add dsh-9router-go`。本地链接的包只有在新增运行时导入时才需要自己的依赖；本 bundle 只用 Node 标准库加上宿主提供的 `subprocess` 服务。

### 桌面端

Desktop 应用独占 `$DSH_HOME/profiles/desktop`，`dsh --profile desktop` 会拒绝所有命令，包括 `dsh plugin`（[`args.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/cli/src/args.ts)）。请通过应用的 **Plugins** 页面安装，或运行随包提供的安装脚本——它对 profile 目录做的是同一件事：

```powershell
npx --yes dsh-9router-go install-desktop
```

两种方式都不会改动机器级的 npm 配置。细节（包括从本地检出安装、以及指向私有 registry）见 [INSTALL-DESKTOP.md](INSTALL-DESKTOP.md)。

照常启动该 profile。用 `/9router-go` 命令打开 Dashboard——在 Desktop 上它会加载到侧栏 Browser；也可以直接访问 `http://127.0.0.1:20130`。Desktop 默认挂载该 Browser 标签类型，Web profile 不挂载，因此该命令在 Web 下会显示为不可用。Dashboard 里的 OAuth、下载与弹窗仍然需要系统浏览器。

浏览器启动行不携带插件配置，所以该命令的目标地址是 `client.js` 里的 `DASHBOARD_URL` 常量。因此修改 `port` 时还要同时改这一行；当配置的端口与之不一致时，DSH 会输出警告。

Dashboard 的初始密码保存在 `<DSH_HOME>/9router-go/initial-password`，不会打印到日志。首次登录后请在 Dashboard 中修改。

### 接入 DSH 模型

插件在首次激活时会把自己发布为 DSH 模型提供商，通常无需手工配置。它会从数据目录推导网关的本地 CLI token，创建一个名为 `dsh-9router-go` 的 API Key，通过 DSH 凭据 seam 以 `NINEROUTER_GO_API_KEY` 存入，并追加一条 `llm-pi-ai` 路由，其模型列表来自网关报告的「已连接」模型。该写入是**追加式**的：已有提供商继续可用。若某适配器已提供该路由，这一步会成为空操作，因此重载不会反复改写你的配置。

等价地，你也可以在 **设置 → 模型** 中手工添加一个 **自定义模型 API** 提供商：

- 提供商 ID：`9router-go`
- 协议：OpenAI Chat Completions（`openai-completions`）
- API 基址：`http://127.0.0.1:20130/v1`
- 凭据引用：`NINEROUTER_GO_API_KEY`
- 模型 ID：运行中 Dashboard 里的一个真实 ID 或 combo 名，或取自其已鉴权的 `GET /v1/models`

不要新增第二个 `llm-pi-ai` 条目：每个实例都会宣告完整的内置目录，两个实例会冲突，而且模型页面只会编辑 id 为 `llm-pi-ai` 的那个条目。停用插件会保留已注入的路由；不再需要时请在模型页面中删除它。

## 运行时配置与更新

本 bundle 的条目 ID 是 `9router-go`。需要换端口或数据目录时，在 profile 的 `cordis.patch.yml` 中覆盖它的**整个** config：

```yaml
- id: 9router-go
  config:
    port: 20130
    rootDir: C:\Users\example\9router-go-data
    autoInstall: true
    autoUpdate: true
    checkIntervalHours: 6
    startupTimeoutMs: 30000
    shutdownGraceMs: 5000
    provider:
      autoInject: true
      routeName: 9router-go
      settingsNamespace: llm-pi-ai
      apiKeyEnv: NINEROUTER_GO_API_KEY
      keyName: dsh-9router-go
      maxModels: 40
      inputModalities:
        - text
```

`rootDir` 默认是 `<DSH_HOME>/9router-go`；运行时、数据、Dashboard 密码和版本指针都在那里，与 npm 插件分离。启动时，`autoInstall: true` 会在不存在受管版本时下载一个经过校验的官方 Release。`autoUpdate: true` 每 `checkIntervalHours` 检查一次 GitHub Releases，并在停止旧进程后切换到经过校验的更新二进制；默认 `false` 会保持已安装版本，直到你显式开启更新。宿主插件可以声明 `inject = ['nineRouterGo']`，并调用 `ctx.nineRouterGo.checkUpdate()` 或 `await ctx.nineRouterGo.update()` 手动检查或更新；该服务还暴露 `endpoint`、`version`、`running` 和 `dataDir`。DSH 界面中没有专门的更新按钮。显式配置了绝对路径的 `executable` 会关闭受管升级，由你自己安装和更新 9router-go。

`provider.autoInject` 在代码中默认为 `false`，由本 bundle 的补丁开启。`settingsNamespace` 必须指向拥有这些路由的 profile 条目（即随包提供的 `llm-pi-ai` 条目）；`routeName`、`apiKeyEnv`、`keyName` 分别指定注入的路由、其凭据引用和网关 API Key。`maxModels` 限制列出的已连接模型数量；`inputModalities` 声明这些模型接受什么，因为网关的目录不报告模态——随包的 `text` 默认值会拒绝图片，而不是把一个提供方可能中途拒绝的请求发出去。

升级时，插件保留 `<rootDir>/data`，暂存新二进制，等待旧的受管进程退出，在 `<rootDir>/backups` 下复制已静默的数据目录，然后在写入新的活动版本指针之前检查 `/health`。备份失败会中止升级并重启旧二进制。如果升级后的进程未通过就绪检查，插件会等待其退出，恢复升级前的数据快照并重启旧二进制；它把被修改的目录保留为 `<rootDir>/failed-upgrade-*` 以便恢复。新进程在就绪失败之前接受的请求可能在这次恢复中丢失。备份或恢复失败会在磁盘上留下诊断数据，并可能阻碍自动恢复。备份会一直保留到你手动删除；在开启无人值守更新之前，请另外保留一份异地备份。切勿让两个活动实例共用同一个数据目录。插件会占据 `.dsh-owner` 目录锁；主机异常崩溃后，请先确认旧进程已退出，再手动删除陈旧的锁。

上游应用自身的 `AUTO_UPDATE` 环境变量被设为 `false`，但它持久化的 Dashboard 设置可以重新启用其就地更新器；请保持 Dashboard 的自动更新开关为**关闭**。上游的 `version.json` 当前指向的是一次 Release 落地页而非平台可执行文件，所以本插件改用 GitHub Release 资产及其摘要。本插件不代理 Dashboard，也不把它的凭据暴露在 DSH 源上。网关使用其专用的回环端口；Codex OAuth 还可能占用 1455 端口。

## 测试

在本项目中运行 `npm run check`，覆盖语法、校验和、大小、原生文件头、所有权、生命周期、注入以及浏览器 bundle 的测试。真机集成测试请另建一个由 `web` 派生的 DSH profile，把本目录作为 bundle 安装，用另一个 DSH Web 端口启动该 profile（`--port 0 --no-open`），然后运行 `npm run test:live`。该冒烟测试会用私有的首次登录密码登录，创建一个临时 API Key，读取已鉴权的 `/v1/models` 列表，并在 `finally` 块中删除该 Key。通过 profile 补丁停用该条目，可以验证 DSH 会停止网关并释放其目录锁。实际下载需要能访问 GitHub；没有访问条件时，把 `autoInstall` 设为 `false`，并把 `executable` 指向由运维自行获取的绝对路径。

无需打开界面也能验证自动注入：profile 启动后，注入的路由会出现在 profile 的 `cordis.patch.yml` 中 `settingsNamespace` 条目下，凭据会出现在 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下，而所服务页面的 `window.__DSH_BOOT__` 图中会列出 `dsh-9router-go` 行，其 `/plugins` 下的 `client.js` 会返回该 bundle。
