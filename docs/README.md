# 文档

当前应用版本：`1.3.73`。音频工作台及发布说明于 2026-10-10 更新；其余专题保留各自的验证日期。文档中的“支持”指代码具备该能力；外部模型可用性、实际质量和平台认证需分别验证。

| 内容 | 入口 |
| --- | --- |
| 全部功能、存储和限制 | [功能总览](FEATURES.md) |
| 会话、草稿、权限、Goal 与恢复 | [Agent 工作流](AGENT_WORKFLOWS.md) |
| Codex 核心工作流与剩余差距 | [替代能力审阅](REPLACEMENT_AUDIT.md) |
| 本轮问题、修改与验证 | [审阅记录](AGENT_REVIEW_2026-09.md) |
| 可重复基准与性能边界 | [性能](PERFORMANCE.md) |
| 主机、协议、数据与执行链路 | [架构](ARCHITECTURE.md) |
| 权限、凭据、文件与风险 | [安全审阅](SECURITY_AUDIT.md) |
| Skills、MCP、文件、联网、浏览器和进程 | [扩展与工具](SKILLS_AND_TOOLS.md) |
| 模型可调用的客户端能力 | [能力契约](CLIENT_CAPABILITIES.md) |
| 模型协议与平台路由 | [LevelUpAPI 兼容性](LEVELUPAPI_COMPATIBILITY.md) |
| 图片、视频与素材上传 | [媒体平台](MEDIA_PLATFORMS.md) |
| 本地音乐生成、试听、剪辑与独立资源下载 | [音频工作台](AUDIO_WORKBENCH.md) |
| DAG、蓝图、画板与蒙版 | [星图](CONSTELLATION.md) |
| Spine 骨骼动画、多图姿态、整图入口、拆层与本机任务恢复 | [Spine 工作台](SPINE_STUDIO.md)、[第二版实施日志](SPINE_V2_IMPLEMENTATION_LOG.md)、[第三版实施日志](SPINE_V3_IMPLEMENTATION_LOG.md)、[第四版实施日志](SPINE_V4_IMPLEMENTATION_LOG.md)、[树木与动物真实验证](SPINE_V4_SPECIES_VALIDATION.md) |
| 写作目标、参考库与恢复 | [写作 Goal](WRITING_GOAL_MODE.md) |
| 剧情图与试玩 | [剧情图](STORY_GRAPH_UX.md) |
| 执行提示配置 | [Armor Mode](ARMOR_MODE.md) |
| 桌面陪伴、记忆、孵化与备份 | [摇光残影](DESKTOP_PETS.md) |
| 主题包和声明式布局 | [Themes](THEMES.md)、[Layouts](LAYOUTS.md) |
| 主题制作与验收约束 | [开发规范](THEME_DEVELOPMENT.md)、[Agent 工作流程](THEME_AGENT_WORKFLOW.md) |
| 开发优先级与已知缺口 | [路线图](ROADMAP.md) |
| 安装包、签名与更新 | [发布](RELEASE.md)、[发布手册](RELEASE_GUIDE.md)、[1.3.73 发布记录](RELEASE_1.3.73.md) |
| 参考来源与适配范围 | [参考研究](REFERENCE_RESEARCH.md) |
| 生图到 Unity 网格、本地与云端 3D 任务方案（调研／未实现） | [高斯泼溅与生模型工作流](GAUSSIAN_3D_WORKFLOW_RESEARCH.md) |
| 可拆卸 3D 模块、体积核算与验证工具 | [模块验证方案](MODEL3D_MODULE_VALIDATION.md)、[逐步验证日志](MODEL3D_VALIDATION_LOG.md) |

## 历史记录

`VERSION_*.md`、[提示链路基线](PROMPT_PIPELINE_BASELINE.md)、[创作空间对照](CREATIVE_STUDIO_AUDIT.md)、[XiaoLu 迁移](XIAOLU_MIGRATION.md)保留当时的版本与验证记录，不代表本轮重新验证。
[Harness 设计](HARNESS_DESIGN.md)同时包含原设计与当前实现映射，阅读时以其状态说明和当前架构为准。
[模型头像提示](MODEL_AVATAR_PROMPTS.md)及 `avatar-generation.json` 是素材制作记录。
