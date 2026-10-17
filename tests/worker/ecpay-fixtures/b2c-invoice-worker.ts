import {
  ECPAY_B2C_INVOICE_PATHS,
  ECPAY_B2C_INVOICE_PROFILE,
  buildAllowanceRequest,
  buildCancelOnlineAllowanceRequest,
  buildCheckBarcodeRequest,
  buildCheckLoveCodeRequest,
  buildCompanyNameRequest,
  buildGetAllowanceInvalidRequest,
  buildGetAllowanceListRequest,
  buildGetInvalidRequest,
  buildGetIssueRequest,
  buildIssueInvoiceRequest,
  buildOnlineAllowanceRequest,
  buildVoidAllowanceRequest,
  buildVoidInvoiceRequest,
  buildVoidWithReissueRequest,
  buildWordSettingRequest,
  classifyBarcodeCheck,
  classifyCompanyNameCheck,
  classifyInvoiceHttpStatus,
  classifyLoveCodeCheck,
  parseAllowanceConsentCallback,
  parseAllowanceResponse,
  parseCancelOnlineAllowanceResponse,
  parseCheckBarcodeResponse,
  parseCheckLoveCodeResponse,
  parseCompanyNameResponse,
  parseGetAllowanceInvalidResponse,
  parseGetAllowanceListResponse,
  parseGetInvalidResponse,
  parseGetIssueResponse,
  parseIssueInvoiceResponse,
  parseOnlineAllowanceResponse,
  parseVoidAllowanceResponse,
  parseVoidInvoiceResponse,
  parseVoidWithReissueResponse,
  parseWordSettingResponse,
  wordTrackRemaining,
  type AllowanceRequestInput,
  type AllowanceValue,
  type BuyerLookupClassification,
  type CancelOnlineAllowanceRequestInput,
  type CheckBarcodeRequestInput,
  type CheckBarcodeResult,
  type CheckLoveCodeRequestInput,
  type CheckLoveCodeResult,
  type CompanyNameClassification,
  type CompanyNameRequestInput,
  type CompanyNameResult,
  type EcpayInvoiceOperation,
  type EcpayJsonRequest,
  type GetAllowanceInvalidRequestInput,
  type GetAllowanceListRequestInput,
  type GetAllowanceListResult,
  type GetInvalidRequestInput,
  type GetIssueRequestInput,
  type InvalidAllowanceRecord,
  type InvalidInvoiceRecord,
  type InvoiceCallResult,
  type InvoiceHttpStatusClassification,
  type InvoiceRecord,
  type IssuedInvoiceValue,
  type IssueInvoiceRequestInput,
  type OnlineAllowanceRequestInput,
  type OnlineAllowanceValue,
  type ParseAllowanceConsentResult,
  type VoidAllowanceRequestInput,
  type VoidedInvoiceValue,
  type VoidInvoiceRequestInput,
  type VoidWithReissueRequestInput,
  type WordSettingRequestInput,
  type WordSettingResult,
  type WordTrack,
} from '../../../modules/agent-commerce/providers/ecpay/b2c-invoice/index.js';
import {
  EcpayKeyPair,
  encodeForm,
  encryptData,
} from '../../../modules/agent-commerce/providers/ecpay/index.js';
import {
  B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX,
  B2C_INVOICE_MERCHANT_ID,
  B2C_INVOICE_REQUEST_GOLDENS,
  B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
  B2C_INVOICE_SYNTHETIC_INVOICE_NO,
  B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
  B2C_INVOICE_TIMESTAMP_SECONDS,
  type B2cInvoiceRequestGolden,
} from './b2c-invoice-vectors.js';
import { CHECKMAC_VECTORS, STAGE_KEYS } from './vectors.js';

export interface B2cInvoiceRequestEvaluation {
  readonly id: string;
  readonly op: EcpayInvoiceOperation;
  readonly url: string;
  readonly method: string;
  readonly contentType: string;
  readonly bodyText: string;
  readonly redactedJson: unknown;
  readonly redactedString: string;
}

export interface B2cInvoiceWorkerEvaluation {
  readonly profile: string;
  readonly paths: Readonly<Record<EcpayInvoiceOperation, string>>;
  readonly requestBodiesById: Readonly<Record<string, string>>;
  readonly requests: readonly B2cInvoiceRequestEvaluation[];
  readonly lowerHexIssueResponse: InvoiceCallResult<IssuedInvoiceValue>;
  readonly okResponses: {
    readonly issue: InvoiceCallResult<IssuedInvoiceValue>;
    readonly voidWithReissue: InvoiceCallResult<IssuedInvoiceValue>;
    readonly void: InvoiceCallResult<VoidedInvoiceValue>;
    readonly allowance: InvoiceCallResult<AllowanceValue>;
    readonly onlineAllowance: InvoiceCallResult<OnlineAllowanceValue>;
    readonly voidAllowance: InvoiceCallResult<VoidedInvoiceValue>;
    readonly cancelOnlineAllowance: InvoiceCallResult<VoidedInvoiceValue>;
    readonly getIssueByRelate: InvoiceCallResult<InvoiceRecord>;
    readonly getIssueByInvoiceNo: InvoiceCallResult<InvoiceRecord>;
    readonly getAllowanceList: InvoiceCallResult<GetAllowanceListResult>;
    readonly getInvalid: InvoiceCallResult<InvalidInvoiceRecord>;
    readonly getAllowanceInvalid: InvoiceCallResult<InvalidAllowanceRecord>;
    readonly checkBarcode: InvoiceCallResult<CheckBarcodeResult>;
    readonly checkLoveCode: InvoiceCallResult<CheckLoveCodeResult>;
    readonly companyName: InvoiceCallResult<CompanyNameResult>;
    readonly wordSetting: InvoiceCallResult<WordSettingResult>;
  };
  readonly consentCallback: ParseAllowanceConsentResult;
  readonly classifiers: {
    readonly barcode: readonly BuyerLookupClassification[];
    readonly loveCode: readonly BuyerLookupClassification[];
    readonly companyName: readonly CompanyNameClassification[];
    readonly httpStatus: ReadonlyArray<
      readonly [number, InvoiceHttpStatusClassification]
    >;
  };
  readonly wordTrackRemainingCases: ReadonlyArray<
    readonly [string | null, number | null]
  >;
}

export function buildGoldenRequest(
  golden: B2cInvoiceRequestGolden,
  keys: EcpayKeyPair,
): EcpayJsonRequest {
  switch (golden.op) {
    case 'issue':
      return buildIssueInvoiceRequest(
        golden.input as IssueInvoiceRequestInput,
        keys,
      );
    case 'voidWithReissue':
      return buildVoidWithReissueRequest(
        golden.input as VoidWithReissueRequestInput,
        keys,
      );
    case 'void':
      return buildVoidInvoiceRequest(
        golden.input as VoidInvoiceRequestInput,
        keys,
      );
    case 'allowance':
      return buildAllowanceRequest(
        golden.input as AllowanceRequestInput,
        keys,
      );
    case 'onlineAllowance':
      return buildOnlineAllowanceRequest(
        golden.input as OnlineAllowanceRequestInput,
        keys,
      );
    case 'voidAllowance':
      return buildVoidAllowanceRequest(
        golden.input as VoidAllowanceRequestInput,
        keys,
      );
    case 'cancelOnlineAllowance':
      return buildCancelOnlineAllowanceRequest(
        golden.input as CancelOnlineAllowanceRequestInput,
        keys,
      );
    case 'getIssue':
      return buildGetIssueRequest(
        golden.input as GetIssueRequestInput,
        keys,
      );
    case 'getAllowanceList':
      return buildGetAllowanceListRequest(
        golden.input as GetAllowanceListRequestInput,
        keys,
      );
    case 'getInvalid':
      return buildGetInvalidRequest(
        golden.input as GetInvalidRequestInput,
        keys,
      );
    case 'getAllowanceInvalid':
      return buildGetAllowanceInvalidRequest(
        golden.input as GetAllowanceInvalidRequestInput,
        keys,
      );
    case 'checkBarcode':
      return buildCheckBarcodeRequest(
        golden.input as CheckBarcodeRequestInput,
        keys,
      );
    case 'checkLoveCode':
      return buildCheckLoveCodeRequest(
        golden.input as CheckLoveCodeRequestInput,
        keys,
      );
    case 'companyName':
      return buildCompanyNameRequest(
        golden.input as CompanyNameRequestInput,
        keys,
      );
    case 'wordSetting':
      return buildWordSettingRequest(
        golden.input as WordSettingRequestInput,
        keys,
      );
  }
}

function makeEncryptedEnvelopeBody(
  dataPayload: Readonly<Record<string, unknown>>,
  keys: EcpayKeyPair,
): string {
  return JSON.stringify({
    MerchantID: B2C_INVOICE_MERCHANT_ID,
    RpHeader: { Timestamp: B2C_INVOICE_TIMESTAMP_SECONDS },
    TransCode: 1,
    TransMsg: '',
    Data: encryptData(dataPayload, keys),
  });
}

export function evaluateB2cInvoiceVectors(): B2cInvoiceWorkerEvaluation {
  const keys = EcpayKeyPair.of(
    STAGE_KEYS.invoice2000132.hashKey,
    STAGE_KEYS.invoice2000132.hashIV,
  );
  const merchantId = B2C_INVOICE_MERCHANT_ID;

  const requestBodiesById: Record<string, string> = {};
  const requests: B2cInvoiceRequestEvaluation[] =
    B2C_INVOICE_REQUEST_GOLDENS.map((golden) => {
      const req = buildGoldenRequest(golden, keys);
      const bodyText = req.bodyText();
      requestBodiesById[golden.id] = bodyText;
      return {
        id: golden.id,
        op: golden.op,
        url: req.url,
        method: req.method,
        contentType: req.contentType,
        bodyText,
        redactedJson: JSON.parse(JSON.stringify(req)),
        redactedString: String(req),
      };
    });

  const lowerHexIssueResponse = parseIssueInvoiceResponse(
    B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX.body,
    keys,
    { merchantId },
  );

  const issueBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '開立發票成功',
      InvoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      InvoiceDate: '2026-10-15 10:20:30',
      RandomNumber: '7412',
    },
    keys,
  );

  const voidBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '作廢發票成功',
      InvoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    },
    keys,
  );

  const allowanceBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '開立折讓成功',
      IA_Allow_No: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      IA_Date: '2026-10-16 11:22:33',
      IA_Remain_Allowance_Amt: 1000,
    },
    keys,
  );

  const onlineAllowanceBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '線上折讓開立成功',
      IA_Allow_No: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      IA_TempDate: '2026-10-16 11:22:33',
      IA_TempExpireDate: '2026-10-21 11:22:33',
      IA_Remain_Allowance_Amt: 1000,
    },
    keys,
  );

  const voidAllowanceBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '作廢折讓成功',
      IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    },
    keys,
  );

  const getIssueBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      IIS_Number: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      IIS_Relate_Number: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
      IIS_Create_Date: '2026-10-15 10:20:30',
      IIS_Issue_Status: '1',
      IIS_Invalid_Status: '0',
      IIS_Upload_Status: '1',
      IIS_Upload_Date: '2026-10-15 11:00:00',
      IIS_Turnkey_Status: 'C',
      IIS_Sales_Amount: 1500,
      IIS_Remain_Allowance_Amt: 1500,
      IIS_Random_Number: '7412',
    },
    keys,
  );

  const getAllowanceListBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      AllowanceInfo: [
        {
          IA_Allow_No: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
          IA_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
          IA_Date: '2026-10-16 11:22:33',
          IA_Invalid_Status: '0',
          IA_Upload_Status: '1',
          IA_Upload_Date: '2026-10-16 12:00:00',
          IA_Total_Tax_Amount: 500,
        },
      ],
    },
    keys,
  );

  const getInvalidBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      II_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      II_Date: '2026-10-16 09:00:00',
      II_Upload_Status: '1',
      II_Upload_Date: '2026-10-16 10:00:00',
    },
    keys,
  );

  const getAllowanceInvalidBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      AI_Allow_No: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      AI_Invoice_No: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      AI_Date: '2026-10-17 09:00:00',
      AI_Upload_Status: '0',
      AI_Upload_Date: '',
    },
    keys,
  );

  const checkBarcodeBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      IsExist: 'Y',
    },
    keys,
  );

  const checkLoveCodeBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      IsExist: 'Y',
      OrganName: '合成公益基金會',
    },
    keys,
  );

  const companyNameBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      CompanyName: '綠界科技股份有限公司',
    },
    keys,
  );

  const wordSettingBody = makeEncryptedEnvelopeBody(
    {
      RtnCode: 1,
      RtnMsg: '查詢成功',
      InvoiceInfo: [
        {
          TrackID: '1001',
          InvoiceYear: '115',
          InvoiceTerm: 5,
          InvoiceCategory: 1,
          InvType: '07',
          InvoiceHeader: 'AB',
          InvoiceStart: '10000000',
          InvoiceEnd: '10000049',
          InvoiceNo: '10000010',
          UseStatus: 2,
        },
      ],
    },
    keys,
  );

  const okResponses = {
    issue: parseIssueInvoiceResponse(issueBody, keys, { merchantId }),
    voidWithReissue: parseVoidWithReissueResponse(issueBody, keys, {
      merchantId,
    }),
    void: parseVoidInvoiceResponse(voidBody, keys, {
      merchantId,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    }),
    allowance: parseAllowanceResponse(allowanceBody, keys, {
      merchantId,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    }),
    onlineAllowance: parseOnlineAllowanceResponse(onlineAllowanceBody, keys, {
      merchantId,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    }),
    voidAllowance: parseVoidAllowanceResponse(voidAllowanceBody, keys, {
      merchantId,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    }),
    cancelOnlineAllowance: parseCancelOnlineAllowanceResponse(
      voidAllowanceBody,
      keys,
      {
        merchantId,
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
      },
    ),
    getIssueByRelate: parseGetIssueResponse(getIssueBody, keys, {
      merchantId,
      by: 'relate_number',
      relateNumber: B2C_INVOICE_SYNTHETIC_RELATE_NUMBER,
    }),
    getIssueByInvoiceNo: parseGetIssueResponse(getIssueBody, keys, {
      merchantId,
      by: 'invoice_no',
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    }),
    getAllowanceList: parseGetAllowanceListResponse(
      getAllowanceListBody,
      keys,
      {
        merchantId,
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
        allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      },
    ),
    getInvalid: parseGetInvalidResponse(getInvalidBody, keys, {
      merchantId,
      invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
    }),
    getAllowanceInvalid: parseGetAllowanceInvalidResponse(
      getAllowanceInvalidBody,
      keys,
      {
        merchantId,
        invoiceNo: B2C_INVOICE_SYNTHETIC_INVOICE_NO,
        allowanceNo: B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO,
      },
    ),
    checkBarcode: parseCheckBarcodeResponse(checkBarcodeBody, keys, {
      merchantId,
    }),
    checkLoveCode: parseCheckLoveCodeResponse(checkLoveCodeBody, keys, {
      merchantId,
    }),
    companyName: parseCompanyNameResponse(companyNameBody, keys, {
      merchantId,
    }),
    wordSetting: parseWordSettingResponse(wordSettingBody, keys, {
      merchantId,
    }),
  };

  const consentVector = CHECKMAC_VECTORS.find(
    (v) => v.id === 'invoice-allowance',
  )!;
  const consentBody = encodeForm([
    ...consentVector.fields,
    ['CheckMacValue', consentVector.expectedMac],
  ]);
  const consentCallback = parseAllowanceConsentCallback(consentBody, keys);

  const classifiers = {
    barcode: [
      classifyBarcodeCheck({ kind: 'ok', value: { exists: true } }),
      classifyBarcodeCheck({ kind: 'ok', value: { exists: false } }),
      classifyBarcodeCheck({
        kind: 'rejected',
        rtnCode: '999',
        rtnMsg: 'err',
      }),
      classifyBarcodeCheck({
        kind: 'not_accepted',
        transCode: '0',
        transMsg: 'err',
      }),
      classifyBarcodeCheck({ kind: 'unknown', reason: 'invalid_json' }),
    ],
    loveCode: [
      classifyLoveCodeCheck({
        kind: 'ok',
        value: { exists: true, organName: '合成公益基金會' },
      }),
      classifyLoveCodeCheck({
        kind: 'ok',
        value: { exists: false, organName: null },
      }),
      classifyLoveCodeCheck({
        kind: 'rejected',
        rtnCode: '999',
        rtnMsg: 'err',
      }),
      classifyLoveCodeCheck({
        kind: 'not_accepted',
        transCode: '0',
        transMsg: 'err',
      }),
      classifyLoveCodeCheck({ kind: 'unknown', reason: 'invalid_json' }),
    ],
    companyName: [
      classifyCompanyNameCheck({
        kind: 'ok',
        value: { companyName: '綠界科技股份有限公司' },
      }),
      classifyCompanyNameCheck({
        kind: 'rejected',
        rtnCode: '1200125',
        rtnMsg: 'checksum',
      }),
      classifyCompanyNameCheck({
        kind: 'rejected',
        rtnCode: '2027000',
        rtnMsg: 'length',
      }),
      classifyCompanyNameCheck({
        kind: 'rejected',
        rtnCode: '7',
        rtnMsg: 'not registered',
      }),
      classifyCompanyNameCheck({
        kind: 'rejected',
        rtnCode: '9000001',
        rtnMsg: 'mof error',
      }),
      classifyCompanyNameCheck({
        kind: 'not_accepted',
        transCode: '0',
        transMsg: 'err',
      }),
      classifyCompanyNameCheck({ kind: 'unknown', reason: 'invalid_json' }),
    ],
    httpStatus: [200, 403, 201, 302, 404, 500, 502].map(
      (s) => [s, classifyInvoiceHttpStatus(s)] as const,
    ),
  };

  const baseTrack: WordTrack = {
    trackId: '1001',
    invoiceYear: '115',
    invoiceTerm: 5,
    invType: '07',
    header: 'AB',
    start: '10000000',
    end: '10000049',
    lastUsed: '10000010',
    useStatus: 2,
  };
  const lastUsedInputs: Array<string | null> = [
    '10000010',
    '10000049',
    null,
    '09999999',
    '10000050',
  ];
  const wordTrackRemainingCases = lastUsedInputs.map(
    (lastUsed) =>
      [
        lastUsed,
        wordTrackRemaining({ ...baseTrack, lastUsed }),
      ] as const,
  );

  return {
    profile: ECPAY_B2C_INVOICE_PROFILE,
    paths: ECPAY_B2C_INVOICE_PATHS,
    requestBodiesById,
    requests,
    lowerHexIssueResponse,
    okResponses,
    consentCallback,
    classifiers,
    wordTrackRemainingCases,
  };
}

export default {
  async fetch(): Promise<Response> {
    const payload = evaluateB2cInvoiceVectors();
    return Response.json(payload);
  },
};
