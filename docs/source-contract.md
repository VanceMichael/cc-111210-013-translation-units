# 展签翻译文件
`/labels.xlf?kind=first` 是XLIFF 2.0，含两个unit、已审与未完成segment、ignorable、不可翻译unit及originalData内联引用。`kind=changed` 保留unit ID但改变源文，`kind=broken` 令译文代码ID与源文不符。

二次交付演练来源：`kind=second`（译文保留/替换/新增）、`kind=split`（拆分片段，旧片段缺席转人工）、`kind=reuse`（另一文件复用unit ID）、`kind=cross`（sc/ec跨片段配对、ph隔离引用与扩展命名空间）、`kind=substate`（未完成子状态不得覆盖已审核版本）。

## 接收规则

接收保持 XML 结构，不把内联代码当普通字符串剥除：

- `segment` 与 `ignorable` 的文档顺序、片段 ID 与序号一并保留；纯文字视图只移除代码标记，代码包住的文字仍属于展签文字，完整结构保留在 canonical XML 与源文指纹中。
- 内联代码 `pc`（成对）、`ph`（隔离）、`sc`/`ec`（可跨片段按 `startRef` 配对）先在 unit 内校验 ID 唯一、`originalData` 引用可解析、配对闭合，再逐片段核对译文代码的身份、类型与 dataRef；任何不符判为结构不合法，阻止录入并保留旧译文。
- `state`（initial 或缺失/未知为未完成，translated/reviewed/final 为完成）与 `subState`（draft、mt-suggestion 等草稿取值）共同决定闸门；`translate=no` 沿 file → unit → fragment 继承。未完成译文即使含文字也不能覆盖已接收的已审核版本。
- 命名空间按 Clark 记法区分：非 XLIFF 命名空间元素（如 `m:note`）整体保留为来源，不与同名 XLIFF 元素混用；`notes`、`originalData` 与原始引用全部留存。
- 跨交付以“文件身份（file id、original、命名空间声明）+ unit + 片段（种类与 id/序号）+ 源文指纹”四要素定位。源文指纹变化、片段缺席、结构不合法、不可翻译标记均阻止自动沿用旧审核结论，标记 `blockedPending` 等待人工确认；只有四要素一致且新译文完成时才替换，并在 provenance 中留存被替换版本。

接收结果分三类：`accepted`（已接收）、`pending`（待翻译/待人工确认）、`invalid`（结构不合法）。每条裁决附带机器可读 `code` 与中文 `message`，说明保留、替换或阻止的原因。
