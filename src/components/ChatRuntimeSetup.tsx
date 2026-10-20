import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { isDesktop } from '../lib/bridge';
import { detectChatPython, installChatRuntime, type ChatPython } from '../lib/chatbots';

export function ChatRuntimeSetup({ desktop = false, ready, busy, action, t }: {
  desktop?: boolean;
  ready: boolean;
  busy: boolean;
  action: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  t: (zh: string, en: string) => string;
}) {
  const [python, setPython] = useState<ChatPython | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [problem, setProblem] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setDetecting(true); setProblem(''); setPython(null);
    if (!isDesktop()) { setDetecting(false); return; }
    void detectChatPython(desktop).then(result => { if (active) setPython(result); })
      .catch(error => { if (active) setProblem(String(error)); })
      .finally(() => { if (active) setDetecting(false); });
    return () => { active = false; };
  }, [desktop, ready, attempt]);
  const install = async (path?: string) => {
    await installChatRuntime(path, desktop);
    setAttempt(value => value + 1);
  };
  return <div className="chatbot-card" data-testid={desktop ? 'desktop-runtime' : 'gateway-runtime'}>
    <strong>{ready ? t('机器人依赖环境已就绪', 'Bot dependencies ready') : t('准备机器人依赖环境', 'Prepare bot dependencies')}</strong>
    <p>{t('自动识别并复用本机已有 Python，无需重新下载安装 Python。首次会在应用数据目录建立独立环境，只联网安装机器人依赖；再次校验通过后直接复用。', 'Automatically reuses installed Python. No Python download or reinstall. First setup creates an isolated app environment and downloads bot dependencies; healthy environments are reused.')}</p>
    <p>{desktop ? t('需要 Windows Python 3.10–3.12（x64，含 venv）。OCR 在本机运行。', 'Requires Windows Python 3.10–3.12 (x64, with venv). OCR runs locally.') : t('需要 Python 3.10 或更新版本（含 venv）。', 'Requires Python 3.10 or newer, with venv.')}</p>
    <div role="status" data-testid="chat-python-detection">
      {detecting ? t('正在检测已有 Python…', 'Detecting installed Python…') : python ? <span>{t('已检测到', 'Detected')} Python {python.version} · {python.bits} {t('位', 'bit')}<br /><code>{python.executable}</code></span> : t('未找到兼容版本。若已经安装，可重新检测或手动选择 python.exe；不需要先重装。', 'No compatible version found. If already installed, detect again or choose python.exe manually; reinstalling is not the first step.')}
    </div>
    {problem && <p className="chatbot-error">{problem}</p>}
    <div className="chatbot-actions">
      <button type="button" disabled={busy || detecting || !isDesktop() || (!python && !ready)} onClick={() => void action(() => install(), t('机器人依赖环境已就绪。', 'Bot dependencies ready.'))}>{busy ? t('处理中…', 'Working…') : ready ? t('校验已有环境', 'Check existing environment') : t('使用已有 Python 配置依赖', 'Set up with installed Python')}</button>
      <button type="button" disabled={busy || detecting || !isDesktop()} onClick={() => setAttempt(value => value + 1)}>{t('重新检测', 'Detect again')}</button>
    </div>
    <details><summary>{t('手动选择 Python（自定义安装位置）', 'Choose Python manually (custom installation)')}</summary>
      <p>{t('选择已有安装目录中的 python.exe，支持路径中含中文或空格。不会重新安装 Python。', 'Choose python.exe from an existing installation, including paths with spaces or Chinese characters. Python is not reinstalled.')}</p>
      <button type="button" disabled={busy || detecting || !isDesktop()} onClick={() => void action(async () => {
        const path = await open({ directory: false, multiple: false, title: t('选择已安装的 python.exe', 'Choose installed python.exe') });
        if (typeof path === 'string') await install(path);
      })}>{t('选择已有 python.exe', 'Choose installed python.exe')}</button>
    </details>
  </div>;
}
