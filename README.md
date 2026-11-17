# RoleHaven

本地优先的角色扮演前端。零第三方依赖，`node server.js` 即开即用，数据全部是明文本地文件。

定位很明确：**只做角色扮演**。没有工具调用、没有联网检索、没有 Agent 编排，只负责把「角色 + 世界 + 对话 + 记忆」跑顺。

## 快速开始

1. 装 Node.js 18+（推荐 22）
2. 双击 `start.cmd`，或命令行 `node server.js`
3. 浏览器打开 <http://127.0.0.1:8787>
4. 在「参数」里填 DeepSeek API Key，然后导入或新建角色卡

> 端口被占用时 `start.cmd` 会直接打开浏览器；手动启动可用 `set PORT=8790 && node server.js`。
> 不要直接双击 `public/index.html` —— 那是服务端页面，会丢样式（页面内有明确提示）。

## 功能

**角色卡**　导入 PNG（内嵌 `chara`/`ccv3`）或 V2/V3 JSON；卡内 `character_book` 自动抽为世界书；可编辑全字段；导出 JSON / PNG（PNG 可选带走对话，文件名会标注）。

**世界书**　兼容 SillyTavern `entries` 结构，关键词触发 + 常驻条目，按 `order` 注入。

**对话**　开场白、swipe 多候选、编辑、回退到任意一条、多对话管理（置顶 / 分组 / 多选 / 删除 / 分享）。

**深度思考**　使用 `deepseek-reasoner` 时，思考过程以可折叠块展示（流式展开、完成后收起），并随消息保存。

**群聊**　多角色轮询、随机或手动指定下一位发言者；提示词按角色拆分以节省 token。

**长上下文记忆**　游标式摘要，把早期剧情压成「前情提要」注入系统提示词，被覆盖的消息不再重复发送。

**正则替换**　按顺序执行，可作用于用户输入或模型输出，支持试跑。

**导出**　TXT / Markdown / JSONL / 单文件 HTML（分享用）/ PNG 角色卡。

## 数据与隐私

- 全部数据在 `data/`：`cards/` `worlds/` `chats/` `groups/` `folders.json` `regex.json`
- 服务只监听 `127.0.0.1`，并校验 `Host` 头
- API Key 只存在本地 `config.json`，接口返回时脱敏
- 导出 PNG 默认只含角色信息；要带对话必须显式确认，文件名会标注「含对话」

## 配置

首次运行**不需要任何配置文件**：没有 `config.json` 时使用内置默认值，在界面「参数」里保存后才会生成。

仓库提供 `config.example.json` 作为字段参考。`config.json` 与 `data/` 都已写进 `.gitignore`，
不会被提交——这两处正是 API Key 和对话记录所在。

## 兼容性

可直接读取 SillyTavern 的角色卡（PNG 或 JSON）与世界书；导出的 JSONL 与 PNG 卡也能被 SillyTavern 识别。

## 版本与变更

- `VERSION` 是版本号唯一来源，界面与 `GET /api/version` 都读它
- 每个版本的改动与原因写在 `CHANGELOG.md`
- `data/` 与版本解耦，升级不覆盖用户数据

## 测试

两套测试都是自包含的：自动起一个「临时数据目录 + 随机端口」的独立实例，跑完销毁，不碰你的 `data/`。

```bash
node test/smoke.js      # API 层，35 项
node test/ui-smoke.js   # UI 层（Chrome CDP 驱动真实浏览器），15 项
```

## 许可

MIT。界面交互与部分产品思路借鉴自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT, Copyright © 2026 DeepSeek），
后端、数据层、角色卡/世界书/群聊/记忆/正则等模块为本项目自研。详见 `LICENSE`。
