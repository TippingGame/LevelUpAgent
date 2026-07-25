import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cpu,
  ExternalLink,
  Folder,
  FolderOpen,
  ImagePlus,
  Languages,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  LayoutAction,
  LayoutCondition,
  LayoutDefinition,
  LayoutLocaleText,
  LayoutNode,
  LayoutValue,
} from "../lib/types";
import type { AppLocale } from "../lib/i18n";

export type LayoutData = Record<string, unknown>;
export type LayoutActions = Record<string, (args: Record<string, unknown>) => void | Promise<void>>;

const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  bot: Bot,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  alert: CircleAlert,
  cpu: Cpu,
  external: ExternalLink,
  folder: Folder,
  "folder-open": FolderOpen,
  media: ImagePlus,
  language: Languages,
  message: MessageSquareText,
  "panel-close": PanelRightClose,
  "panel-open": PanelRightOpen,
  plus: Plus,
  search: Search,
  settings: Settings2,
  shield: ShieldCheck,
  sparkles: Sparkles,
  close: X,
};

function lookup(context: LayoutData, path: string): unknown {
  let value: unknown = context;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function conditionMatches(condition: LayoutCondition | undefined, context: LayoutData): boolean {
  if (!condition) return true;
  if (condition.all) return condition.all.every((item) => conditionMatches(item, context));
  if (condition.any) return condition.any.some((item) => conditionMatches(item, context));
  if (condition.not) return !conditionMatches(condition.not, context);
  if (!condition.path) return false;
  const value = lookup(context, condition.path);
  if ("equals" in condition) return Object.is(value, condition.equals);
  if ("notEquals" in condition) return !Object.is(value, condition.notEquals);
  return Boolean(value) === (condition.truthy ?? true);
}

function localized(value: LayoutLocaleText | undefined, locale: AppLocale): string {
  if (!value) return "";
  return typeof value === "string" ? value : value[locale];
}

function interpolate(value: string, context: LayoutData): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const resolved = lookup(context, path);
    return resolved == null || typeof resolved === "object" ? "" : String(resolved);
  });
}

function materialize(value: LayoutValue, context: LayoutData): unknown {
  if (typeof value === "string") return interpolate(value, context);
  if (Array.isArray(value)) return value.map((item) => materialize(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, context)]));
  }
  return value;
}

function classes(node: LayoutNode, extra: string[] = []): string {
  return ["layout-node", `layout-${node.type}`, ...(node.className ?? []), ...extra].join(" ");
}

export function DeclarativeLayout({
  definition,
  locale,
  data,
  actions,
  slots,
  overlays,
  shellClassName,
}: {
  definition: LayoutDefinition;
  locale: AppLocale;
  data: LayoutData;
  actions: LayoutActions;
  slots: Record<string, ReactNode>;
  overlays?: ReactNode;
  shellClassName?: string;
}) {
  const [localState, setLocalState] = useState<Record<string, unknown>>(() => ({ ...(definition.initialState ?? {}) }));

  useEffect(() => {
    setLocalState({ ...(definition.initialState ?? {}) });
  }, [definition.id, definition.initialState]);

  const context: LayoutData = { ...data, state: localState };

  const runAction = (action: LayoutAction, actionContext: LayoutData) => {
    const args = Object.fromEntries(Object.entries(action.args ?? {}).map(([key, value]) => [key, materialize(value, actionContext)]));
    if (action.name === "state.set") {
      const target = typeof args.target === "string" ? args.target : "";
      if (target) setLocalState((current) => ({ ...current, [target]: args.value }));
      return;
    }
    if (action.name === "state.toggle") {
      const target = typeof args.target === "string" ? args.target : "";
      if (target) setLocalState((current) => ({ ...current, [target]: !current[target] }));
      return;
    }
    void actions[action.name]?.(args);
  };

  const renderNode = (node: LayoutNode, key: string, scope: LayoutData = {}): ReactNode => {
    const nodeContext = { ...context, ...scope };
    if (!conditionMatches(node.when, nodeContext)) return null;
    const common = { key, "data-layout-node": node.id };
    switch (node.type) {
      case "container":
        return (
          <div {...common} className={classes(node)} role={node.role}>
            {node.children.map((child, index) => renderNode(child, `${key}.${index}`, scope))}
          </div>
        );
      case "slot": {
        const content = slots[node.slot];
        if (!content) return null;
        if (node.id || node.className?.length) return <div {...common} className={classes(node)}>{content}</div>;
        return <Fragment key={key}>{content}</Fragment>;
      }
      case "text": {
        const value = node.bind ? lookup(nodeContext, node.bind) : localized(node.text, locale);
        const text = typeof value === "string" ? interpolate(value, nodeContext) : value == null || typeof value === "object" ? "" : String(value);
        return <span {...common} className={classes(node)}>{text}</span>;
      }
      case "button": {
        const Icon = node.icon ? ICONS[node.icon] : undefined;
        const active = node.activeWhen ? conditionMatches(node.activeWhen, nodeContext) : false;
        const disabled = node.disabledWhen ? conditionMatches(node.disabledWhen, nodeContext) : false;
        const label = interpolate(localized(node.label, locale), nodeContext);
        return (
          <button
            {...common}
            type="button"
            className={classes(node, active ? ["active"] : [])}
            aria-pressed={node.activeWhen ? active : undefined}
            aria-label={label}
            disabled={disabled}
            onClick={() => runAction(node.action, nodeContext)}
          >
            {Icon && <Icon size={16} aria-hidden="true" />}
            <span>{label}</span>
            {node.children?.map((child, index) => renderNode(child, `${key}.${index}`, scope))}
          </button>
        );
      }
      case "image":
        return <img {...common} className={classes(node)} src={node.source} alt={interpolate(localized(node.alt, locale), nodeContext)} />;
      case "icon": {
        const Icon = ICONS[node.name];
        if (!Icon) return null;
        const label = interpolate(localized(node.label, locale), nodeContext);
        return <Icon {...common} className={classes(node)} aria-label={label || undefined} aria-hidden={label ? undefined : true} />;
      }
      case "input": {
        const label = interpolate(localized(node.label, locale), nodeContext);
        return (
          <label {...common} className={classes(node)}>
            <span>{label}</span>
            <input
              aria-label={label}
              value={String(localState[node.state] ?? "")}
              placeholder={interpolate(localized(node.placeholder, locale), nodeContext)}
              onChange={(event) => setLocalState((current) => ({ ...current, [node.state]: event.target.value }))}
            />
          </label>
        );
      }
      case "repeat": {
        const values = lookup(nodeContext, node.source);
        const items = Array.isArray(values) ? values : [];
        const children = items.length > 0 ? items.flatMap((item, itemIndex) => node.children.map((child, childIndex) =>
          renderNode(child, `${key}.${itemIndex}.${childIndex}`, { ...scope, [node.item]: item, index: itemIndex }),
        )) : (node.empty ?? []).map((child, index) => renderNode(child, `${key}.empty.${index}`, scope));
        return <Fragment key={key}>{children}</Fragment>;
      }
      case "spacer":
        return <span {...common} className={classes(node)} aria-hidden="true" />;
    }
  };

  const root = definition.root;
  const rootContext = context;
  return (
    <div
      className={["app-shell", "layout-host", ...(root.className ?? []), shellClassName].filter(Boolean).join(" ")}
      data-layout-id={definition.id}
      data-layout-node={root.id}
      role={root.role}
    >
      {root.children.map((child, index) => renderNode(child, `root.${index}`, rootContext))}
      {overlays}
    </div>
  );
}
