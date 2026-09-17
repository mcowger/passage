import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MILLION = 1_000_000;

/** Compact token counts: 3950 → "4K", 416194 → "416.2K", 1_048_576 → "1.05M". */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= MILLION ? 2 : 1,
  }).format(value);
}
