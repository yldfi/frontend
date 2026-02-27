export interface PendingApproval {
  type?: "erc20" | "controller";
  token: `0x${string}`;
  tokenSymbol: string;
  spender: `0x${string}`;
  spenderName?: string;
  amount?: bigint;
  decimals?: number;
}

export interface ApprovalStep {
  label: string;
  description: string;
  done: boolean;
  spender?: string;
}

export interface ApprovalProgress {
  step: number;
  total: number;
  steps: ApprovalStep[];
}
