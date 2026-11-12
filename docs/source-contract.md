# 展签翻译文件
`/labels.xlf?kind=first` 是XLIFF 2.0，含两个unit、已审与未完成segment、ignorable、不可翻译unit及originalData内联引用。`kind=changed` 保留unit ID但改变源文，`kind=broken` 令译文代码ID与源文不符。
当前查看器只枚举文件与unit，不接收或替换译文。后续对命名空间、修订状态和内联代码的处理必须保持XML结构，不得将其当作去标签字符串。
