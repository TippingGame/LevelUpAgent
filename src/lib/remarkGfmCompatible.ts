import remarkGfm from "remark-gfm";

type RemarkGfmOptions = Parameters<typeof remarkGfm>[0];

export default function remarkGfmCompatible(
  this: any,
  options?: RemarkGfmOptions,
) {
  remarkGfm.call(this, options);

  const extensions = (this.data() as { fromMarkdownExtensions?: unknown[] }).fromMarkdownExtensions;
  const gfmExtensions = extensions?.[extensions.length - 1];
  if (!Array.isArray(gfmExtensions)) return;

  const autolinkExtension = gfmExtensions[0] as { transforms?: unknown[] } | undefined;
  if (autolinkExtension && Array.isArray(autolinkExtension.transforms)) {
    // mdast-util-gfm-autolink-literal uses a variable-length lookbehind that
    // Safari 17 rejects. Micromark's normal GFM autolink tokenizer stays active.
    autolinkExtension.transforms = [];
  }
}
