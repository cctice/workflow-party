# kfc-flow-router

内部路由推进器，负责个人 KFC 的 workflow 状态、阶段 catalog、动态 worker 注册和产物记录。

状态写入工作目录 `.kfc/`；用户级 registry 写入 `KFC_CONFIG_HOME` 或 `~/.config/kfc-plugin/`。依赖检查只读并且不会自动安装任何包。

```bash
node kfc-flow-router/scripts/kfc.js route --root <dir> --material "<text>"
node kfc-flow-router/scripts/kfc.js continue --root <dir>
node kfc-flow-router/scripts/kfc.js complete --root <dir> --output-path <path> --purpose "<purpose>"
```
