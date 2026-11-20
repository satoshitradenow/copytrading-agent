/**
 * Read-only vault destination identity verification.
 *
 * The `HL:` prefix occurs in user-facing address labels; Hyperliquid's API
 * accepts the 42-character 0x address, NOT the display prefix. This module
 * never imports a signer and never calls /exchange.
 *
 * Keep personally associated vault addresses in runtime configuration, not
 * in repository source or GitHub test fixtures.
 */
import {readVaultPublicState, validateAddress} from './hyperliquidRead.mjs';

export function normalizeVaultIdentifier(value) {
  if(typeof value !== 'string') throw Error('Vault identifier must be a string');
  const trimmed = value.trim();
  const address = trimmed.startsWith('HL:') ? trimmed.slice(3) : trimmed;
  return validateAddress(address);
}

/** Read-only destination validation. This is NOT proof of signing authority. */
export async function verifyVaultDestination({identifier,expectedLeader=null,expectedName=null,readState=readVaultPublicState}={}) {
  const address = normalizeVaultIdentifier(identifier);
  if(typeof readState !== 'function') throw Error('Read-only vault reader required');
  const requiredLeader = expectedLeader === null ? null : validateAddress(expectedLeader);
  if(expectedName !== null && (typeof expectedName !== 'string' || !expectedName.trim()))
    throw Error('Expected vault name must be a nonempty string');
  const result = await readState(address);
  if(!result || result.mode !== 'READ_ONLY') throw Error('Vault verification requires a read-only response');
  if(normalizeVaultIdentifier(result.vaultAddress) !== address)
    throw Error('Destination vault address mismatch; refuse configuration');
  const observedLeader = validateAddress(result.leader);
  if(requiredLeader !== null && observedLeader !== requiredLeader)
    throw Error('Destination vault leader mismatch; refuse configuration');
  if(expectedName !== null && result.name !== expectedName)
    throw Error('Destination vault name mismatch; refuse configuration');
  if(typeof result.accountValueUsd !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(result.accountValueUsd))
    throw Error('Invalid vault account equity');
  if(!Array.isArray(result.positions)) throw Error('Missing vault position array');
  return Object.freeze({mode:'READ_ONLY',verified:true,vaultAddress:address,
    name:result.name??null,leader:observedLeader,
    accountValueUsd:result.accountValueUsd,positionCount:result.positions.length,
    signingAuthorityVerified:false,
    note:'Public vault identity verified. API agent signing and vault trading permission NOT verified.'});
}