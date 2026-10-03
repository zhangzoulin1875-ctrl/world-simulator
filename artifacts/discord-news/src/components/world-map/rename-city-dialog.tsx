import type React from "react";
import type { MapCityEntry } from "@workspace/api-client-react";
import { useRenameMapCity } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Task #311 — 城市更名對話框（僅歸屬玩家可用；留空還原預設名） */
export function RenameCityDialog({
  renameCity,
  setRenameCity,
  renameValue,
  setRenameValue,
  renameMutation,
}: {
  renameCity: MapCityEntry | null;
  setRenameCity: React.Dispatch<React.SetStateAction<MapCityEntry | null>>;
  renameValue: string;
  setRenameValue: React.Dispatch<React.SetStateAction<string>>;
  renameMutation: ReturnType<typeof useRenameMapCity>;
}) {
  return (
    <Dialog
      open={renameCity !== null}
      onOpenChange={(open) => {
        if (!open) setRenameCity(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>更名城市</DialogTitle>
          <DialogDescription>
            預設名稱為「{renameCity?.defaultName}」。留空即可還原為預設名稱。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="city-rename-input">城市名稱</Label>
          <Input
            id="city-rename-input"
            value={renameValue}
            maxLength={40}
            placeholder={renameCity?.defaultName ?? ""}
            onChange={(e) => setRenameValue(e.target.value)}
            data-testid="input-city-rename"
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            disabled={renameMutation.isPending}
            onClick={() => {
              if (!renameCity) return;
              renameMutation.mutate({
                id: renameCity.id,
                data: { name: null },
              });
            }}
            data-testid="button-city-rename-reset"
          >
            還原預設
          </Button>
          <Button
            type="button"
            disabled={renameMutation.isPending}
            onClick={() => {
              if (!renameCity) return;
              const trimmed = renameValue.trim();
              renameMutation.mutate({
                id: renameCity.id,
                data: { name: trimmed === "" ? null : trimmed },
              });
            }}
            data-testid="button-city-rename-save"
          >
            儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
