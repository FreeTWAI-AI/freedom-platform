import { buildCheckMacSigningInput } from '../../../modules/agent-commerce/providers/ecpay/checkmac.js';
import {
  ECPAY_ACK,
  ECPAY_ORIGINS,
  EcpayKeyPair,
  aesDecryptString,
  aesEncryptString,
  aio,
  computeCheckMacValue,
  decryptData,
  dotnetUrlEncode,
  encodeForm,
  encryptData,
  invoice,
  isTradeNumber,
  logistics,
  newTradeNumber,
  signFields,
  verifySignedForm,
} from '../../../modules/agent-commerce/providers/ecpay/index.js';
import {
  AES_VECTORS,
  AIO_CHECKOUT_2902_INTERMEDIATE,
  CHECKMAC_VECTORS,
  DOTNET_URL_ENCODE_TABLE,
  STAGE_KEYS,
  SYNTHETIC_INVOICE_ROUNDTRIP,
  TRADE_NUMBER_VECTORS,
} from './vectors.js';

export interface DeterministicVectorResults {
  readonly checkMac: ReadonlyArray<{
    readonly id: string;
    readonly mac: string;
    readonly encodedBody: string;
    readonly verifiedOk: boolean;
    readonly verifiedFields: Readonly<Record<string, string>> | null;
    readonly verifiedKeyIndex: number | null;
    readonly serviceVerifiedOk: boolean;
    readonly staleDocRejected: boolean | null;
  }>;
  readonly intermediate2902: string;
  readonly dotnetTable: ReadonlyArray<readonly [string, string, string]>;
  readonly aes: ReadonlyArray<{
    readonly id: string;
    readonly encryptedRaw: string;
    readonly decryptedRaw: string;
    readonly encryptedData: string | null;
    readonly decryptedData: unknown;
  }>;
  readonly tradeNumbers: ReadonlyArray<{
    readonly id: string;
    readonly value: string;
    readonly valid: boolean;
  }>;
  readonly signEncodeVerifyRoundTrip: {
    readonly encoded: string;
    readonly verified: {
      readonly ok: boolean;
      readonly fields: Readonly<Record<string, string>> | null;
      readonly keyIndex: number | null;
    };
    readonly logisticsCreated: {
      readonly kind: string;
      readonly fields: Readonly<Record<string, string>> | null;
    };
  };
  readonly encryptDecryptRoundTrip: {
    readonly urlEncodedJson: string;
    readonly ciphertext: string;
    readonly decrypted: unknown;
    readonly envelope: unknown;
    readonly openedResponse: unknown;
  };
  readonly constants: {
    readonly ack: string;
    readonly origins: typeof ECPAY_ORIGINS;
  };
}

export interface WorkerProtocolPayload {
  readonly deterministic: DeterministicVectorResults;
  readonly defaultRandomTradeNumber: {
    readonly value: string;
    readonly validF: boolean;
    readonly validL: boolean;
  };
}

export function evaluateDeterministicVectors(): DeterministicVectorResults {
  const checkMac = CHECKMAC_VECTORS.map((vec) => {
    const keys = EcpayKeyPair.of(vec.keys.hashKey, vec.keys.hashIV);
    const mac = computeCheckMacValue(vec.fields, keys, vec.algorithm);
    const signed = signFields(vec.fields, keys, vec.algorithm);
    const encodedBody = encodeForm(signed);
    const verified = verifySignedForm(encodedBody, keys, vec.algorithm);

    const serviceVerified =
      vec.id === 'invoice-allowance'
        ? invoice.verifyAllowanceCallback(encodedBody, keys)
        : vec.algorithm === 'sha256'
          ? aio.verify(encodedBody, keys)
          : logistics.verify(encodedBody, keys);

    let staleDocRejected: boolean | null = null;
    if (vec.staleDocMac) {
      const staleBody = encodeForm([...vec.fields, ['CheckMacValue', vec.staleDocMac]]);
      const staleRes = verifySignedForm(staleBody, keys, vec.algorithm);
      staleDocRejected = !staleRes.ok && staleRes.reason === 'mac_mismatch';
    }

    return {
      id: vec.id,
      mac,
      encodedBody,
      verifiedOk: verified.ok,
      verifiedFields: verified.ok ? { ...verified.fields } : null,
      verifiedKeyIndex: verified.ok ? verified.keyIndex : null,
      serviceVerifiedOk: serviceVerified.ok,
      staleDocRejected,
    };
  });

  const aio2902Vec = CHECKMAC_VECTORS[0];
  const aio2902Keys = EcpayKeyPair.of(aio2902Vec.keys.hashKey, aio2902Vec.keys.hashIV);
  const intermediate2902 = buildCheckMacSigningInput(aio2902Vec.fields, aio2902Keys);

  const dotnetTable = DOTNET_URL_ENCODE_TABLE.map(([input, expectedLower]) => {
    const encoded = dotnetUrlEncode(input);
    return [input, encoded, encoded.toLowerCase()] as const;
  });

  const aes = AES_VECTORS.map((vec) => {
    const keys = EcpayKeyPair.of(vec.keys.hashKey, vec.keys.hashIV);
    const encryptedRaw = aesEncryptString(vec.urlEncodedInput, keys);
    const decryptedRaw = aesDecryptString(vec.expectedCiphertext, keys);
    const encryptedData = vec.encodedCase === 'upper' ? encryptData(vec.payload, keys) : null;
    const decryptedData = decryptData(vec.expectedCiphertext, keys);
    return {
      id: vec.id,
      encryptedRaw,
      decryptedRaw,
      encryptedData,
      decryptedData,
    };
  });

  const tradeNumbers = TRADE_NUMBER_VECTORS.map((vec) => {
    const value = newTradeNumber(vec.prefix, () => new Uint8Array(vec.bytes));
    return {
      id: vec.id,
      value,
      valid: isTradeNumber(value, vec.prefix),
    };
  });

  const aioKeys = EcpayKeyPair.of(STAGE_KEYS.aio3002607.hashKey, STAGE_KEYS.aio3002607.hashIV);
  const roundTripFields = [
    ['MerchantID', '3002607'],
    ['MerchantTradeNo', 'F0000000000000000000'],
    ['RtnCode', '1'],
    ['RtnMsg', '合成測試 A+B ~!(1)*'],
    ['TradeAmt', '1500'],
  ] as const;
  const signedRoundTrip = aio.sign(roundTripFields, aioKeys);
  const encodedRoundTrip = encodeForm(signedRoundTrip);
  const verifiedRoundTrip = aio.verify(encodedRoundTrip, aioKeys);

  const logisticsKeys = EcpayKeyPair.of(
    STAGE_KEYS.logisticsC2c2000933.hashKey,
    STAGE_KEYS.logisticsC2c2000933.hashIV,
  );
  const signedLogistics = logistics.sign(
    [
      ['AllPayLogisticsID', '9911223'],
      ['MerchantID', '2000933'],
      ['MerchantTradeNo', 'L000G40R40M30E209185'],
      ['RtnCode', '300'],
      ['RtnMsg', '訂單處理中'],
    ],
    logisticsKeys,
  );
  const logisticsCreated = logistics.parseCreateResponse(
    `1|${encodeForm(signedLogistics)}`,
    logisticsKeys,
  );

  const invoiceKeys = EcpayKeyPair.of(
    STAGE_KEYS.invoice2000132.hashKey,
    STAGE_KEYS.invoice2000132.hashIV,
  );
  const urlEncodedJson = dotnetUrlEncode(JSON.stringify(SYNTHETIC_INVOICE_ROUNDTRIP.payload));
  const ciphertext = encryptData(SYNTHETIC_INVOICE_ROUNDTRIP.payload, invoiceKeys);
  const decrypted = decryptData(ciphertext, invoiceKeys);
  const envelope = invoice.buildEnvelope(
    {
      merchantId: '2000132',
      timestamp: 1700000000,
      payload: SYNTHETIC_INVOICE_ROUNDTRIP.payload,
    },
    invoiceKeys,
  );
  const responseDataCiphertext = encryptData(
    {
      RtnCode: 1,
      RtnMsg: '開立成功',
      InvoiceNo: 'AB12345678',
      RelateNumber: SYNTHETIC_INVOICE_ROUNDTRIP.payload.RelateNumber,
    },
    invoiceKeys,
  );
  const openedResponse = invoice.openResponse(
    JSON.stringify({
      PlatformID: '',
      MerchantID: '2000132',
      TransCode: 1,
      TransMsg: '',
      Data: responseDataCiphertext,
    }),
    invoiceKeys,
    { merchantId: '2000132' },
  );

  return {
    checkMac,
    intermediate2902,
    dotnetTable,
    aes,
    tradeNumbers,
    signEncodeVerifyRoundTrip: {
      encoded: encodedRoundTrip,
      verified: {
        ok: verifiedRoundTrip.ok,
        fields: verifiedRoundTrip.ok ? { ...verifiedRoundTrip.fields } : null,
        keyIndex: verifiedRoundTrip.ok ? verifiedRoundTrip.keyIndex : null,
      },
      logisticsCreated: {
        kind: logisticsCreated.kind,
        fields: logisticsCreated.kind === 'created' ? { ...logisticsCreated.fields } : null,
      },
    },
    encryptDecryptRoundTrip: {
      urlEncodedJson,
      ciphertext,
      decrypted,
      envelope,
      openedResponse,
    },
    constants: {
      ack: ECPAY_ACK,
      origins: ECPAY_ORIGINS,
    },
  };
}

export default {
  async fetch(): Promise<Response> {
    const deterministic = evaluateDeterministicVectors();
    const randomValue = newTradeNumber('F');
    const payload: WorkerProtocolPayload = {
      deterministic,
      defaultRandomTradeNumber: {
        value: randomValue,
        validF: isTradeNumber(randomValue, 'F'),
        validL: isTradeNumber(randomValue, 'L'),
      },
    };
    assert2902Matches(deterministic.intermediate2902);
    return Response.json(payload);
  },
};

function assert2902Matches(actual: string): void {
  if (actual !== AIO_CHECKOUT_2902_INTERMEDIATE.urlEncodedLower) {
    throw new Error('2902 intermediate mismatch in workerd');
  }
}
