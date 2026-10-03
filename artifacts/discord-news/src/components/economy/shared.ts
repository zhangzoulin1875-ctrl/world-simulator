import { formatBigNumber } from "@/components/military-shared";

export function signed(v: number): string {
  return `${v >= 0 ? "+" : "−"}${formatBigNumber(Math.abs(v))}`;
}

export function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
