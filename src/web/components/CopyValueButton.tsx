import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "./ui/button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.tsx";

export function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? "Copied!" : `Copy ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }).catch(() => {});
          }}
        >
          {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied!" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
    </TooltipProvider>
  );
}
