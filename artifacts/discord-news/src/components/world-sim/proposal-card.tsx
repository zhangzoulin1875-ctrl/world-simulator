import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Check, Loader2, X } from "lucide-react";
import { ChangeList } from "./change-list";
import type { ProposeResult } from "./shared";

interface ProposalCardProps {
  proposal: ProposeResult;
  setProposal: Dispatch<SetStateAction<ProposeResult | null>>;
  applying: boolean;
  apply: () => Promise<void>;
}

export function ProposalCard({
  proposal,
  setProposal,
  applying,
  apply,
}: ProposalCardProps) {
  return (
    <Card data-testid="card-proposal">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          提案預覽
          <Badge
            variant="secondary"
            className="bg-green-500/10 text-green-700 dark:text-green-300"
          >
            新增 {proposal.counts.creates}
          </Badge>
          <Badge
            variant="secondary"
            className="bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            修改 {proposal.counts.updates}
          </Badge>
          <Badge
            variant="secondary"
            className="bg-red-500/10 text-red-700 dark:text-red-300"
          >
            刪除 {proposal.counts.deletes}
          </Badge>
        </CardTitle>
        {proposal.summary && (
          <CardDescription>{proposal.summary}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <ChangeList changes={proposal.changes} />
        <Separator />
        <div className="flex gap-2">
          <Button
            onClick={apply}
            disabled={applying}
            data-testid="button-apply"
          >
            {applying ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-4 w-4" />
            )}
            套用此提案
          </Button>
          <Button
            variant="ghost"
            onClick={() => setProposal(null)}
            disabled={applying}
            data-testid="button-discard"
          >
            <X className="mr-1.5 h-4 w-4" />
            捨棄
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
