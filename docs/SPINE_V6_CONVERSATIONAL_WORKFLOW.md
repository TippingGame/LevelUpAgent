# Spine V6 工作流审计：会话驱动的拆层、骨骼与动作

## 目标与现状

本轮把用户目标拆成四条可以在同一个 Spine 工作台内完成的链路：

1. 上传本地整图，或从已配置的生图历史选择/生成整图。
2. 让会话模型提出任意角色或物体的部件计划，再逐件生成贴图；也可以把整图交给本机 ComfyUI 拆层节点，审阅图层后创建工程。
3. 在同一会话中附上原图、当前装配、分件枢轴图和动作采样，让 AI 提出骨骼、绘制顺序和动作 JSON；应用前由工程校验器拒绝未知部件、循环父子关系、越界关键帧和超限数据。
4. 在多图姿态研究中导入、生图或使用本地 RIFE 参考帧，先识别/拟合/人工确认，再生成可编辑 Spine 骨骼曲线。

## 可复现入口

- 工作台：`src/components/SpineStudio.tsx`
- 会话：`src/components/SpineAssistantPanel.tsx`、`src/lib/spineAssistant.ts`
- 贴图和抠图：`src/lib/spineSource.ts`、`src/lib/spineMatting.ts`
- 本机拆层：`src/components/SpineComfyPanel.tsx`、`src/lib/spineComfy.ts`、`src-tauri/src/spine_comfy.rs`
- 姿态研究：`src/components/SpineMotionStudyPanel.tsx`、`src/lib/spineMotion.ts`
- RIFE：`src/lib/spinePixelInterpolation.ts`、`src/lib/spineBridge.ts`、`src-tauri/src/spine_rife.rs`

会话提案不会自动覆盖工程：响应先解析为受限 JSON，再经过工程校验，最后由用户点击应用。新部件计划和已生成贴图使用不同 ID；工程变化、切换动作或源图变化会使迟到提案失效。RIFE 批次同样保存端点快照，失败整批不写入，停止只保留当前已完成帧。

## 真实验证证据

- 用户图 `G:\Work\LevelUpAgent\杂项文件\Q版单人.png`：真实工作台上传、纯色背景处理、8 件部件生成、重绘审阅、会话动作、刷新恢复和 ZIP 导出。交付在 `安装包/Spine测试样例/Q版单人/`。
- `gpt-image-2` 任意对象样例：阔叶树、垂柳、橘猫、蓝色小鸟；每个样例均有部件、动作接触表、GIF、自包含工程和 Spine 4.2 runtime 验证，详见 `docs/SPINE_V4_SPECIES_VALIDATION.md`。
- 机械猫头鹰钟：4 件拆层、两端姿态约束、多图识别/拟合、可编辑动作和 7,200 个 runtime 坐标样本，详见 `docs/SPINE_V5_IMPLEMENTATION_LOG.md` 和 `安装包/Spine测试样例/机械猫头鹰钟/`。
- 本地 RIFE：RTX 3080 Ti 上实际运行 `rife-ncnn-vulkan` + `rife-v4.6`，机械钟 7 张、小鸟 3 张 RGB 参考帧成功；UI 回归覆盖失败原子性、停止和上下文切换。证据在 `research/spine-animation-2026-10-03/verification-v5/`。

## 仍需明确验收的边界

- ComfyUI See-through 的真实 GPU 拆层尚未在本机环境运行；当前真实树木和动物样例使用会话规划加 `gpt-image-2` 逐件生成，不能把它们描述成 ComfyUI 自动拆层结果。
- RIFE 输入透明区域会合成浅灰并输出 RGB；它是动作参考，不是透明视频或最终贴图。
- 当前导出已由官方 Spine 4.2 runtime 解析和渲染验证，但没有可用的 Spine 编辑器来完成导入、修改、另存、重开回环。
- 固定平面贴图、遮挡补绘和大角度转身仍需人工审阅；轮廓 loss 改善不能证明骨骼角度或跨帧身份正确。

## 本轮检查

2026-10-05 收尾时，V5 代码与文档应通过：

```powershell
pnpm check
pnpm build
node scripts/test-spine-v5-ui.mjs http://127.0.0.1:1433
cargo test --manifest-path src-tauri/Cargo.toml spine_rife --lib
git diff --check
```

安装包和 SHA 清单不因本轮文档及代码提交自动更新；若重新构建，必须重新计算 `安装包/SHA256.txt` 与 `安装包/SHA256_1.1.65.txt`，并保留唯一当前 EXE 记录。
