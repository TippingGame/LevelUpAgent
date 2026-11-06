import type { DesktopBox, DesktopConfig } from './chatbots';

export const calibrationRegions = ['notification', 'sidebar', 'title', 'messages', 'editor', 'sendButton'] as const;
export type CalibrationRegion = typeof calibrationRegions[number];
export const validDesktopBox = (box?: DesktopBox): box is DesktopBox => !!box && box.every(v => Number.isFinite(v) && v >= 0 && v <= 1) && box[2] > box[0] && box[3] > box[1];
export const defaultDesktopConfig = (): DesktopConfig => ({
  version: 2, windowTitle: '', selfNames: [], application: 'dingtalk', inputMode: 'foreground', editorPlaceholder: '请输入消息',
  layout: { title: [0, 0, 0, 0], messages: [0, 0, 0, 0], editor: [0, 0, 0, 0], sidebar: [0, 0, 0, 0], send: [0, 0] },
});
export function setCalibrationBox(config: DesktopConfig, region: CalibrationRegion, box: DesktopBox): DesktopConfig {
  return { ...config, version: 2, layout: { ...config.layout, [region]: box, ...(region === 'sendButton' ? { send: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] as [number, number] } : {}) } };
}
export function calibrationComplete(config: DesktopConfig) {
  return config.version === 2 && calibrationRegions.every(key => validDesktopBox(config.layout[key])) && !!config.referenceSize?.every(v => Number.isFinite(v) && v > 0);
}
