---
name: kfc-custom-step-manager
description: KFC skill。管理 KFC 用户级自定义阶段步骤：查看、预览、新增、调整、调序、重置和删除用户新增步骤。只能通过 KFC steps 命令操作注册表，不能直接编辑用户配置文件。
---

# kfc-custom-step-manager

## 使用边界

本 skill 只管理 KFC 阶段内步骤，不新增阶段。

AI 不得直接编辑用户步骤注册表文件。所有查看、预览、写入和删除必须通过 KFC 路由推进器的 `steps` 命令完成。

用户步骤注册表是用户级配置，和 KFC 本体分离；KFC 更新不应覆盖用户自定义步骤。

## 固定流程

1. 先调用：

```bash
node <kfc wrapper>/scripts/kfc.js steps schema
node <kfc wrapper>/scripts/kfc.js steps list --stage <stage>
```

2. 根据用户自然语言判断操作类型：
   - 查看当前步骤。
   - 新增步骤。
   - 调整已有步骤。
   - 移动步骤顺序。
   - 重置用户覆盖。
   - 删除用户新增步骤。

3. 对会写入配置的操作，先 preview：

```bash
node <kfc wrapper>/scripts/kfc.js steps add ...        # 不带 --apply
node <kfc wrapper>/scripts/kfc.js steps update ...     # 不带 --apply
node <kfc wrapper>/scripts/kfc.js steps move ...       # 不带 --apply
```

4. 向用户解释 preview 影响，必须说明：
   - 目标阶段。
   - 目标步骤。
   - 是新增、覆盖还是调序。
   - 默认 skill 和候选 skill。
   - 产物用途。
   - 是否影响当前流程推进顺序。

5. 用户确认后才加 `--apply`。

6. apply 后必须再次调用 `steps list --stage <stage>` 展示 effective steps。

## 命令约束

- 新增步骤必须至少包含：`stage`、`step_id`、`default_worker`、`output_purpose`。
- 覆盖系统步骤必须至少包含：`stage`、`step_id`。
- 调序只使用 `--before <step>` 或 `--after <step>`。
- `steps remove` 只能删除用户新增步骤，不能删除系统步骤。
- `steps reset` 用于清除用户对系统步骤的覆盖。

## 输出要求

用户可见输出必须包含：

- 产物路径或配置路径。
- 产物作用。
- 当前 effective steps 结果摘要。
- `produced_by: kfc-custom-step-manager`
