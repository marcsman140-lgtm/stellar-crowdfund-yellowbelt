import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit';
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { rpc, Contract, TransactionBuilder, Networks, Address, nativeToScVal, scValToNative, Account } from '@stellar/stellar-sdk';

export const CONTRACT_ADDRESS = 'CBR6QK474MHMNPS2XOUSKV4BLG27HBM7LQ2IB6NG7KQMNNS7LV5I4TVS';
export const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE = Networks.TESTNET;

const server = new rpc.Server(SOROBAN_RPC_URL);
const contract = new Contract(CONTRACT_ADDRESS);

// Initialize StellarWalletsKit statically per official v2.5+ specs
StellarWalletsKit.init({
  network: NETWORK_PASSPHRASE,
  selectedWalletId: 'freighter',
  modules: [
    new FreighterModule(),
    new AlbedoModule(),
  ],
});

/**
 * Connects via StellarWalletsKit Multi-Wallet Modal using static authModal().
 */
export async function connectMultiWallet() {
  try {
    const res = await StellarWalletsKit.authModal();
    const publicKey = res.address;
    return { publicKey, walletName: 'Stellar Wallet' };
  } catch (err) {
    if (err.message?.includes('closed') || err.message?.includes('reject') || err.message?.includes('cancel')) {
      throw new Error('USER_REJECTED: You dismissed or rejected the wallet connection modal.');
    }
    if (err.message?.includes('not found') || err.message?.includes('not installed')) {
      throw new Error('WALLET_NOT_FOUND: Selected extension or wallet provider is not installed.');
    }
    throw err;
  }
}

/**
 * Reads total accumulated donations directly from Soroban contract via RPC simulation.
 */
export async function fetchTotalDonations() {
  try {
    const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(contract.call('get_total'))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim) && sim.result?.retval) {
      const val = scValToNative(sim.result.retval);
      return Number(val) || 0;
    }
    return 0;
  } catch (err) {
    console.error('Error fetching total donations:', err);
    return 0;
  }
}

/**
 * Submits an on-chain donation by invoking the Soroban contract's donate function.
 * Matches exact parameter order & types defined in Rust: (donor: Address, amount: i128).
 */
export async function submitContractDonation(donorPublicKey, amount, onStatusChange) {
  try {
    onStatusChange('PREPARING', 'Fetching latest ledger state and preparing Soroban transaction...');
    const accountDetails = await server.getAccount(donorPublicKey).catch(() => null);
    
    if (!accountDetails) {
      throw new Error('INSUFFICIENT_BALANCE: Your account is either unfunded on Testnet or lacks sufficient balance.');
    }

    const tx = new TransactionBuilder(accountDetails, { fee: '10000', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(contract.call(
        'donate',
        new Address(donorPublicKey).toScVal(),
        nativeToScVal(BigInt(amount), { type: 'i128' })
      ))
      .setTimeout(180)
      .build();

    onStatusChange('SIMULATING', 'Simulating execution against Soroban Testnet RPC...');
    const sim = await server.simulateTransaction(tx);
    
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`CONTRACT_ERROR: Soroban execution failed during simulation. ${sim.error || 'Insufficient funds or gas limit.'}`);
    }

    const preparedTx = await server.prepareTransaction(tx, sim);
    
    onStatusChange('SIGNING', 'Awaiting your cryptographic signature in your selected wallet...');
    const xdr = preparedTx.toXDR();
    let signedXdr;
    try {
      const res = await StellarWalletsKit.signTransaction(xdr, { 
        networkPassphrase: NETWORK_PASSPHRASE,
        address: donorPublicKey 
      });
      signedXdr = typeof res === 'string' ? res : res.signedTxXdr || res.tx;
    } catch (signErr) {
      throw new Error('USER_REJECTED: User declined transaction signature in wallet popup.');
    }

    onStatusChange('SUBMITTING', 'Broadcasting signed invocation to Soroban consensus validators...');
    const txResponse = await server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE));

    if (txResponse.status === 'ERROR') {
      throw new Error(`CONTRACT_ERROR: Transaction broadcast rejected by validators (${txResponse.errorResultXdr || 'Unknown'}).`);
    }

    onStatusChange('PENDING', `Transaction dispatched (Hash: ${txResponse.hash.slice(0, 10)}...). Awaiting block sealing...`);

    // Poll until complete
    let attempts = 0;
    while (attempts < 20) {
      await new Promise(r => setTimeout(r, 2500));
      const statusRes = await server.getTransaction(txResponse.hash);
      if (statusRes.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        onStatusChange('SUCCESS', statusRes.hash);
        return statusRes.hash;
      } else if (statusRes.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error('CONTRACT_ERROR: On-chain Soroban contract execution failed during block consensus.');
      }
      attempts++;
    }
    throw new Error('CONTRACT_ERROR: Transaction timed out waiting for consensus.');
  } catch (error) {
    if (error.message.startsWith('USER_REJECTED') || error.message.startsWith('WALLET_NOT_FOUND') || error.message.startsWith('INSUFFICIENT_BALANCE') || error.message.startsWith('CONTRACT_ERROR')) {
      throw error;
    }
    throw new Error(`CONTRACT_ERROR: ${error.message}`);
  }
}

/**
 * Polls recent contract events for real-time live feed sync.
 */
export async function getRecentContractEvents(startLedger = 0) {
  try {
    const latestLedger = await server.getLatestLedger();
    const fromLedger = startLedger || Math.max(1, latestLedger.sequence - 100);
    const response = await server.getEvents({
      startLedger: fromLedger,
      filters: [{
        type: 'contract',
        contractIds: [CONTRACT_ADDRESS],
      }],
      limit: 10,
    });
    return { events: response.events || [], latestLedger: latestLedger.sequence };
  } catch (err) {
    return { events: [], latestLedger: startLedger };
  }
}
