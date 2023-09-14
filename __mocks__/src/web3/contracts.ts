import { newKitFromWeb3 } from '@celo/contractkit'
import { privateKeyToAddress } from '@celo/utils/lib/address'
import Web3 from 'web3'

export const initContractKit = jest.fn()
export const destroyContractKit = jest.fn()

const contractKit = newKitFromWeb3(new Web3())

export function* getContractKit() {
  return contractKit
}

export async function getContractKitAsync() {
  return contractKit
}

const mockWallet = {
  addAccount: jest.fn(async (privateKey: string, passphrase: string) =>
    privateKeyToAddress(privateKey)
  ),
  updateAccount: jest.fn().mockResolvedValue(true),
  unlockAccount: jest.fn(),
  isAccountUnlocked: jest.fn(() => true),
  signPersonalMessage: jest.fn(),
}

export function* getWallet() {
  return mockWallet
}

export async function getWalletAsync() {
  return mockWallet
}

const web3 = new Web3()

export function* getWeb3() {
  return web3
}

export async function getWeb3Async() {
  return web3
}

const mockViemWallet = {
  account: { address: '0x1234' },
  writeContract: jest.fn().mockReturnValue('0x123456789'),
}

export function* getViemWallet() {
  return mockViemWallet
}
