import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Sparkles } from "lucide-react";
import { INSTRUCTION_MAX } from "./shared";

interface InstructionCardProps {
  instruction: string;
  setInstruction: Dispatch<SetStateAction<string>>;
  proposing: boolean;
  propose: () => Promise<void>;
}

export function InstructionCard({
  instruction,
  setInstruction,
  proposing,
  propose,
}: InstructionCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">世界模擬指令</CardTitle>
        <CardDescription>
          例：「在東亞生成三個古典時代小國，彼此接壤」或「讓德國向西擴張，吞併相鄰的無主地區」。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value.slice(0, INSTRUCTION_MAX))}
            placeholder="描述你想讓世界發生的變化…"
            rows={4}
            disabled={proposing}
            data-testid="input-instruction"
          />
          <div className="text-right text-[11px] text-muted-foreground">
            {instruction.length} / {INSTRUCTION_MAX}
          </div>
        </div>
        <Button
          onClick={propose}
          disabled={proposing || instruction.trim() === ""}
          data-testid="button-propose"
        >
          {proposing ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" />
          )}
          生成提案
        </Button>
      </CardContent>
    </Card>
  );
}
