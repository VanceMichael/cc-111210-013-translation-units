# 多语种展签的翻译单元接收

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次查看，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

翻译单元接收使用 `GET /ingest?kind=first&label=首轮交付`：解析 XLIFF 2.0 并返回三类分桶（`accepted` 已接收、`pending` 待翻译/待人工、`invalid` 结构不合法），每条片段附原因代码与中文说明。多次交付在服务端累积裁决，`GET /registry` 查看当前注册表与每轮 `received/retained/replaced/blocked` 历史；注册表带 sha256 校验落盘，重启后恢复。

`src/xliff.mjs` 负责保留顺序与命名空间的解析、内联代码（pc/ph/sc/ec）身份与配对校验、源文指纹；`src/reception.mjs` 按 state/subState/translate 闸门分桶并留存 notes 与 originalData；`src/registry.mjs` 按文件身份、unit、片段与源文指纹做跨交付裁决。`src/connector.mjs` 解释单次来源响应，`fixtures/source.mjs` 提供可重复启动的本地来源（含拆分、复用 unit、跨片段代码、子状态等演练 kind），`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`test/` 下覆盖解析原语、接收闸门、跨交付裁决与服务集成。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
