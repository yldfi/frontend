export interface ABIInput {
  name: string;
  type: string;
  indexed?: boolean;
  components?: ABIInput[];
}

export interface ABIOutput {
  name: string;
  type: string;
  components?: ABIOutput[];
}

export interface ABIItem {
  type: string;
  name?: string;
  inputs?: ABIInput[];
  outputs?: ABIOutput[];
  stateMutability?: string;
  anonymous?: boolean;
}

export interface ContractValue {
  name: string;
  value: unknown;
  type: string;
  isAddress: boolean;
  isLoading?: boolean;
  error?: string;
}

export interface ContractData {
  address: string;
  name?: string;
  values: ContractValue[];
  isLoading: boolean;
  error?: string;
  abi?: ABIItem[];
  implementationAddress?: string;
}

export interface LinkedContract {
  address: string;
  sourceName: string;
  data?: ContractData;
}
