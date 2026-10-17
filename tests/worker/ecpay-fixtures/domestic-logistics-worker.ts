import {
  ECPAY_DOMESTIC_LOGISTICS_PROFILE,
  ECPAY_LOGISTICS_SUBTYPES,
  buildCancelC2COrderRequest,
  buildCvsCreateOrderRequest,
  buildCvsMapForm,
  buildHomeCreateOrderRequest,
  buildLogisticsQueryRequest,
  buildPrintLabelForm,
  buildUpdateStoreRequest,
  parseCreateOrderResponse,
  parseCvsMapReturn,
  parseLogisticsAckResponse,
  parseLogisticsNotification,
  parseLogisticsQueryResponse,
  subTypeForServiceKey,
  type CreateOrderResponseResult,
  type EcpayLogisticsSubType,
  type EcpayLogisticsSubTypeDescriptor,
  type LogisticsAckResponseResult,
  type LogisticsQueryResponseResult,
  type ParseCvsMapReturnResult,
  type ParseLogisticsNotificationResult,
} from '../../../modules/agent-commerce/providers/ecpay/domestic-logistics/index.js';
import {
  EcpayKeyPair,
  encodeForm,
  findCdnBlockedTerm,
  logistics,
  parseForm,
  type FormFields,
} from '../../../modules/agent-commerce/providers/ecpay/index.js';
import {
  CANCEL_C2C_GOLDEN_VECTOR,
  CREATE_RESPONSE_GOLDEN_VECTORS,
  CVS_CREATE_ORDER_GOLDEN_VECTORS,
  DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
  HOME_CREATE_ORDER_GOLDEN_VECTORS,
  NOTIFICATION_GOLDEN_VECTOR,
  POST_WEIGHT_FORMATTING_VECTORS,
  PRINT_LABEL_GOLDEN_VECTORS,
  QUERY_REQUEST_GOLDEN_VECTORS,
  QUERY_RESPONSE_GOLDEN_VECTOR,
  UPDATE_STORE_GOLDEN_VECTORS,
} from './domestic-logistics-vectors.js';
import { CHECKMAC_VECTORS, STAGE_KEYS } from './vectors.js';

export const CDN_GUARD_WORKER_VECTORS: ReadonlyArray<
  readonly [string, string | null]
> = Object.freeze([
  ['Echo', 'Echo'],
  ['TFTP', 'TFTP'],
  ['net  localgroup', 'net  localgroup'],
  ['cmd /c', 'cmd /c'],
  ['CD ..', 'CD ..'],
  ['cd\\', 'cd\\'],
  ['chmod +x', 'chmod +x'],
  ['a;b', ';'],
  ['a|b', '|'],
  ['a`b', '`'],
  ['合成小舖', null],
  ['cmd', null],
  ['chmod 755', null],
  ['cdn', null],
  ['e c h o', null],
  ['net local group', null],
]);

export interface ServerRequestGoldenEvaluation {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly contentType: string;
  readonly bodyText: string;
  readonly fields: FormFields;
  readonly mac: string;
  readonly verifiedOk: boolean;
  readonly redactedJson: unknown;
  readonly redactedString: string;
}

export interface BrowserFormGoldenEvaluation {
  readonly id: string;
  readonly action: string;
  readonly method: string;
  readonly fields: FormFields;
  readonly mac: string;
  readonly encodedBody: string;
  readonly verifiedOk: boolean;
  readonly redactedJson: unknown;
  readonly redactedString: string;
}

export interface DomesticLogisticsWorkerEvaluation {
  readonly profile: string;
  readonly subTypes: Readonly<
    Record<EcpayLogisticsSubType, EcpayLogisticsSubTypeDescriptor>
  >;
  readonly serviceKeyLookups: ReadonlyArray<
    readonly [string, EcpayLogisticsSubType | null]
  >;
  readonly cvsCreateGoldens: readonly ServerRequestGoldenEvaluation[];
  readonly homeCreateGoldens: readonly ServerRequestGoldenEvaluation[];
  readonly queryRequestGoldens: readonly ServerRequestGoldenEvaluation[];
  readonly printGoldens: readonly BrowserFormGoldenEvaluation[];
  readonly cancelGolden: ServerRequestGoldenEvaluation;
  readonly updateStoreGoldens: readonly ServerRequestGoldenEvaluation[];
  readonly mapForm: {
    readonly action: string;
    readonly method: string;
    readonly fields: FormFields;
    readonly redactedJson: unknown;
    readonly redactedString: string;
  };
  readonly createResponseGoldens: ReadonlyArray<{
    readonly id: string;
    readonly signedMac: string;
    readonly result: CreateOrderResponseResult;
  }>;
  readonly notificationGolden: {
    readonly id: string;
    readonly signedMac: string;
    readonly result: ParseLogisticsNotificationResult;
  };
  readonly queryResponseGolden: {
    readonly id: string;
    readonly signedMac: string;
    readonly result: LogisticsQueryResponseResult;
  };
  readonly officialQueryV5: {
    readonly validMac: LogisticsQueryResponseResult;
    readonly staleDocMac: LogisticsQueryResponseResult;
  };
  readonly mapReturn: ParseCvsMapReturnResult;
  readonly ackResponses: ReadonlyArray<{
    readonly input: string;
    readonly result: LogisticsAckResponseResult;
  }>;
  readonly weightFormatting: ReadonlyArray<readonly [number, string]>;
  readonly cdnGuard: ReadonlyArray<readonly [string, string | null]>;
}

function keyPairFromSpec(spec: {
  readonly hashKey: string;
  readonly hashIV: string;
}): EcpayKeyPair {
  return EcpayKeyPair.of(spec.hashKey, spec.hashIV);
}

export function evaluateDomesticLogisticsVectors(): DomesticLogisticsWorkerEvaluation {
  const cvsCreateGoldens: ServerRequestGoldenEvaluation[] =
    CVS_CREATE_ORDER_GOLDEN_VECTORS.map((vec) => {
      const keys = keyPairFromSpec(vec.keys);
      const req = buildCvsCreateOrderRequest(vec.input, keys);
      const bodyText = req.bodyText();
      const fields = parseForm(bodyText);
      const verified = logistics.verify(bodyText, keys);
      return {
        id: vec.id,
        url: req.url,
        method: req.method,
        contentType: req.contentType,
        bodyText,
        fields,
        mac: fields[fields.length - 1][1],
        verifiedOk: verified.ok,
        redactedJson: JSON.parse(JSON.stringify(req)),
        redactedString: String(req),
      };
    });

  const homeCreateGoldens: ServerRequestGoldenEvaluation[] =
    HOME_CREATE_ORDER_GOLDEN_VECTORS.map((vec) => {
      const keys = keyPairFromSpec(vec.keys);
      const req = buildHomeCreateOrderRequest(vec.input, keys);
      const bodyText = req.bodyText();
      const fields = parseForm(bodyText);
      const verified = logistics.verify(bodyText, keys);
      return {
        id: vec.id,
        url: req.url,
        method: req.method,
        contentType: req.contentType,
        bodyText,
        fields,
        mac: fields[fields.length - 1][1],
        verifiedOk: verified.ok,
        redactedJson: JSON.parse(JSON.stringify(req)),
        redactedString: String(req),
      };
    });

  const queryRequestGoldens: ServerRequestGoldenEvaluation[] =
    QUERY_REQUEST_GOLDEN_VECTORS.map((vec) => {
      const keys = keyPairFromSpec(vec.keys);
      const req = buildLogisticsQueryRequest(vec.input, keys);
      const bodyText = req.bodyText();
      const fields = parseForm(bodyText);
      const verified = logistics.verify(bodyText, keys);
      return {
        id: vec.id,
        url: req.url,
        method: req.method,
        contentType: req.contentType,
        bodyText,
        fields,
        mac: fields[fields.length - 1][1],
        verifiedOk: verified.ok,
        redactedJson: JSON.parse(JSON.stringify(req)),
        redactedString: String(req),
      };
    });

  const printGoldens: BrowserFormGoldenEvaluation[] =
    PRINT_LABEL_GOLDEN_VECTORS.map((vec) => {
      const keys = keyPairFromSpec(vec.keys);
      const form = buildPrintLabelForm(vec.input, keys);
      const fields = form.fields();
      const encodedBody = encodeForm(fields);
      const verified = logistics.verify(encodedBody, keys);
      return {
        id: vec.id,
        action: form.action,
        method: form.method,
        fields,
        mac: fields[fields.length - 1][1],
        encodedBody,
        verifiedOk: verified.ok,
        redactedJson: JSON.parse(JSON.stringify(form)),
        redactedString: String(form),
      };
    });

  const cancelKeys = keyPairFromSpec(CANCEL_C2C_GOLDEN_VECTOR.keys);
  const cancelReq = buildCancelC2COrderRequest(
    CANCEL_C2C_GOLDEN_VECTOR.input,
    cancelKeys,
  );
  const cancelBody = cancelReq.bodyText();
  const cancelFields = parseForm(cancelBody);
  const cancelVerified = logistics.verify(cancelBody, cancelKeys);
  const cancelGolden: ServerRequestGoldenEvaluation = {
    id: CANCEL_C2C_GOLDEN_VECTOR.id,
    url: cancelReq.url,
    method: cancelReq.method,
    contentType: cancelReq.contentType,
    bodyText: cancelBody,
    fields: cancelFields,
    mac: cancelFields[cancelFields.length - 1][1],
    verifiedOk: cancelVerified.ok,
    redactedJson: JSON.parse(JSON.stringify(cancelReq)),
    redactedString: String(cancelReq),
  };

  const updateStoreGoldens: ServerRequestGoldenEvaluation[] =
    UPDATE_STORE_GOLDEN_VECTORS.map((vec) => {
      const keys = keyPairFromSpec(vec.keys);
      const req = buildUpdateStoreRequest(vec.input, keys);
      const bodyText = req.bodyText();
      const fields = parseForm(bodyText);
      const verified = logistics.verify(bodyText, keys);
      return {
        id: vec.id,
        url: req.url,
        method: req.method,
        contentType: req.contentType,
        bodyText,
        fields,
        mac: fields[fields.length - 1][1],
        verifiedOk: verified.ok,
        redactedJson: JSON.parse(JSON.stringify(req)),
        redactedString: String(req),
      };
    });

  const builtMapForm = buildCvsMapForm({
    environment: 'sandbox',
    merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
    subType: 'UNIMARTC2C',
    serverReplyUrl: DOMESTIC_LOGISTICS_SERVER_REPLY_URL,
    extraData: 'A1b2C3d4E5f6G7h8J9k0',
    device: 'desktop',
  });

  const createResponseGoldens = CREATE_RESPONSE_GOLDEN_VECTORS.map((vec) => {
    const keys = keyPairFromSpec(vec.keys);
    const signedFields = logistics.sign(vec.unsignedFields, keys);
    const signedMac = signedFields[signedFields.length - 1][1];
    const text = `1|${encodeForm(signedFields)}`;
    const result = parseCreateOrderResponse(text, keys, vec.options);
    return {
      id: vec.id,
      signedMac,
      result,
    };
  });

  const notifKeys = keyPairFromSpec(NOTIFICATION_GOLDEN_VECTOR.keys);
  const notifSigned = logistics.sign(
    NOTIFICATION_GOLDEN_VECTOR.unsignedFields,
    notifKeys,
  );
  const notifSignedMac = notifSigned[notifSigned.length - 1][1];
  const notifBody = encodeForm(notifSigned);
  const notifResult = parseLogisticsNotification(
    notifBody,
    notifKeys,
    NOTIFICATION_GOLDEN_VECTOR.options,
  );

  const queryRespKeys = keyPairFromSpec(QUERY_RESPONSE_GOLDEN_VECTOR.keys);
  const queryRespSigned = logistics.sign(
    QUERY_RESPONSE_GOLDEN_VECTOR.unsignedFields,
    queryRespKeys,
  );
  const queryRespSignedMac = queryRespSigned[queryRespSigned.length - 1][1];
  const queryRespBody = encodeForm(queryRespSigned);
  const queryRespResult = parseLogisticsQueryResponse(
    queryRespBody,
    queryRespKeys,
    QUERY_RESPONSE_GOLDEN_VECTOR.options,
  );

  const officialV5Vector = CHECKMAC_VECTORS.find(
    (v) => v.id === 'logistics-query-v5',
  )!;
  const officialV5Keys = keyPairFromSpec(officialV5Vector.keys);
  const officialV5ValidBody = encodeForm([
    ...officialV5Vector.fields,
    ['CheckMacValue', officialV5Vector.expectedMac],
  ]);
  const officialV5StaleBody = encodeForm([
    ...officialV5Vector.fields,
    ['CheckMacValue', officialV5Vector.staleDocMac!],
  ]);
  const officialQueryV5 = {
    validMac: parseLogisticsQueryResponse(officialV5ValidBody, officialV5Keys, {
      merchantId: officialV5Vector.keys.merchantId,
      allPayLogisticsId: '1817824',
    }),
    staleDocMac: parseLogisticsQueryResponse(
      officialV5StaleBody,
      officialV5Keys,
      {
        merchantId: officialV5Vector.keys.merchantId,
        allPayLogisticsId: '1817824',
      },
    ),
  };

  const mapReturnBody = encodeForm([
    ['MerchantID', STAGE_KEYS.logisticsC2c2000933.merchantId],
    ['MerchantTradeNo', ''],
    ['LogisticsSubType', 'UNIMARTC2C'],
    ['CVSStoreID', '131386'],
    ['CVSStoreName', '合成門市'],
    ['CVSAddress', '臺北市中正區合成路3號'],
    ['CVSTelephone', '02-23456789'],
    ['CVSOutSide', '0'],
    ['ExtraData', 'A1b2C3d4E5f6G7h8J9k0'],
  ]);
  const mapReturn = parseCvsMapReturn(mapReturnBody, {
    merchantId: STAGE_KEYS.logisticsC2c2000933.merchantId,
    subType: 'UNIMARTC2C',
  });

  const ackInputs = [
    '1|OK',
    '1|OK\r\n',
    '1|ok',
    '1|Done',
    '0|錯誤',
    '',
    '<html>502 Bad Gateway</html>',
  ];
  const ackResponses = ackInputs.map((input) => ({
    input,
    result: parseLogisticsAckResponse(input),
  }));

  const postGoldenBase = HOME_CREATE_ORDER_GOLDEN_VECTORS.find(
    (v) => v.id === 'create-post',
  )!;
  const postKeys = keyPairFromSpec(postGoldenBase.keys);
  const weightFormatting = POST_WEIGHT_FORMATTING_VECTORS.map(
    ([grams]) => {
      const req = buildHomeCreateOrderRequest(
        {
          ...postGoldenBase.input,
          weightGrams: grams,
        },
        postKeys,
      );
      const parsed = parseForm(req.bodyText());
      const weightPair = parsed.find(([k]) => k === 'GoodsWeight')!;
      return [grams, weightPair[1]] as const;
    },
  );

  const serviceKeyLookups: Array<
    readonly [string, EcpayLogisticsSubType | null]
  > = [
    [
      'ecpay.logistics.cvs.unimartc2c',
      subTypeForServiceKey('ecpay.logistics.cvs.unimartc2c'),
    ],
    [
      'ecpay.logistics.cvs.famic2c',
      subTypeForServiceKey('ecpay.logistics.cvs.famic2c'),
    ],
    [
      'ecpay.logistics.cvs.hilifec2c',
      subTypeForServiceKey('ecpay.logistics.cvs.hilifec2c'),
    ],
    [
      'ecpay.logistics.home.tcat',
      subTypeForServiceKey('ecpay.logistics.home.tcat'),
    ],
    [
      'ecpay.logistics.home.post',
      subTypeForServiceKey('ecpay.logistics.home.post'),
    ],
    [
      'ecpay.logistics.cvs.unimart',
      subTypeForServiceKey('ecpay.logistics.cvs.unimart'),
    ],
  ];

  const cdnGuard = CDN_GUARD_WORKER_VECTORS.map(
    ([input]) => [input, findCdnBlockedTerm(input)] as const,
  );

  return {
    profile: ECPAY_DOMESTIC_LOGISTICS_PROFILE,
    subTypes: ECPAY_LOGISTICS_SUBTYPES,
    serviceKeyLookups,
    cvsCreateGoldens,
    homeCreateGoldens,
    queryRequestGoldens,
    printGoldens,
    cancelGolden,
    updateStoreGoldens,
    mapForm: {
      action: builtMapForm.action,
      method: builtMapForm.method,
      fields: builtMapForm.fields(),
      redactedJson: JSON.parse(JSON.stringify(builtMapForm)),
      redactedString: String(builtMapForm),
    },
    createResponseGoldens,
    notificationGolden: {
      id: NOTIFICATION_GOLDEN_VECTOR.id,
      signedMac: notifSignedMac,
      result: notifResult,
    },
    queryResponseGolden: {
      id: QUERY_RESPONSE_GOLDEN_VECTOR.id,
      signedMac: queryRespSignedMac,
      result: queryRespResult,
    },
    officialQueryV5,
    mapReturn,
    ackResponses,
    weightFormatting,
    cdnGuard,
  };
}

export default {
  async fetch(): Promise<Response> {
    const payload = evaluateDomesticLogisticsVectors();
    return Response.json(payload);
  },
};
