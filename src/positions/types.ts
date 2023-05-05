// Decimal number serialized as a string
export type SerializedDecimalNumber = string

export interface AbstractPosition {
  address: string // Example: 0x...
  network: string // Example: celo
  appId: string // Example: ubeswap
  label: string // Example: Pool
  tokens: Token[]
}

// There's an opportunity to combine with the types in src/tokens/slice.ts
// For now, we'll keep them separate
export interface AbstractToken {
  address: string // Example: 0x...
  network: string // Example: celo
  symbol: string // Example: cUSD
  decimals: number // Example: 18
  priceUsd: SerializedDecimalNumber // Example: "1.5"
  balance: SerializedDecimalNumber // Example: "200", would be negative for debt
}

export interface BaseToken extends AbstractToken {
  type: 'base-token'
}

export interface AppTokenPosition extends AbstractPosition, AbstractToken {
  type: 'app-token'
  supply: SerializedDecimalNumber // Example: "1000"
  // Price ratio between the token and underlying token(s)
  pricePerShare: SerializedDecimalNumber[]
}

export interface ContractPosition extends AbstractPosition {
  type: 'contract-position'
  // This would be derived from the underlying tokens
  balanceUsd: SerializedDecimalNumber
}

export type Token = BaseToken | AppTokenPosition
export type Position = AppTokenPosition | ContractPosition
