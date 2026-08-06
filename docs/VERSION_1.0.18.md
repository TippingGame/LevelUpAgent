# LevelUpAgent 1.0.18 版本说明

## 星图蓝图

- 将写作、图像、视频和语音四项标准能力组合成类型安全的 DAG 工作流。
- 支持点击或拖动端口连线、重连、无效连接提示、框选、批量移动、复制、自动整理和撤销/重做。
- 框选节点可保存为个人蓝图；蓝图只保留内部连线，插入时为节点和边生成全新 ID。
- 内置灵感成片、有声故事卡、智能扩图和蒙版局部重绘流程。

## 画板与媒体体验

- 画板支持标签、笔刷、擦除、撤销/重做、缩放、平移、适应窗口、实际大小和四周扩边。
- 画板输出独立的透明 PNG mask，OpenAI-compatible 图片编辑会以独立 `mask` 字段提交。
- 图片预览和画板拖拽改用 `requestAnimationFrame` 与 GPU transform，减少高刷新率显示器下的卡顿。
- 窄屏自动收起侧栏，节点库和蓝图库以抽屉方式打开；隐藏面板不会进入键盘焦点顺序。

## 文档与验证

- 中英文首页 README 重构，并加入真实星图与创作空间截图。
- 新增 Image Studio 能力审计与星图协议文档。
- `pnpm check`、Rust 测试、生产构建和 Windows x64 Release 打包均通过。

Windows 发布资产由 GitHub Actions 使用既有 Tauri updater 私钥签名；这不等同于 Authenticode，安装包仍可能触发 SmartScreen。
