import BigNumber from 'bignumber.js'
import erc20 from 'src/abis/IERC20'
import stableToken from 'src/abis/StableToken'
import { showError } from 'src/alert/actions'
import { TransactionEvents } from 'src/analytics/Events'
import ValoraAnalytics from 'src/analytics/ValoraAnalytics'
import { ErrorMessages } from 'src/app/ErrorMessages'
import { FeeInfo } from 'src/fees/saga'
import { encryptComment } from 'src/identity/commentEncryption'
import { buildSendTx } from 'src/send/saga'
import { getTokenInfo, tokenAmountInSmallestUnit } from 'src/tokens/saga'
import {
  TokenBalanceWithAddress,
  fetchTokenBalances,
  tokenBalanceHasAddress,
} from 'src/tokens/slice'
import { getTokenId, tokenSupportsComments } from 'src/tokens/utils'
import { addStandbyTransaction } from 'src/transactions/actions'
import { handleTransactionReceiptReceived } from 'src/transactions/saga'
import { chooseTxFeeDetails, wrapSendTransactionWithRetry } from 'src/transactions/send'
import { Network, TokenTransactionTypeV2, TransactionContext } from 'src/transactions/types'
import Logger from 'src/utils/Logger'
import { ensureError } from 'src/utils/ensureError'
import { publicClient } from 'src/viem'
import { ViemWallet } from 'src/viem/getLockableWallet'
import { TransactionRequest, getFeeCurrency } from 'src/viem/prepareTransactions'
import {
  SerializableTransactionRequest,
  getPreparedTransaction,
} from 'src/viem/preparedTransactionSerialization'
import { getViemWallet } from 'src/web3/contracts'
import networkConfig from 'src/web3/networkConfig'
import { unlockAccount } from 'src/web3/saga'
import { getNetworkFromNetworkId } from 'src/web3/utils'
import { call, put } from 'typed-redux-saga'
import { Hash, SimulateContractReturnType, TransactionReceipt, getAddress } from 'viem'

const TAG = 'viem/saga'

/**
 * Send a payment with viem. The equivalent of buildAndSendPayment in src/send/saga.
 *
 * @param options an object containing the arguments
 * @param options.context the transaction context
 * @param options.recipientAddress the address to send the payment to
 * @param options.amount the crypto amount to send
 * @param options.tokenAddress the crypto token address
 * @param options.comment the comment on the transaction
 * @param options.feeInfo an object containing the fee information
 * @returns
 */
export function* sendPayment({
  context,
  recipientAddress,
  amount,
  tokenId,
  comment,
  feeInfo,
  preparedTransaction,
}: {
  context: TransactionContext
  recipientAddress: string
  amount: BigNumber
  tokenId: string
  comment: string
  feeInfo?: FeeInfo
  preparedTransaction?: SerializableTransactionRequest
}) {
  const tokenInfo = yield* call(getTokenInfo, tokenId)
  const network = getNetworkFromNetworkId(tokenInfo?.networkId)
  if (!tokenInfo || !network) {
    throw new Error('Unknown token network')
  }
  const networkId = tokenInfo.networkId

  const wallet = yield* call(getViemWallet, networkConfig.viemChain[network])

  if (!wallet.account) {
    // this should never happen
    throw new Error('no account found in the wallet')
  }

  Logger.debug(
    TAG,
    'Transferring token',
    context.description ?? 'No description',
    context.id,
    tokenId,
    amount,
    feeInfo
  )

  const unlockWallet = function* () {
    // This will never happen, but Typescript complains otherwise
    if (!wallet.account) {
      throw new Error('no account found in the wallet')
    }

    // unlock account before executing tx
    yield* call(unlockAccount, wallet.account.address)
  }

  const feeCurrency: string | undefined =
    preparedTransaction && getFeeCurrency(getPreparedTransaction(preparedTransaction))
  const feeCurrencyId = getTokenId(networkId, feeCurrency)

  const addPendingStandbyTransaction = function* (hash: string) {
    yield* put(
      addStandbyTransaction({
        __typename: 'TokenTransferV3',
        type: TokenTransactionTypeV2.Sent,
        context,
        networkId,
        amount: {
          value: amount.negated().toString(),
          tokenAddress: tokenInfo.address ?? undefined,
          tokenId,
        },
        address: recipientAddress,
        metadata: {
          comment,
        },
        transactionHash: hash,
        feeCurrencyId,
      })
    )
  }

  // For tokens with an address, we simulate calling 'transfer' on the contract,
  // take the request generated by that simulation, and execute that request
  //
  // For tokens with no address, we perform a simple `call` to test the request.
  try {
    if (tokenBalanceHasAddress(tokenInfo)) {
      // this returns a method which is then passed to call instead of directly
      // doing yield* call(publicClient.celo.simulateContract, args) because this
      // results in a long TS error
      const simulateContractMethod = yield* call(getTransferSimulateContract, {
        wallet,
        tokenInfo,
        amount,
        recipientAddress,
        comment,
        feeInfo,
        preparedTransaction,
      })

      const { request } = yield* call(simulateContractMethod)

      yield* call(unlockWallet)

      const sendContractTxMethod = function* () {
        const hash = yield* call(
          wallet.writeContract,
          request as SimulateContractReturnType['request']
        )
        yield* call(addPendingStandbyTransaction, hash)
        return hash
      }

      const receipt = yield* call(sendAndMonitorTransaction, {
        context,
        network,
        sendTx: sendContractTxMethod,
        feeCurrencyId,
      })

      return receipt
    } else {
      const convertedAmount = BigInt(tokenAmountInSmallestUnit(amount, tokenInfo.decimals))

      let feeFields: Pick<TransactionRequest, 'gas' | 'maxFeePerGas'> = {
        gas: undefined,
        maxFeePerGas: undefined,
      }
      if (preparedTransaction) {
        const preparedTx = getPreparedTransaction(preparedTransaction)
        feeFields = {
          gas: preparedTx.gas,
          maxFeePerGas: preparedTx.maxFeePerGas,
        }
      }

      // This call method will throw an error if there are issues with the TX (namely,
      // if there are insufficient funds to pay for gas).
      const callMethod = () =>
        publicClient[network].call({
          account: wallet.account,
          to: getAddress(recipientAddress),
          value: convertedAmount,
          ...feeFields,
        })

      Logger.debug(TAG, 'Invoking call for native token transfer', {
        recipientAddress,
        convertedAmount: convertedAmount.toString(),
        network,
        gas: feeFields.gas?.toString(),
        maxFeePerGas: feeFields.maxFeePerGas?.toString(),
      })

      yield* call(callMethod)
      yield* call(unlockWallet)

      const sendNativeTxMethod = function* () {
        if (!wallet.account) {
          throw new Error('no account found in the wallet')
        }

        const hash = yield* call([wallet, 'sendTransaction'], {
          account: wallet.account,
          to: getAddress(recipientAddress),
          value: convertedAmount,
          chain: networkConfig.viemChain[network],
          ...feeFields,
        })

        yield* call(addPendingStandbyTransaction, hash)

        return hash
      }

      const receipt = yield* call(sendAndMonitorTransaction, {
        context,
        network,
        sendTx: sendNativeTxMethod,
        feeCurrencyId,
      })
      return receipt
    }
  } catch (err) {
    Logger.error(TAG, JSON.stringify(err, null, 4))
    Logger.warn(TAG, 'Transaction failed', err)
    throw err
  }
}

/**
 * Gets a function that invokes simulateContract for the appropriate contract
 * method based on the token. If the token is a stable token, it uses the
 * `transferWithComment` on the stable token contract, otherwise the `transfer`
 * method on the ERC20 contract
 *
 * @param options an object containing the arguments
 * @returns a function that invokes the simulateContract method
 */
function* getTransferSimulateContract({
  wallet,
  tokenInfo,
  amount,
  recipientAddress,
  comment,
  feeInfo,
  preparedTransaction,
}: {
  wallet: ViemWallet
  tokenInfo: TokenBalanceWithAddress
  recipientAddress: string
  amount: BigNumber
  comment: string
  feeInfo?: FeeInfo
  preparedTransaction?: SerializableTransactionRequest
}) {
  if (!wallet.account) {
    // this should never happen
    throw new Error('no account found in the wallet')
  }

  const convertedAmount = BigInt(tokenAmountInSmallestUnit(amount, tokenInfo.decimals))

  const encryptedComment = tokenSupportsComments(tokenInfo)
    ? yield* call(encryptComment, comment, recipientAddress, wallet.account.address, true)
    : undefined

  const network = getNetworkFromNetworkId(tokenInfo.networkId)
  if (!network) {
    throw new Error('invalid network for transfer')
  }

  let feeFields: Pick<TransactionRequest, 'gas' | 'maxFeePerGas'> & { feeCurrency?: string } = {
    gas: undefined,
    maxFeePerGas: undefined,
  }

  if (preparedTransaction) {
    const preparedTx = getPreparedTransaction(preparedTransaction)
    feeFields = {
      gas: preparedTx.gas,
      maxFeePerGas: preparedTx.maxFeePerGas,
    }
    // @ts-ignore feeCurrency should only be present if tx type is cip42, but we never
    // actually set the tx type to cip42 anywhere, but we /do/ set feeCurrency.
    // TODO: Remove this once we directly use preparedTransaction to send the TX
    // and get rid of simulateContract calls.
    if (preparedTx.feeCurrency) {
      // @ts-ignore
      feeFields.feeCurrency = preparedTx.feeCurrency
    }
  } else if (feeInfo) {
    feeFields = yield* call(getSendTxFeeDetails, {
      recipientAddress,
      amount,
      tokenAddress: tokenInfo.address,
      feeInfo,
      encryptedComment: encryptedComment || '',
    })
  }

  if (tokenSupportsComments(tokenInfo)) {
    Logger.debug(TAG, 'Calling simulate contract for transferWithComment', {
      recipientAddress,
      convertedAmount: convertedAmount.toString(),
      tokenAddress: tokenInfo.address,
      network,
      feeCurrency: feeFields.feeCurrency,
      gas: feeFields.gas?.toString(),
      maxFeePerGas: feeFields.maxFeePerGas?.toString(),
    })

    return () =>
      publicClient.celo.simulateContract({
        address: getAddress(tokenInfo.address),
        abi: stableToken.abi,
        functionName: 'transferWithComment',
        account: wallet.account,
        args: [getAddress(recipientAddress), convertedAmount, encryptedComment || ''],
        ...feeFields,
      })
  }

  Logger.debug(TAG, 'Calling simulate contract for transfer', {
    recipientAddress,
    convertedAmount: convertedAmount.toString(),
    tokenAddress: tokenInfo.address,
    network,
    feeCurrency: feeFields.feeCurrency,
    gas: feeFields.gas?.toString(),
    maxFeePerGas: feeFields.maxFeePerGas?.toString(),
  })

  return () =>
    publicClient[network].simulateContract({
      address: getAddress(tokenInfo.address),
      abi: erc20.abi,
      functionName: 'transfer',
      account: wallet.account,
      args: [getAddress(recipientAddress), convertedAmount],
      ...feeFields,
    })
}

/**
 * Helper function to call chooseTxFeeDetails for send transactions (aka
 * transfer contract calls) using parameters that are not specific to contractkit
 *
 * @deprecated will be cleaned up when old send flow is removed
 * @param options the getSendTxFeeDetails options
 * @returns an object with the feeInfo compatible with viem
 */
export function* getSendTxFeeDetails({
  recipientAddress,
  amount,
  tokenAddress,
  feeInfo,
  encryptedComment,
}: {
  recipientAddress: string
  amount: BigNumber
  tokenAddress: string
  feeInfo: FeeInfo
  encryptedComment?: string
}) {
  const celoTx = yield* call(
    buildSendTx,
    tokenAddress,
    amount,
    recipientAddress,
    encryptedComment || ''
  )
  const { feeCurrency, gas, gasPrice } = yield* call(
    chooseTxFeeDetails,
    celoTx.txo,
    feeInfo.feeCurrency,
    // gas and gasPrice can either be BigNumber or string. Since these are
    // stored in redux, BigNumbers are serialized as strings.
    Number(feeInfo.gas),
    feeInfo.gasPrice
  )
  // Return fields in format compatible with viem
  return {
    // Don't include the feeCurrency field if not present. Otherwise viem throws
    // saying feeCurrency is required for CIP-42 transactions. Not setting the
    // field at all bypasses this check and the tx succeeds with fee paid with
    // CELO.
    ...(feeCurrency && { feeCurrency: getAddress(feeCurrency) }),
    gas: gas ? BigInt(gas) : undefined,
    maxFeePerGas: gasPrice ? BigInt(Number(gasPrice)) : undefined,
  }
}

export function* sendAndMonitorTransaction({
  context,
  network,
  sendTx,
  feeCurrencyId,
}: {
  context: TransactionContext
  network: Network
  sendTx: () => Generator<any, Hash, any>
  feeCurrencyId: string
}) {
  Logger.debug(TAG + '@sendAndMonitorTransaction', `Sending transaction with id: ${context.id}`)

  const commonTxAnalyticsProps = { txId: context.id, web3Library: 'viem' as const }

  ValoraAnalytics.track(TransactionEvents.transaction_start, {
    ...commonTxAnalyticsProps,
    description: context.description,
  })

  const sendTxMethod = function* () {
    const hash = yield* call(sendTx)
    ValoraAnalytics.track(TransactionEvents.transaction_hash_received, {
      ...commonTxAnalyticsProps,
      txHash: hash,
    })
    const receipt = yield* call([publicClient[network], 'waitForTransactionReceipt'], { hash })

    ValoraAnalytics.track(TransactionEvents.transaction_receipt_received, commonTxAnalyticsProps)
    return receipt as unknown as TransactionReceipt // Need to cast here else the wrapSendTransactionWithRetry call complains
  }

  try {
    // Reuse existing method which times out the sendTxMethod and includes some
    // grace period logic to handle app backgrounding when sending.
    // there is a bug with 'race' in typed-redux-saga, so we need to hard cast the result
    // https://github.com/agiledigital/typed-redux-saga/issues/43#issuecomment-1259706876
    const receipt = (yield* call(
      wrapSendTransactionWithRetry,
      sendTxMethod,
      context
    )) as unknown as TransactionReceipt

    yield* call(
      handleTransactionReceiptReceived,
      context.id,
      receipt,
      networkConfig.networkToNetworkId[network],
      feeCurrencyId
    )

    if (receipt.status === 'reverted') {
      throw new Error('transaction reverted')
    }
    ValoraAnalytics.track(TransactionEvents.transaction_confirmed, commonTxAnalyticsProps)
    yield* put(fetchTokenBalances({ showLoading: true }))
    return receipt
  } catch (err) {
    const error = ensureError(err)
    Logger.error(TAG + '@sendAndMonitorTransaction', `Error sending tx ${context.id}`, error)
    ValoraAnalytics.track(TransactionEvents.transaction_exception, {
      ...commonTxAnalyticsProps,
      error: error.message,
    })
    yield* put(showError(ErrorMessages.TRANSACTION_FAILED))
    throw error
  }
}
