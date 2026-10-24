# kfc-custom-step-manager

管理 KFC 用户级自定义阶段步骤的专用 skill。

## 能做什么

- 查看某阶段 effective steps。
- 新增用户步骤。
- 覆盖系统步骤字段。
- 调整用户步骤或覆盖步骤的顺序。
- 重置系统步骤上的用户覆盖。
- 删除用户新增步骤。

## 关键原则

AI 不能直接编辑用户步骤注册表文件，必须调用 `kfc.js steps ...` 命令。

`/kfc 自定义步骤` 应先进入本 skill，再通过 schema、list、preview、apply 的顺序和用户确认协作完成配置。
