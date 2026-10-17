export const ECPAY_B2C_INVOICE_PROFILE = 'ecpay.invoice.b2c.v1' as const;

export const ECPAY_B2C_INVOICE_PATHS = Object.freeze({
  issue: '/B2CInvoice/Issue',
  voidWithReissue: '/B2CInvoice/VoidWithReIssue',
  void: '/B2CInvoice/Invalid',
  allowance: '/B2CInvoice/Allowance',
  onlineAllowance: '/B2CInvoice/AllowanceByCollegiate',
  voidAllowance: '/B2CInvoice/AllowanceInvalid',
  cancelOnlineAllowance: '/B2CInvoice/AllowanceInvalidByCollegiate',
  getIssue: '/B2CInvoice/GetIssue',
  getAllowanceList: '/B2CInvoice/GetAllowanceList',
  getInvalid: '/B2CInvoice/GetInvalid',
  getAllowanceInvalid: '/B2CInvoice/GetAllowanceInvalid',
  checkBarcode: '/B2CInvoice/CheckBarcode',
  checkLoveCode: '/B2CInvoice/CheckLoveCode',
  companyName: '/B2CInvoice/GetCompanyNameByTaxID',
  wordSetting: '/B2CInvoice/GetInvoiceWordSetting',
} as const);

export type EcpayInvoiceOperation = keyof typeof ECPAY_B2C_INVOICE_PATHS;
