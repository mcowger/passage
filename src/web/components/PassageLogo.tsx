import { cn } from "../lib/utils.ts";

/** Passage product mark. Single source of truth is `src/web/icon.svg`
 *  (served at `/icon.svg`); this component just renders it at a given size
 *  so sidebar/model-picker/etc. never drift into text glyphs ("P", "❖"). */
export function PassageLogo({
  size = 14,
  className,
  alt = "",
}: {
  size?: number;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src="/icon.svg"
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt === ""}
      draggable={false}
      className={cn("passage-logo", className)}
      style={{ width: size, height: size }}
    />
  );
}
