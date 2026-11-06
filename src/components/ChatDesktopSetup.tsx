import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { desktopProbe, type ChatAccount, type DesktopBox, type DesktopConfig, type DesktopPreview } from '../lib/chatbots';
import { broadNotificationRegion, calibrationComplete, calibrationRegions, defaultDesktopConfig, setCalibrationBox, validDesktopBox, type CalibrationRegion } from '../lib/desktopCalibration';
import { ChatRuntimeSetup } from './ChatRuntimeSetup';

export { defaultDesktopConfig } from '../lib/desktopCalibration';
type Shot = { image: string; width: number; height: number };
const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('无法读取图片 / Cannot read image')); img.src = src; });

export function ChatDesktopSetup({ account, onChange, connectedAccount, onPause, ready, busy, action, t }: { account: ChatAccount; onChange: (account: ChatAccount) => void; connectedAccount?: ChatAccount; onPause: () => Promise<void>; ready: boolean; busy: boolean; action: (fn: () => Promise<unknown>, success?: string) => Promise<void>; t: (zh: string, en: string) => string }) {
  const config = account.desktop ?? defaultDesktopConfig();
  const [names, setNames] = useState(config.selfNames.join(', '));
  const [windows, setWindows] = useState<DesktopPreview['windows']>([]);
  const [diagnostics, setDiagnostics] = useState<DesktopPreview['diagnostics']>([]);
  const shot: Shot | null = config.calibrationImage && config.referenceSize ? { image: config.calibrationImage, width: config.referenceSize[0], height: config.referenceSize[1] } : null;
  const [preview, setPreview] = useState<DesktopPreview | null>(null);
  const [region, setRegion] = useState<CalibrationRegion>('notification');
  const [cropMode, setCropMode] = useState(false);
  const [draft, setDraft] = useState<DesktopBox | null>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    setPreview(null);
    setNames(current => JSON.stringify(current.split(/[,，]/).map(n => n.trim()).filter(Boolean)) === JSON.stringify(config.selfNames) ? current : config.selfNames.join(', '));
  }, [config]);
  const start = useRef<[number, number] | null>(null);
  const locked = busy || !!connectedAccount;
  const complete = calibrationComplete(config);
  const labels: Record<CalibrationRegion, string> = { notification: t('消息栏 / 红点入口', 'Messages / unread entry'), sidebar: t('会话栏 / 聊天列表', 'Conversation list'), title: t('标题栏', 'Chat title'), messages: t('聊天正文', 'Message history'), editor: t('输入栏', 'Message editor'), sendButton: t('发送按钮', 'Send button') };
  const hints: Record<CalibrationRegion, string> = { notification: t('只框一个「消息」按钮和它的红点，不要框整列菜单。框内中心是点击位置；大框无法定位单个消息入口时不会点击。', 'Select one Messages button and its badge, not the whole menu. Its center is the click target; broad ambiguous regions are never clicked.'), sidebar: t('框住会话名称和未读红点所在的整个列表，不含搜索框。', 'Include conversation names and unread badges; exclude search.'), title: t('框住当前聊天名称；附带部门、群人数或状态也可以。', 'Include the chat name. Department, member counts and status suffixes are allowed.'), messages: t('框住聊天正文与左右气泡，排除标题、工具栏和输入栏。', 'Include bubbles on both sides; exclude title, toolbar and editor.'), editor: t('只框可输入文字的区域，排除表情、附件等工具按钮。校准时请清空草稿。', 'Include only editable text, excluding toolbar buttons. Clear the draft before calibration.'), sendButton: t('框住发送按钮；发送时点击框的中心。', 'Select the Send button; its center will be clicked.') };
  const update = (next: DesktopConfig) => { setPreview(null); onChange({ ...account, desktop: next }); };
  const request = { application: config.application ?? 'dingtalk', processName: config.processName, windowHandle: config.windowHandle, windowTitle: config.windowTitle };
  const acceptShot = (next: Shot, reset: boolean) => {
    if (next.image.length > 16 * 1024 * 1024) throw new Error(t('截图过大，请先裁剪或降低截图分辨率。', 'Screenshot is too large; crop or reduce its resolution first.'));
    setPreview(null); setDraft(null); start.current = null;
    update({ ...config, version: 2, referenceSize: [next.width, next.height], calibrationImage: next.image, layout: reset ? defaultDesktopConfig().layout : config.layout });
    if (reset) setRegion('notification');
  };
  const capture = () => action(async () => {
    const result = await desktopProbe({ ...request, captureOnly: true });
    if (!result.image || !result.width || !result.height) throw new Error(t('窗口截图失败，请还原窗口后重试。', 'Capture failed. Restore the window and retry.'));
    setWindows(result.windows); setCropMode(false);
    acceptShot({ image: result.image, width: result.width, height: result.height }, config.referenceSize?.[0] !== result.width || config.referenceSize?.[1] !== result.height);
  });
  const position = (e: PointerEvent<HTMLDivElement>): [number, number] => { const bounds = e.currentTarget.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)), Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height))]; };
  const rectangle = (a: [number, number], b: [number, number]): DesktopBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current || locked || !shot) return;
    const box = rectangle(start.current, position(e)); start.current = null; setDraft(null);
    if (box[2] - box[0] < .003 || box[3] - box[1] < .003) return;
    if (cropMode) {
      void action(async () => { const img = await loadImage(shot.image); const canvas = document.createElement('canvas'); const x = Math.round(box[0] * img.width), y = Math.round(box[1] * img.height); canvas.width = Math.round(box[2] * img.width) - x; canvas.height = Math.round(box[3] * img.height) - y; canvas.getContext('2d')!.drawImage(img, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height); acceptShot({ image: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }, true); setCropMode(false); });
    } else {
      update(setCalibrationBox(config, region, box));
      setRegion(calibrationRegions.find(key => key !== region && !validDesktopBox(config.layout[key])) ?? region);
    }
  };
  const boxStyle = (box: DesktopBox) => ({ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` });
  return <section className="chatbot-desktop" data-testid="desktop-setup">
    <h3>{t('桌面应用 · 截图框选接入', 'Desktop apps · screenshot calibration')}</h3>
    <p>{t('选择窗口 → 截图或上传 → 手动框选 → 核对预览。按你的界面布局识别，不依赖固定坐标或控件标签。', 'Choose a window → capture or upload → draw regions → check the preview. Calibrate your own layout without fixed coordinates or control labels.')}</p>
    {connectedAccount && <div className="chatbot-card" data-testid="desktop-setup-pause"><p>{t('连接运行中；暂停后可以更换截图和区域。', 'Pause the active connection to change screenshots or regions.')}</p><button type="button" disabled={busy} onClick={() => void action(onPause, t('已暂停，可以重新框选。', 'Paused. Calibration is unlocked.'))}>{t('暂停连接并校准', 'Pause connection and calibrate')}</button></div>}
    {config.version === 1 && <p className="chatbot-notice">{t('这是旧版校准。请重新截图并框选消息红点入口和发送按钮，升级为未读驱动流程。', 'Legacy calibration: capture again and draw the unread entry and Send button to upgrade.')}</p>}
    <h4>{t('1 · 选择应用与截图', '1 · Choose app and screenshot')}</h4>
    <label>{t('桌面应用', 'Desktop application')}<select aria-label={t('桌面应用', 'Desktop application')} value={config.application ?? 'dingtalk'} disabled={locked} onChange={e => { setWindows([]); setNames(''); update({ ...defaultDesktopConfig(e.target.value as 'dingtalk' | 'custom'), editorPlaceholder: e.target.value === 'custom' ? '' : '请输入消息' }); }}><option value="dingtalk">{t('钉钉桌面版（默认）', 'DingTalk desktop (default)')}</option><option value="custom">{t('其他桌面应用', 'Other desktop application')}</option></select></label>
      <label>{t('执行方式（切换会话与发送）', 'Execution mode (navigation and sending)')}<select data-testid="desktop-input-mode" value={config.inputMode ?? 'background'} disabled={locked} onChange={e => update({ ...config, inputMode: e.target.value as 'background' | 'foreground' })}><option value="foreground">{t('前台兼容模式', 'Foreground compatibility')}</option>{config.application !== 'custom' && <option value="background">{t('钉钉后台模式（默认，窗口消息）', 'DingTalk background (default, window messages)')}</option>}</select></label>
      <p>{(config.inputMode ?? 'background') === 'background' ? t('后台模式通过目标窗口消息操作，不移动鼠标；部分钉钉版本会自行激活窗口。其他应用中操作不阻塞监听；正在操作钉钉时仍可读取，点击和发送等待钉钉空闲 5 秒。', 'Background mode uses target window messages without moving the mouse; some DingTalk versions may activate themselves. Other apps do not block listening. Reading continues while you use DingTalk; input waits for 5 seconds of inactivity.') : t('当前是前台兼容模式：切换会话和发送会激活目标窗口，并等待键鼠空闲 5 秒。旧账号保留原模式；钉钉可切换后台模式，保存后重新连接。', 'Foreground mode activates the target after 5 seconds of idle input. Existing accounts keep their saved mode; DingTalk can switch to background here. Save and reconnect to apply.')}</p>
    <ChatRuntimeSetup desktop ready={ready} busy={busy} action={action} t={t} />
    <div className="chatbot-actions"><button type="button" disabled={!ready || busy} onClick={() => void action(async () => { setWindows([]); setDiagnostics([]); const result = await desktopProbe({ application: config.application ?? 'dingtalk' }); setWindows(result.windows); setDiagnostics(result.diagnostics); if (!connectedAccount && result.windows.length === 1) { const w = result.windows[0]; update({ ...config, windowTitle: w.title, windowHandle: w.handle, processName: w.processName }); } })}>{t('检测应用窗口', 'Detect app windows')}</button><span>{t(`检测到 ${windows.length} 个窗口`, `${windows.length} windows found`)}</span></div>
    <div data-testid="desktop-window-result" role="status">{diagnostics?.map(d => <p key={d.code}>{d.detail}</p>)}</div>
    <label>{t('目标窗口', 'Target window')}<select aria-label={t('目标窗口', 'Target window')} required value={config.windowHandle ? String(config.windowHandle) : config.windowTitle} disabled={locked} onChange={e => { const w = windows.find(item => String(item.handle) === e.target.value); if (!w) return; update({ ...config, calibrationImage: undefined, windowTitle: w.title, windowHandle: w.handle, processName: w.processName, referenceSize: undefined, layout: defaultDesktopConfig().layout }); }}><option value="">{t('检测后选择要接管的窗口', 'Detect and choose the target window')}</option>{config.windowTitle && !windows.some(w => w.handle === config.windowHandle) && <option value={config.windowHandle ? String(config.windowHandle) : config.windowTitle}>{config.windowTitle}</option>}{windows.map(w => <option key={w.handle} value={String(w.handle)}>{w.title} · {w.processName} · {w.width} × {w.height}{w.minimized ? t('（请先还原）', ' (restore first)') : ''}</option>)}</select></label>
    <div className="chatbot-actions"><button type="button" disabled={!ready || !config.windowTitle || locked} onClick={() => void capture()}>{t('自动截图', 'Capture window')}</button><label className="chatbot-upload">{t('或上传界面截图', 'Or upload screenshot')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void action(async () => { if (file.size > 20 * 1024 * 1024) throw new Error(t('截图不能超过 20 MB。', 'Maximum image size is 20 MB.')); const url = URL.createObjectURL(file); try { const img = await loadImage(url); if (img.width * img.height > 32_000_000) throw new Error(t('截图分辨率过大。', 'Image resolution is too large.')); const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d')!.drawImage(img, 0, 0); acceptShot({ image: canvas.toDataURL('image/png'), width: img.width, height: img.height }, true); setCropMode(true); } finally { URL.revokeObjectURL(url); } }); }} /></label></div>
    <h4>{t('2 · 拖动框选你的界面', '2 · Draw regions on your layout')}</h4>
    {!shot && <p className="chatbot-calibration-empty">{t('先获取截图，再依次框选。已有区域会保留；旧版未保存的截图需重新获取。', 'Capture or upload a screenshot. Existing regions are kept; older accounts need a new reference image.')}</p>}
    {shot && <>
      {cropMode ? <div className="chatbot-card"><strong>{t('先框出完整应用窗口（包含窗口边缘）', 'First crop the complete application window')}</strong><p>{t('如果上传的是整屏截图，拖框去掉桌面和其他窗口；之后再框选内部区域。', 'Crop away the desktop and other windows before selecting internal regions.')}</p><button type="button" disabled={locked} onClick={() => setCropMode(false)}>{t('这张图就是完整应用窗口', 'This image is already the full window')}</button></div> : <>
        <div className="chatbot-region-tabs">{calibrationRegions.map((key, i) => <button type="button" key={key} disabled={locked} aria-pressed={region === key} onClick={() => setRegion(key)}>{validDesktopBox(config.layout[key]) ? '✓' : i + 1} · {labels[key]}</button>)}</div>
        <p aria-live="polite"><strong>{labels[region]}</strong> · {hints[region]}</p>
      </>}
      <div className="chatbot-actions"><label>{t('截图缩放', 'Screenshot zoom')}<select aria-label={t('截图缩放', 'Screenshot zoom')} value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={1}>100%</option><option value={1.5}>150%</option><option value={2}>200%</option></select></label><button type="button" disabled={locked} onClick={() => { setCropMode(true); setDraft(null); }}>{t('裁剪到应用窗口', 'Crop to app window')}</button>{!cropMode && <button type="button" disabled={locked} onClick={() => update(setCalibrationBox(config, region, [0, 0, 0, 0]))}>{t('清除当前框', 'Clear selected region')}</button>}</div>
      <div className="chatbot-calibration-scroll"><div className="chatbot-calibration" style={{ width: `${zoom * 100}%` }} role="img" aria-label={t('拖动截图框选区域', 'Drag to select screenshot regions')} onPointerDown={e => { if (locked || e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); start.current = position(e); setDraft(rectangle(start.current, start.current)); }} onPointerMove={e => { if (start.current) setDraft(rectangle(start.current, position(e))); }} onPointerUp={finish} onPointerCancel={() => { start.current = null; setDraft(null); }}>
        <img src={shot.image} alt={t('应用窗口校准截图', 'Application calibration screenshot')} draggable={false} />
        {!cropMode && calibrationRegions.map(key => { const box = config.layout[key]; return validDesktopBox(box) && <span key={key} className={`chatbot-calibration-box${region === key ? ' is-selected' : ''}`} style={boxStyle(box)}><span>{labels[key]}</span></span>; })}
        {draft && <span className="chatbot-calibration-box is-drawing" style={boxStyle(draft)} />}
      </div></div>
    </>}
    <p role="status">{t(`已框选 ${calibrationRegions.filter(k => validDesktopBox(config.layout[k])).length} / 6 个区域`, `${calibrationRegions.filter(k => validDesktopBox(config.layout[k])).length} / 6 regions calibrated`)}{config.referenceSize && ` · ${config.referenceSize[0]} × ${config.referenceSize[1]}`}</p>
    <p>{t('保存账号时会一并保存截图和全部框选区域，重新打开即可继续编辑。截图仅用于本机校准。', 'Saving the account also saves its screenshot and regions for later editing. The screenshot is used only for local calibration.')}</p>
    {broadNotificationRegion(config) && <p className="chatbot-notice" data-testid="desktop-entry-warning" role="status">{t('消息入口框较大，可能包含多个菜单。运行时只点击可确认的单个消息入口；请缩小到「消息」按钮，避免把 DING、OA 审批框进去。', 'The entry region may contain multiple menu items. Only a confirmed single entry can be clicked; narrow it to the Messages button.')}</p>}
    <h4>{t('3 · 核对识别并保存', '3 · Review recognition and save')}</h4>
    <p>{t('发现红点后检查对应会话，只回复已绑定的名称。标题包含名称即命中，例如「测试联系人（设计部）」可匹配「测试联系人」。多个名称重叠时优先较长名称；无法区分的同名会话暂停处理。', 'Unread badges trigger checks of registered chats. A title containing the name matches; longer names take precedence. Ambiguous conversations are skipped.')}</p>
    <button type="button" disabled={!ready || !config.windowTitle || !complete || cropMode || locked} onClick={() => void action(async () => { setPreview(await desktopProbe({ ...request, config, layout: config.layout })); })}>{t('检查实时识别（不发送）', 'Check live recognition (no sending)')}</button>
    {preview && <div className="chatbot-card" data-testid="desktop-recognition-result"><strong>{t('实时窗口识别结果', 'Live window recognition')}</strong><p>{t('标题', 'Title')}: {preview.titleLines?.map(l => l.text).join(' · ') || t('未读到，请调整标题栏', 'No title; adjust the title region')}</p><p>{t('消息入口红点', 'Unread entry badge')}: {preview.unread?.notification ? t('有', 'Yes') : t('无', 'No')} · {t('会话红点', 'Conversation badges')}: {preview.unread?.rows ?? 0}</p>{preview.navigation && <p className={preview.navigation.box ? undefined : 'chatbot-error'}>{preview.navigation.detail}</p>}<details open><summary>{t('会话栏识别文字（与绑定名称核对）', 'Recognized conversation headings (compare with registered names)')}</summary>{preview.sidebarLines?.length ? preview.sidebarLines.map((line, i) => <p key={i}>{line.text}</p>) : <p>{t('没有识别到会话名称，请检查会话栏框选。', 'No conversation headings recognized; check the list region.')}</p>}</details>{preview.editor && <p className={preview.editor.readable ? undefined : 'chatbot-error'}>{preview.editor.detail}</p>}<details open><summary>{t('聊天正文（核对收到 / 发出方向）', 'Message history (check incoming / outgoing)')}</summary>{preview.messages?.length ? preview.messages.map((m, i) => <p className="chatbot-message" key={i}><strong>{m.direction === 'incoming' ? t('收到', 'Incoming') : t('发出', 'Outgoing')}</strong>: {m.text}</p>) : <p>{t('未识别到文字气泡，请调整正文区域。', 'No text bubbles recognized; adjust the history region.')}</p>}</details></div>}
    <details><summary>{t('收发设置与精确坐标', 'Input settings and exact coordinates')}</summary>
      <label>{t('我的 @ 显示名（群聊仅 @ 模式需要，逗号分隔）', 'My @ names (needed for group mentions, comma separated)')}<input value={names} disabled={locked} onChange={e => { setNames(e.target.value); update({ ...config, selfNames: e.target.value.split(/[,，]/).map(n => n.trim()).filter(Boolean) }); }} /></label>
      <label>{t('空输入栏的提示文字', 'Empty editor placeholder')}<input value={config.editorPlaceholder ?? '请输入消息'} disabled={locked} onChange={e => update({ ...config, editorPlaceholder: e.target.value })} /></label>
      {calibrationRegions.map(key => <fieldset className="chatbot-coordinate-fields" key={key}><legend>{labels[key]}</legend>{(config.layout[key] ?? [0, 0, 0, 0]).map((v, i) => <label key={i}>{['X1', 'Y1', 'X2', 'Y2'][i]}<input type="number" step="any" min={0} max={1} value={v} disabled={locked} onChange={e => { const box = [...(config.layout[key] ?? [0, 0, 0, 0])] as DesktopBox; box[i] = Number(e.target.value); update(setCalibrationBox(config, key, box)); }} /></label>)}</fieldset>)}
    </details>
    <small>{t('保持窗口打开、未最小化和 Windows 解锁。窗口移动无需重新框选；调整窗口尺寸或内部布局后重新校准。未读首次出现只处理最新一条可读收到消息，已有历史不会批量补回。支持文字气泡；图片、语音和附件不自动理解。', 'Keep the window open, restored and Windows unlocked. Moving it preserves calibration; resize or layout changes require recalibration. A first unread chat processes only its latest readable incoming message. Text bubbles are supported; media is excluded.')}</small>
  </section>;
}
