import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  TARGET_STAT_OPTIONS,
  type NationOption,
  type RegionOption,
} from "./shared";

/** 目標數據勾選群（生成表單與事件編輯共用）。 */
export function TargetStatsPicker({
  selected,
  onToggle,
  testIdPrefix,
}: {
  selected: string[];
  onToggle: (key: string) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {TARGET_STAT_OPTIONS.map((o) => (
        <label key={o.key} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(o.key)}
            onChange={() => onToggle(o.key)}
            data-testid={`${testIdPrefix}-${o.key}`}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function RegionMultiSelect({
  regions,
  selected,
  onToggle,
}: {
  regions: RegionOption[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="w-full justify-between"
          data-testid="button-region-select"
        >
          {selected.length > 0 ? `已選 ${selected.length} 個地區` : "選擇地區…"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜尋地區…" />
          <CommandList>
            <CommandEmpty>找不到地區</CommandEmpty>
            <CommandGroup>
              {regions.map((r) => {
                const isSel = selected.includes(r.id);
                return (
                  <CommandItem
                    key={r.id}
                    value={r.name}
                    onSelect={() => onToggle(r.id)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        isSel ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {r.name}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function NationMultiSelect({
  nations,
  selected,
  onToggle,
}: {
  nations: NationOption[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="w-full justify-between"
          data-testid="button-nation-select"
        >
          {selected.length > 0 ? `已選 ${selected.length} 個國家` : "選擇國家…"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜尋國家…" />
          <CommandList>
            <CommandEmpty>找不到國家</CommandEmpty>
            <CommandGroup>
              {nations.map((n) => {
                const isSel = selected.includes(n.id);
                return (
                  <CommandItem
                    key={n.id}
                    value={`${n.name} ${n.isNpc ? "NPC" : ""}`}
                    onSelect={() => onToggle(n.id)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        isSel ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex-1">{n.name}</span>
                    {n.isNpc && (
                      <span className="ml-2 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        NPC
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
