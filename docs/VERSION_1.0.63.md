# LevelUpAgent v1.0.63

## 修复重复回复

- 修复桌面会话结束时，同一回复的流式正文和最终消息偶发保存为两条记录的问题。
- 当最终回复或其附带数据较大时，前端现在会等待消息通道处理完成，再结束运行，保留原消息 ID、请求信息和 token 统计。
- 取消、运行失败和等待确认也使用同一套事件收尾机制；通道异常会明确报错，迟到消息不会在返回后继续改写会话。
- 保留正常多轮对话中的相同文字，不按正文全局去重；本版本不自动删除旧会话里的重复记录。
- 安装包发布者元数据统一为 `TippingGame`，不改变现有签名方式。

## 验证

- 新增 10 项事件收尾回归测试，包含成功、失败、取消、等待确认、异常和事件顺序。
- 使用隔离的真实 Tauri 桌面实例验证长正文、短正文加大体积附带数据；故意延迟最终事件后，保存、导出和重启恢复均只保留一次回复。
- 技术细节见 [Harness 事件交付诊断](HARNESS_EVENT_DELIVERY.md)。

## 下载与更新

- Windows x64：NSIS 安装程序、MSI，以及签名自动更新产物。
- macOS：Apple Silicon 和 Intel x64 DMG。
- Linux x64：AppImage、DEB、RPM。
- Windows 安装包没有 Authenticode 签名；macOS 使用 ad-hoc 签名、尚未公证。Windows 自动更新继续使用既有 Tauri updater 密钥。

## English

Fixes duplicate assistant replies caused by the desktop command completing before a large final message reached the frontend. Runs now wait for their ordered event channel to drain, including cancellation, failure, and approval outcomes. Message identity, provider metadata, and token usage are preserved. Existing duplicate history is not automatically removed.
