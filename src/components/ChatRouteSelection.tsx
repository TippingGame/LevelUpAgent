import { useEffect, useState } from 'react';
import { saveChatRoutes, type ChatBot, type ChatDashboard, type ChatRoute } from '../lib/chatbots';

type Props = {
  data: ChatDashboard; bot: ChatBot | undefined; busy: boolean;
  action: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  t: (zh: string, en: string) => string;
};
const keyOf = (chatId: string, topicId = '') => JSON.stringify([chatId, topicId]);

export function ChatRouteSelection({ data, bot, busy, action, t }: Props) {
  const [selectedAccount, setAccount] = useState('');
  const [chatType, setType] = useState<'direct' | 'group'>('direct');
  const [manual, setManual] = useState('');
  const [registered, setRegistered] = useState<string[]>([]);
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'mention' | 'all'>('mention');
  const [allEnabled, setAllEnabled] = useState(false);
  const account = data.accounts.find(a => a.id === selectedAccount) ?? data.accounts[0];
  const desktop = account?.platform === 'dingtalk_desktop';
  const limit = desktop ? 100 : 500;
  const routes = data.routes.filter(r => r.accountId === account?.id && r.chatType === chatType);
  const fallback = routes.find(r => r.scope === 'all');
  const fingerprint = JSON.stringify(routes);
  useEffect(() => {
    setSelection({});
    setAllEnabled(!!fallback && fallback.botId === bot?.id && !fallback.paused);
    setMode(fallback && fallback.botId === bot?.id ? fallback.mode : 'mention');
  }, [account?.id, chatType, bot?.id, fingerprint]);
  useEffect(() => { setRegistered([]); setManual(''); setQuery(''); }, [account?.id, chatType]);
  const candidates = new Map<string, { chatId: string; topicId: string; route?: ChatRoute }>();
  for (const r of routes.filter(r => r.scope !== 'all')) candidates.set(keyOf(r.chatId, r.topicId), { chatId: r.chatId, topicId: r.topicId, route: r });
  for (const m of data.messages.filter(m => m.accountId === account?.id && m.chatType === chatType)) {
    const key = keyOf(m.chatId, m.topicId);
    if (!candidates.has(key)) candidates.set(key, { chatId: m.chatId, topicId: m.topicId });
  }
  for (const title of registered) {
    const key = keyOf(title);
    if (!candidates.has(key)) candidates.set(key, { chatId: title, topicId: '' });
  }
  const rows = [...candidates].sort((a, b) => a[1].chatId.localeCompare(b[1].chatId));
  const available = rows.filter(([, c]) => !c.route || c.route.botId === bot?.id);
  const filtered = rows.filter(([, c]) => `${c.chatId} ${c.topicId}`.toLowerCase().includes(query.toLowerCase()));
  const checked = (key: string, route?: ChatRoute) => selection[key] ?? (route ? route.botId === bot?.id && !route.paused : !!fallback && fallback.botId === bot?.id && !fallback.paused);
  const count = available.filter(([key, c]) => checked(key, c.route)).length;
  const makeRoute = (chatId: string, topicId: string, paused: boolean): ChatRoute => ({ id: '', botId: bot!.id, accountId: account!.id, chatType, scope: 'exact', chatId, topicId, mode, paused });
  const apply = async () => {
    const changes = available.flatMap(([key, c]) => {
      const selected = checked(key, c.route);
      if (c.route) return [{ ...c.route, paused: !selected, mode }];
      if (selected || (fallback && fallback.botId === bot?.id && !fallback.paused)) return [makeRoute(c.chatId, c.topicId, !selected)];
      return [];
    });
    if (changes.length) await saveChatRoutes(changes);
  };
  const officialMentionsOnly = account && ['qq', 'dingtalk'].includes(account.platform);
  return <section className="chatbot-selection" data-testid="chat-route-selection">
    <h3>{t('自动回复范围', 'Auto-reply scope')}</h3>
    <div className="chatbot-fields">
      <label>{t('范围管理账号', 'Scope account')}<select aria-label={t('范围管理账号', 'Scope account')} value={account?.id ?? ''} disabled={busy} onChange={e => setAccount(e.target.value)}><option value="" disabled>{t('先添加账号', 'Add an account first')}</option>{data.accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.platform}</option>)}</select></label>
      <label>{t('管理聊天类型', 'Scope chat type')}<select aria-label={t('管理聊天类型', 'Scope chat type')} value={chatType} disabled={busy} onChange={e => setType(e.target.value as 'direct' | 'group')}><option value="direct">{t('私聊', 'Private chats')}</option><option value="group">{t('群聊', 'Group chats')}</option></select></label>
    </div>
    <p>{desktop ? t('钉钉桌面：列表来自已登记标题与收发记录，不是完整通讯录。全选仅覆盖此列表；新聊天需登记，轮询时完整标题须在钉钉侧栏可见。同名聊天无法可靠区分。', 'DingTalk desktop: this list contains registered titles and recent chats, not your full directory. Select all covers this list only. Register new chats and keep full titles visible in the sidebar. Duplicate titles cannot be distinguished.') : t('列表来自已绑定聊天及最近收发记录。可选择指定聊天，也可启用此账号全部私聊或全部群聊；实际接收范围仍由平台授予的权限决定。', 'The list contains routed and recently received chats. Choose specific chats or enable all private/group chats for this account, within platform permissions.')}</p>
    <label>{desktop ? t('批量登记聊天完整标题（每行一个）', 'Register full chat titles (one per line)') : t('批量登记聊天 ID（每行一个）', 'Register chat IDs (one per line)')}<textarea rows={3} value={manual} disabled={busy || !account} onChange={e => setManual(e.target.value)} /></label>
    <button type="button" disabled={busy || !manual.trim() || !account} onClick={() => { setRegistered([...new Set([...registered, ...manual.split(/\r?\n/).map(s => s.trim()).filter(Boolean)])]); setManual(''); }}>{t('加入待选列表', 'Add to selection list')}</button>
    <label>{t('筛选聊天', 'Filter chats')}<input value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className="chatbot-actions">
      <button type="button" disabled={busy || !bot || !available.length} onClick={() => setSelection(Object.fromEntries(available.map(([key]) => [key, true])))}>{t('全选列表', 'Select all listed')}</button>
      <button type="button" disabled={busy || !bot || !available.length} onClick={() => setSelection(Object.fromEntries(available.map(([key]) => [key, false])))}>{t('取消全选', 'Deselect all listed')}</button>
      <span role="status">{t(`已选 ${count} / ${available.length}`, `Selected ${count} / ${available.length}`)}</span>
    </div>
    <p><small>{t('全选包括被筛选隐藏的列表项；已绑定其他机器人的聊天不能在这里覆盖。取消勾选并应用会暂停该聊天。', 'Select all includes filtered-out list entries. Chats owned by another bot cannot be reassigned here. Uncheck and apply to pause a chat.')}</small></p>
    <div className="chatbot-selection-list" aria-label={t('可选聊天', 'Available chats')}>
      {filtered.map(([key, c]) => <label className="chatbot-check" key={key}><input type="checkbox" disabled={busy || !bot || (!!c.route && c.route.botId !== bot.id)} checked={checked(key, c.route)} onChange={e => setSelection({ ...selection, [key]: e.target.checked })} /><span>{c.chatId}{c.topicId && ` / ${c.topicId}`}{c.route && c.route.botId !== bot?.id && ` · ${t('属于其他机器人', 'Owned by another bot')}`}</span></label>)}
      {!filtered.length && <p>{t('暂无聊天。可粘贴标题或 ID 加入列表。', 'No chats yet. Add titles or IDs above.')}</p>}
    </div>
    {chatType === 'group' && <label>{t('批量群聊触发方式', 'Batch group trigger')}<select aria-label={t('批量群聊触发方式', 'Batch group trigger')} value={mode} disabled={busy} onChange={e => setMode(e.target.value as 'mention' | 'all')}><option value="mention">{t('仅 @ 我', 'Mentions only')}</option>{!officialMentionsOnly && <option value="all">{t('全部新文本', 'All new text')}</option>}</select><small>{t('选择哪些群与回复群内哪些消息是两个设置。飞书接收全部群消息需要额外权限。', 'Group selection and message triggers are separate. Feishu requires extra permission for all group messages.')}</small></label>}
    <button type="button" disabled={busy || !bot || !account || !available.length || available.length > limit} onClick={() => void action(apply, t('列表选择已应用。', 'List selection applied.'))}>{t('应用列表选择', 'Apply list selection')}</button>
    {available.length > limit && <p className="chatbot-error" role="alert">{t(`单次最多应用 ${limit} 个聊天。桌面账号最多登记 100 个。`, `Apply at most ${limit} chats at a time. Desktop accounts can register up to 100.`)}</p>}
    <div className="chatbot-card" data-testid="chat-all-scope">
      <label className="chatbot-check"><input type="checkbox" checked={allEnabled} disabled={busy || desktop || !bot || !account || (!!fallback && fallback.botId !== bot.id)} onChange={e => setAllEnabled(e.target.checked)} />{chatType === 'direct' ? t('此账号全部私聊（包含今后的新聊天）', 'All private chats, including future chats') : t('此账号全部群聊（包含今后的新群）', 'All group chats, including future groups')}</label>
      <small>{desktop ? t('当前桌面驱动无法可靠发现所有聊天，此功能尚不可用；请使用上面的列表全选。', 'The desktop driver cannot reliably discover every chat. Use select all listed above.') : t('独立聊天设置优先生效，包括已暂停的聊天；全部范围不会覆盖单独的排除项。', 'Specific rules take precedence, including paused chats. All-chat scope preserves explicit exclusions.')}</small>
      {fallback && fallback.botId !== bot?.id && <small>{t('此账号的全部范围已由其他机器人管理。', 'Another bot owns this account’s all-chat scope.')}</small>}
      {!desktop && <button type="button" disabled={busy || !bot || !account || (!!fallback && fallback.botId !== bot.id) || (!fallback && !allEnabled)} onClick={() => void action(() => saveChatRoutes([{ ...(fallback ?? makeRoute('*', '', false)), scope: 'all', mode, paused: !allEnabled }]), t('全部范围设置已保存。', 'All-chat scope saved.'))}>{t('保存全部范围', 'Save all-chat scope')}</button>}
    </div>
  </section>;
}
