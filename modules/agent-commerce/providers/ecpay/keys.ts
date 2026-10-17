import { Buffer } from 'node:buffer';
import { EcpayProtocolError } from './errors.js';

const KEY_PATTERN = /^[A-Za-z0-9]{16}$/;
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const PRIVATE_CONSTRUCTOR_TOKEN = Symbol('EcpayKeyPair');

export interface KeyMaterial {
  readonly hashKey: string;
  readonly hashIV: string;
  readonly keyBytes: Buffer;
  readonly ivBytes: Buffer;
}

const keyStore = new WeakMap<EcpayKeyPair, KeyMaterial>();

export class EcpayKeyPair {
  private constructor(token: symbol) {
    if (token !== PRIVATE_CONSTRUCTOR_TOKEN) {
      throw new EcpayProtocolError('invalid_key');
    }
    Object.freeze(this);
  }

  static of(hashKey: string, hashIV: string): EcpayKeyPair {
    if (
      typeof hashKey !== 'string' ||
      typeof hashIV !== 'string' ||
      !KEY_PATTERN.test(hashKey) ||
      !KEY_PATTERN.test(hashIV)
    ) {
      throw new EcpayProtocolError('invalid_key');
    }
    const instance = new EcpayKeyPair(PRIVATE_CONSTRUCTOR_TOKEN);
    const material: KeyMaterial = Object.freeze({
      hashKey,
      hashIV,
      keyBytes: Buffer.from(hashKey, 'utf8'),
      ivBytes: Buffer.from(hashIV, 'utf8'),
    });
    keyStore.set(instance, material);
    return instance;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [INSPECT_CUSTOM](): string {
    return 'EcpayKeyPair [redacted]';
  }
}

Object.freeze(EcpayKeyPair);
Object.freeze(EcpayKeyPair.prototype);

export function unwrapKeyPair(keys: unknown): KeyMaterial {
  if (!(keys instanceof EcpayKeyPair)) {
    throw new EcpayProtocolError('invalid_key');
  }
  const material = keyStore.get(keys);
  if (!material) {
    throw new EcpayProtocolError('invalid_key');
  }
  return material;
}

export function unwrapKeyList(keys: unknown): readonly KeyMaterial[] {
  if (keys instanceof EcpayKeyPair) {
    return [unwrapKeyPair(keys)];
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new EcpayProtocolError('invalid_key');
  }
  const materials: KeyMaterial[] = [];
  for (const item of keys) {
    materials.push(unwrapKeyPair(item));
  }
  return materials;
}
