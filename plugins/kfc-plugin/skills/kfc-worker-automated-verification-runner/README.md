# kfc-worker-automated-verification-runner

整理或执行自动化验证记录的 KFC skill。

## 适用场景

- 已有可执行的测试、检查或验证命令。
- 用户需要记录自动化验证过程和结果。
- 当前工作流需要把验证证据整理给后续复核或验收使用。

## 输入材料

- 验证目标、验证范围和执行入口。
- 测试命令、运行日志、失败信息或历史验证记录。
- 当前 KFC 阶段和工作流上下文。

## 输出产物

产物应说明验证入口、执行命令、结果摘要、失败项、未验证项和后续建议。用户可见输出必须包含：

- 产物路径
- 产物作用
- `produced_by: kfc-worker-automated-verification-runner`
