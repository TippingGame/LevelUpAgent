import { Children, isValidElement, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Check, Copy } from "lucide-react";
import remarkGfmCompatible from "../lib/remarkGfmCompatible";
import { copyText } from "../lib/clipboard";
import { tr } from "../lib/i18n";

function MarkdownCodeBlock({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firstChild = Children.toArray(children)[0];
  const codeProps = isValidElement(firstChild)
    ? firstChild.props as { children?: ReactNode; className?: string }
    : undefined;
  const source = String(codeProps?.children ?? "").replace(/\n$/, "");
  const language = codeProps?.className?.match(/language-([\w-]+)/)?.[1] ?? "";
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await copyText(source);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    } catch { setCopied(false); }
  };
  return <div className="markdown-code-block">
    <div className="markdown-code-toolbar">
      <span>{language || tr("代码", "Code")}</span>
      <button type="button" onClick={() => void copy()} title={tr("复制代码", "Copy code")}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? tr("已复制", "Copied") : tr("复制", "Copy")}</span>
      </button>
    </div>
    <pre {...props}>{children}</pre>
  </div>;
}

const COMPONENTS: Components = {
  pre: MarkdownCodeBlock,
  a: ({ href, children, ...props }) => <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>,
};
const PLUGINS = [remarkGfmCompatible];

export default function MarkdownRenderer({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{content}</ReactMarkdown>;
}
