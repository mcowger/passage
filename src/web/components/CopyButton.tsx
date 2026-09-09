import { useState, type MouseEvent } from "react";
import { Copy, Check } from "lucide-react";

export type CopyButtonProps = {
  text: string;
  title?: string;
  className?: string;
  size?: number;
};

export function CopyButton({
  text,
  title = "Copy",
  className,
  size = 13,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  return (
    <button
      type="button"
      className={`tool-copy-btn ${className ?? ""}`.trim()}
      onClick={handleCopy}
      title={copied ? "Copied!" : title}
      aria-label={copied ? "Copied!" : title}
    >
      {copied ? (
        <Check size={size} className="text-emerald-500" aria-hidden="true" />
      ) : (
        <Copy size={size} aria-hidden="true" />
      )}
    </button>
  );
}
