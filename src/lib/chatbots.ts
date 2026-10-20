import { invoke } from '@tauri-apps/api/core';
export interface ChatBot { id: string; petId: string; name: string; profileId: string; persona: string; enabled: boolean; revision: number; dailyReplyLimit: number; cooldownSeconds: number }
export interface DesktopConfig { version: number; windowTitle: string; selfNames: string[]; layout: { title: [number, number, number, number]; messages: [number, number, number, number]; editor: [number, number, number, number]; sidebar: [number, number, number, number]; send: [number, number] } }
export interface DesktopPreview { layout?: DesktopConfig['layout']; editor?: { readable: boolean; draftEmpty: boolean; writable: boolean; detail: string }; windows: { handle: number; title: string; width: number; height: number; minimized: boolean }[]; image?: string; titleLines?: { text: string }[]; messages?: { text: string; direction: string }[] }
export interface ChatAccount { id: string; name: string; platform: 'feishu' | 'dingtalk' | 'dingtalk_desktop' | 'qq' | 'onebot'; appId: string; tenantId: string; endpoint: string; enabled: boolean; desktop?: DesktopConfig }
export interface ChatRoute { id: string; botId: string; accountId: string; chatType: 'direct' | 'group' | 'guild'; scope?: 'exact' | 'all'; chatId: string; topicId: string; mode: 'mention' | 'all'; paused: boolean }
export interface ChatKnowledge { id: string; botId: string; routeId: string; title: string; content: string }
export interface ChatMemory { id: string; botId: string; routeId: string; senderId: string; content: string }
export interface ChatMessage { id: string; botId: string; accountId: string; routeId: string; chatId: string; chatType: string; topicId: string; senderId: string; text: string; status: string; reply: string | null; delivery: string | null; error: string | null; createdAt: number }
export interface ChatDashboard { bots: ChatBot[]; accounts: ChatAccount[]; routes: ChatRoute[]; knowledge: ChatKnowledge[]; memories: ChatMemory[]; messages: ChatMessage[]; connections: { accountId: string; status: string; detail: string }[]; usage: { botId: string; repliesToday: number; inputTokens: number; outputTokens: number }[]; runtimeReady: boolean; desktopRuntimeReady: boolean }
export const emptyChatDashboard: ChatDashboard = { bots: [], accounts: [], routes: [], knowledge: [], memories: [], messages: [], connections: [], usage: [], runtimeReady: false, desktopRuntimeReady: false };
export const chatDashboard = () => invoke<ChatDashboard>('chat_dashboard');
export const saveChatBot = (bot: ChatBot) => invoke<ChatBot>('chat_save_bot', { bot });
export const saveChatAccount = (account: ChatAccount, secret?: string) => invoke<ChatAccount>('chat_save_account', { account, secret });
export const saveChatRoute = (route: ChatRoute) => invoke<ChatRoute>('chat_save_route', { route });
export const saveChatRoutes = (routes: ChatRoute[]) => invoke<ChatRoute[]>('chat_save_routes', { routes });
export const saveChatKnowledge = (item: ChatKnowledge) => invoke<ChatKnowledge>('chat_save_knowledge', { item });
export const saveChatMemory = (item: ChatMemory) => invoke<ChatMemory>('chat_save_memory', { item });
export const deleteChatItem = (kind: string, id: string) => invoke<void>('chat_delete', { kind, id });
export const resolveChatDelivery = (inboxId: string, sent: boolean) => invoke<void>('chat_resolve_delivery', { inboxId, sent });
export interface ChatPython { executable: string; version: string; bits: number }
export const detectChatPython = (desktop = false) => invoke<ChatPython | null>('chat_detect_python', { desktop });
export const installChatRuntime = (python?: string, desktop = false) => invoke<void>('chat_install_runtime', { python, desktop });
export const desktopProbe = (request: { windowTitle?: string; autoLayout?: boolean; layout?: DesktopConfig['layout'] }) => invoke<DesktopPreview>('chat_desktop_probe', { request });
export const reconnectChat = (accountId: string) => invoke<void>('chat_reconnect', { accountId });
