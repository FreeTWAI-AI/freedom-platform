/**
 * Golden test vectors for the ECPay B2C e-invoice profile (`ecpay.invoice.b2c.v1`).
 *
 * Computed independently from the official AES rules (pages 7958, 38406) outside
 * the repository with the published stage keys `STAGE_KEYS.invoice2000132`; all
 * buyer values are synthetic.
 */

import type {
  AllowanceRequestInput,
  CancelOnlineAllowanceRequestInput,
  CheckBarcodeRequestInput,
  CheckLoveCodeRequestInput,
  CompanyNameRequestInput,
  EcpayInvoiceItemInput,
  EcpayInvoiceOperation,
  GetAllowanceInvalidRequestInput,
  GetAllowanceListRequestInput,
  GetInvalidRequestInput,
  GetIssueRequestInput,
  IssuedInvoiceValue,
  IssueInvoiceRequestInput,
  OnlineAllowanceRequestInput,
  VoidAllowanceRequestInput,
  VoidInvoiceRequestInput,
  VoidWithReissueRequestInput,
  WordSettingRequestInput,
} from "../../../modules/agent-commerce/providers/ecpay/b2c-invoice/index.js";
import { STAGE_KEYS } from "./vectors.js";

export const B2C_INVOICE_TIMESTAMP_SECONDS = 1792044000;
export const B2C_INVOICE_SANDBOX_ORIGIN = undefined;
export const B2C_INVOICE_MERCHANT_ID = STAGE_KEYS.invoice2000132.merchantId;
export const B2C_INVOICE_SYNTHETIC_EMAIL = "buyer@example.test";
export const B2C_INVOICE_SYNTHETIC_BARCODE = "/AB12+-.";
export const B2C_INVOICE_SYNTHETIC_CERTIFICATE = "AB12345678901234";
export const B2C_INVOICE_SYNTHETIC_LOVE_CODE = "000123";
export const B2C_INVOICE_SYNTHETIC_UBN = "97025978";
export const B2C_INVOICE_SYNTHETIC_COMPANY_TITLE = "綠界科技股份有限公司";
export const B2C_INVOICE_SYNTHETIC_RELATE_NUMBER = "I0200000000000000001";
export const B2C_INVOICE_SYNTHETIC_INVOICE_NO = "AB12345678";
export const B2C_INVOICE_SYNTHETIC_ALLOWANCE_NO = "2026101500000001";
export const B2C_INVOICE_SYNTHETIC_DATE = "2026-10-15";
export const B2C_INVOICE_SYNTHETIC_DATETIME = "2026-10-15 10:20:30";
export const B2C_INVOICE_SYNTHETIC_RETURN_URL =
  "https://freedom.example.com/api/v1/provider-callbacks/ecpay/acct01/invoice-allowance";

export const B2C_INVOICE_SYNTHETIC_ITEMS: readonly EcpayInvoiceItemInput[] =
  Object.freeze([
    Object.freeze({
      name: "合成課程A",
      count: 1,
      priceMinor: 100000,
      amountMinor: 100000,
    }),
    Object.freeze({
      name: "合成講義B",
      count: 2,
      priceMinor: 25000,
      amountMinor: 50000,
    }),
  ]);

export type B2cInvoiceGoldenInput =
  | IssueInvoiceRequestInput
  | VoidWithReissueRequestInput
  | VoidInvoiceRequestInput
  | AllowanceRequestInput
  | OnlineAllowanceRequestInput
  | VoidAllowanceRequestInput
  | CancelOnlineAllowanceRequestInput
  | GetIssueRequestInput
  | GetAllowanceListRequestInput
  | GetInvalidRequestInput
  | GetAllowanceInvalidRequestInput
  | CheckBarcodeRequestInput
  | CheckLoveCodeRequestInput
  | CompanyNameRequestInput
  | WordSettingRequestInput;

export interface B2cInvoiceRequestGolden {
  readonly id: string;
  readonly op: EcpayInvoiceOperation;
  readonly url: string;
  readonly input: B2cInvoiceGoldenInput;
  readonly attempt: number;
  readonly blockedTerms: readonly string[];
  readonly dataJson: string;
  readonly dataCipher: string;
  readonly bodyText: string;
}

export interface B2cInvoiceIssueResponseLowerHexGolden {
  readonly body: string;
  readonly expected: IssuedInvoiceValue;
}

export const B2C_INVOICE_REQUEST_GOLDENS: readonly B2cInvoiceRequestGolden[] = Object.freeze([
  Object.freeze({
    id: "issue-member_carrier",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEFGHJ",
      buyer: Object.freeze({
        type: "member_carrier",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"\",\"CustomerName\":\"\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"1\",\"CarrierNum\":\"\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGP8i3TUlmX3LnhPGSdIzDFxCLweDDohy8BK1Xj8VtBthX3IoAqFtkKDgGLFpoZ7boLjtXQ4EZWGQ9y4ed3GbILwkjCVGm/6xPaxqnuzVtd1lsRj5nok6Z1nukSB8dY8ZXOJyYeplA6ZQzuHWRZuHKyi5vNhkejJ7NUYULkQAlz7558jUnnyT5LCp5/9wJRppBpa7K57sNWJfookjS35fBb77pRy+U9nk8h8BQrEIG5xvOYZDzf1H5ynvHtyR2LWs1/B9Kf1bZEQHCw6NdlAmqREkuK/j5lkhn53Bhu90CPAqbeT9++K2XeQRrfDYn/aRo/syAZFs5WGq3V+4kB1upE/jn0RflNkD5XGLEEz07zPNTEbTi8VisPtJiUp2Z4QwC6VZO0VVoWlYaRcg/cpcwDCCq/eBgMYl4OSaxydwSV2Dj9c/9S4RBf/0UiU/RC2Pdz5xDbc+e6aUbX/2/69Hn/hGNVHBu2T3rAwIxqPKRHqtzkJHZkq7OOyn76uzaaXdRk76bb8Fe9+nrWkMr3byEY45ZBniYYEshFdDchkRqpmROEypOJ66SuKZRJNhw29e/KRGcYyCtsgJ6O1VOzuL+Fpn7Y2gI+bVv6D4yE6W8VyGssXpzYR4c02Wfb9Vx6SoGKzefCwrzWCAbLNNOQZ+V/5YiBC0LVu2SbHxO0Y0Alm+/0U+hNLiMaH9D17qcIohnfy25uiFirThtLOVS4OanyQrTwQYrfB3uYIC1IkKF4WfnpSi5gT3GeTfd1EXC9+XixQ/0kwa5em/f913ULoHJEPCsgXbMAMWWg4rT1Dpmc+6aihDFwJ8e/j5ZaC0Nzkti+sMu53q7efeMNueMI/a9spPPt27dI18C40g1zHMlOCtjFzJDkHUbp1Etap+6FjTxgGnO7vkCsA+qFLcsGjVN27lygQac78seizOqkDL2UciuKDC9nz5NXrKtKI+Fbz1SM750g5Z19YKrL4O5jHGR8ttOxUC3brsXTqm0C6RYzAkc+vJBiKj4cEFwWkLIWb6621AwezW1Cs4bI+tJChjcJ/0p4d+fGfIWYtdfDQMo64b9FbdADj2KC9D0ZcjPpi8kkOb6UpFhizX2UP0Yk/48hFeRRwq4TTTub3B8tewdpmHbVZDHNGISf/M4DcYRZieJnfPh0co638PL/E3GouJe2IOV13JvqSZc2y7wNl44nSQsuDZKQ2KL/oe3ZMU21DGF+",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGP8i3TUlmX3LnhPGSdIzDFxCLweDDohy8BK1Xj8VtBthX3IoAqFtkKDgGLFpoZ7boLjtXQ4EZWGQ9y4ed3GbILwkjCVGm/6xPaxqnuzVtd1lsRj5nok6Z1nukSB8dY8ZXOJyYeplA6ZQzuHWRZuHKyi5vNhkejJ7NUYULkQAlz7558jUnnyT5LCp5/9wJRppBpa7K57sNWJfookjS35fBb77pRy+U9nk8h8BQrEIG5xvOYZDzf1H5ynvHtyR2LWs1/B9Kf1bZEQHCw6NdlAmqREkuK/j5lkhn53Bhu90CPAqbeT9++K2XeQRrfDYn/aRo/syAZFs5WGq3V+4kB1upE/jn0RflNkD5XGLEEz07zPNTEbTi8VisPtJiUp2Z4QwC6VZO0VVoWlYaRcg/cpcwDCCq/eBgMYl4OSaxydwSV2Dj9c/9S4RBf/0UiU/RC2Pdz5xDbc+e6aUbX/2/69Hn/hGNVHBu2T3rAwIxqPKRHqtzkJHZkq7OOyn76uzaaXdRk76bb8Fe9+nrWkMr3byEY45ZBniYYEshFdDchkRqpmROEypOJ66SuKZRJNhw29e/KRGcYyCtsgJ6O1VOzuL+Fpn7Y2gI+bVv6D4yE6W8VyGssXpzYR4c02Wfb9Vx6SoGKzefCwrzWCAbLNNOQZ+V/5YiBC0LVu2SbHxO0Y0Alm+/0U+hNLiMaH9D17qcIohnfy25uiFirThtLOVS4OanyQrTwQYrfB3uYIC1IkKF4WfnpSi5gT3GeTfd1EXC9+XixQ/0kwa5em/f913ULoHJEPCsgXbMAMWWg4rT1Dpmc+6aihDFwJ8e/j5ZaC0Nzkti+sMu53q7efeMNueMI/a9spPPt27dI18C40g1zHMlOCtjFzJDkHUbp1Etap+6FjTxgGnO7vkCsA+qFLcsGjVN27lygQac78seizOqkDL2UciuKDC9nz5NXrKtKI+Fbz1SM750g5Z19YKrL4O5jHGR8ttOxUC3brsXTqm0C6RYzAkc+vJBiKj4cEFwWkLIWb6621AwezW1Cs4bI+tJChjcJ/0p4d+fGfIWYtdfDQMo64b9FbdADj2KC9D0ZcjPpi8kkOb6UpFhizX2UP0Yk/48hFeRRwq4TTTub3B8tewdpmHbVZDHNGISf/M4DcYRZieJnfPh0co638PL/E3GouJe2IOV13JvqSZc2y7wNl44nSQsuDZKQ2KL/oe3ZMU21DGF+\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "issue-mobile_barcode",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEFGHJ",
      buyer: Object.freeze({
        type: "mobile_barcode",
        barcode: "/AB12+-.",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"\",\"CustomerName\":\"\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"3\",\"CarrierNum\":\"/AB12+-.\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGP8i3TUlmX3LnhPGSdIzDFxCLweDDohy8BK1Xj8VtBthX3IoAqFtkKDgGLFpoZ7boLF/GNOIkmz8K9W10qAO2UUGdkJq54IQVRr11tLBFNG4M+8SkFfTYX3TVZYqeqbefiLZQfCTIhcQJg1Lq7MEI4p4tAo2brnPYwulYXiMfX8+GYrJCzOaknTgvdRZ65r+vjWg3MpuVrUqk9LDnP1n0NZpJGcZHjbBIZkw9JnLQ807ybNqYGPMhZhGkX1h8FY8P51kzuoqihiJXorSzZXi3Pp2xQp1INFe/E7BK/emMyLz2SgIEfSx/bAV8ySicPiNz1iDGrsE0QuyxKOym8rkAFai0nuq4IsY8yiYsmvMvhUa/MYDFLlw+KRH2AFuBNPG/OxJ/lZE9/p/SmuSYd64cr80EGQUZL/FVjX7par2gHJ7y6SvqqNLTUdYG4F3Q29d9HnyGD3zYhzndVbss0xTrkmao3h3aXwp7Ad2F2eVvfS6TyD/Y66q2iOhy+yPhSusTaGL08zOkXty79g3cefU6HphjeC12oj7CLUOfx8++3BvG19Y1r+ulUKpPsMc3lrU2VD+Hta1lhXwqt5YWzuJINC+8r5bhqElOsF6Dihf2KjbjmUbVxiOH7f9ajjvciKzE4Smc53zYFZEaau/VHYsgWE3o0J7ASToS4pHHAdx+qi+/4rz09FrQ/ENLxVGslnwDpsdNkSVRhmVHB86li2RD1/Ie5fcsSPBfeb/hVkgu8ZMIsmlfrNT2dh5FPEEAqPFE/DEmQWdcwyZgd8O/LlTtD3OW1Ie4Z1KaE2G9f7z36jvT5qJT/l1JIubFVu8tVq74yayPqL22pvXx8fzemaQTrqY1UsgteNdAQ2YbjMRrn/EqSG2Ei+fHbko2MITLgWSi1GFE0Ul8cLLVqbdcenrbnRmYyDJvr3ATp4V/Jr2PJuVp9KOSG65WAP34va/0zD2UdpayJb4gvN0hSe3C356qavy7ob5iC+A9Zr1UCKcIoxxS7IDTMcAB4kProZZRqB+4A7v+JVZz6rO24OeITGXsorJkSMwoN952SWjVmoLj7FtBylTJcacjeXAvnmtFCiM1IkjhuvXhdbSfFMBwK7DLE6I3MbALt5FVJ9ntYj/FCI7DeIX4uG5FSemPC2kNDB3nvOlXO26YD+YDwzc+fY5WYCb6MhdC3pH9/tEwHYXInCKWfvwwkAJRsDimGhLtxFN+mz3WtJhRlZxlyHmVC5wfQ2w==",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGP8i3TUlmX3LnhPGSdIzDFxCLweDDohy8BK1Xj8VtBthX3IoAqFtkKDgGLFpoZ7boLF/GNOIkmz8K9W10qAO2UUGdkJq54IQVRr11tLBFNG4M+8SkFfTYX3TVZYqeqbefiLZQfCTIhcQJg1Lq7MEI4p4tAo2brnPYwulYXiMfX8+GYrJCzOaknTgvdRZ65r+vjWg3MpuVrUqk9LDnP1n0NZpJGcZHjbBIZkw9JnLQ807ybNqYGPMhZhGkX1h8FY8P51kzuoqihiJXorSzZXi3Pp2xQp1INFe/E7BK/emMyLz2SgIEfSx/bAV8ySicPiNz1iDGrsE0QuyxKOym8rkAFai0nuq4IsY8yiYsmvMvhUa/MYDFLlw+KRH2AFuBNPG/OxJ/lZE9/p/SmuSYd64cr80EGQUZL/FVjX7par2gHJ7y6SvqqNLTUdYG4F3Q29d9HnyGD3zYhzndVbss0xTrkmao3h3aXwp7Ad2F2eVvfS6TyD/Y66q2iOhy+yPhSusTaGL08zOkXty79g3cefU6HphjeC12oj7CLUOfx8++3BvG19Y1r+ulUKpPsMc3lrU2VD+Hta1lhXwqt5YWzuJINC+8r5bhqElOsF6Dihf2KjbjmUbVxiOH7f9ajjvciKzE4Smc53zYFZEaau/VHYsgWE3o0J7ASToS4pHHAdx+qi+/4rz09FrQ/ENLxVGslnwDpsdNkSVRhmVHB86li2RD1/Ie5fcsSPBfeb/hVkgu8ZMIsmlfrNT2dh5FPEEAqPFE/DEmQWdcwyZgd8O/LlTtD3OW1Ie4Z1KaE2G9f7z36jvT5qJT/l1JIubFVu8tVq74yayPqL22pvXx8fzemaQTrqY1UsgteNdAQ2YbjMRrn/EqSG2Ei+fHbko2MITLgWSi1GFE0Ul8cLLVqbdcenrbnRmYyDJvr3ATp4V/Jr2PJuVp9KOSG65WAP34va/0zD2UdpayJb4gvN0hSe3C356qavy7ob5iC+A9Zr1UCKcIoxxS7IDTMcAB4kProZZRqB+4A7v+JVZz6rO24OeITGXsorJkSMwoN952SWjVmoLj7FtBylTJcacjeXAvnmtFCiM1IkjhuvXhdbSfFMBwK7DLE6I3MbALt5FVJ9ntYj/FCI7DeIX4uG5FSemPC2kNDB3nvOlXO26YD+YDwzc+fY5WYCb6MhdC3pH9/tEwHYXInCKWfvwwkAJRsDimGhLtxFN+mz3WtJhRlZxlyHmVC5wfQ2w==\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "issue-citizen_cert",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEFGHJ",
      buyer: Object.freeze({
        type: "citizen_cert",
        certificate: "AB12345678901234",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"\",\"CustomerName\":\"\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"2\",\"CarrierNum\":\"AB12345678901234\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGP8i3TUlmX3LnhPGSdIzDFxCLweDDohy8BK1Xj8VtBthX3IoAqFtkKDgGLFpoZ7boLHAanCdS57hbspGzh9sqXwtXwrCwKYsJn7ugBuF3ZTVw9SlHAmFoceFPhqR37afmG+BXK1AvCk3RjGtoHRvhOEjnN2YiIfwTrcnfNtZq2ES7M9C/FptKxkiRmI0xdcC+7hWkuVMrQP6Ly/WTkoB4NrAImKJ32CSCY2kk66c/y9V9SHWATBASCrFdTzorv2k18nXdG5pdVDAZHhiyoJs5PJsLMf4O2SdTI4v4YwDGF10KSDzx8JccgyarM/HCpWutBBX7iIe0FwvJF8nPNQHJQN6gBHc/iqW8aaNrALZ5VttcE1f3cOAJ0KdhZAFWd37THauGwQLq2+Uttka4KsGVv8uM8jSpenSIHwf2M9dYW9wR4+7QiTlCf+s9vySbs6qhu9VPa6zmqGDu0A3cBnyP0iEw9xWZLBHVBN3bgewxU48CL9O/SZcb2fZ9RWEPHMyaQGiRHT7rDAW1YIJIYLX8OvKyYyAvVa5Lh//WKJuiTWFF5T0c7EU7GAuewnBpBimbP3M5bdjla+Dx/ZStuVLlattJ3akThiEFyQv/voR0x9P6vikStyT+bBGj86rBW57QVJlkGVDdzc63Y6ID6EuINHvE616gaDGGE5TXYwD7pHRCLU1JGllzhvqz60W5AaFDdSP672hy2NC/jfGm8YlYbbGYlK6+czhCJsPAY+3xR22jTsa0nxwR5D8xoAt1+xw6Ox8YarQ8/3qnyodsiqy1acRDJ/8OIeoBVxeSsLW9QYNvxHlbLwi99Ox2zF0UmBbU6TYwzBLFmHTI+yuk1kwBBdixLXBXQEU29Ua7AiudkppN3/U7iv9E5CZwnFFNihKGgmtLm1RFcRb97cmJF0d/1ABWNz2pT9xKZR8BBCjHAKkngl6XOa0iAw9cn6KNIhRQF1phOm+S5XmNZRgciQjbC7SAGtlmiXFMfj5RG5fmRVkT4/S13qjB0SmChI6pFwd8EiR7q8YOVPgCXOme9wNYgA0oAKP/XtM3lvbvrEUHfaSyd5psk79l+iPrE3MjXDUS0RYcEWADNKqHrh1vG9jyQUbUtuOVRdWIPnFdNUPmnM/VIi8n0L5Qt4IphaPHWiMlC3EDya4cPnZh5aoSj/cZy9R9XePbpnf8jOlZX76w7nccz0E2+UGk2TJrliy/LO18uVfaKwFY3T748/7rj5WLZiw==",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGP8i3TUlmX3LnhPGSdIzDFxCLweDDohy8BK1Xj8VtBthX3IoAqFtkKDgGLFpoZ7boLHAanCdS57hbspGzh9sqXwtXwrCwKYsJn7ugBuF3ZTVw9SlHAmFoceFPhqR37afmG+BXK1AvCk3RjGtoHRvhOEjnN2YiIfwTrcnfNtZq2ES7M9C/FptKxkiRmI0xdcC+7hWkuVMrQP6Ly/WTkoB4NrAImKJ32CSCY2kk66c/y9V9SHWATBASCrFdTzorv2k18nXdG5pdVDAZHhiyoJs5PJsLMf4O2SdTI4v4YwDGF10KSDzx8JccgyarM/HCpWutBBX7iIe0FwvJF8nPNQHJQN6gBHc/iqW8aaNrALZ5VttcE1f3cOAJ0KdhZAFWd37THauGwQLq2+Uttka4KsGVv8uM8jSpenSIHwf2M9dYW9wR4+7QiTlCf+s9vySbs6qhu9VPa6zmqGDu0A3cBnyP0iEw9xWZLBHVBN3bgewxU48CL9O/SZcb2fZ9RWEPHMyaQGiRHT7rDAW1YIJIYLX8OvKyYyAvVa5Lh//WKJuiTWFF5T0c7EU7GAuewnBpBimbP3M5bdjla+Dx/ZStuVLlattJ3akThiEFyQv/voR0x9P6vikStyT+bBGj86rBW57QVJlkGVDdzc63Y6ID6EuINHvE616gaDGGE5TXYwD7pHRCLU1JGllzhvqz60W5AaFDdSP672hy2NC/jfGm8YlYbbGYlK6+czhCJsPAY+3xR22jTsa0nxwR5D8xoAt1+xw6Ox8YarQ8/3qnyodsiqy1acRDJ/8OIeoBVxeSsLW9QYNvxHlbLwi99Ox2zF0UmBbU6TYwzBLFmHTI+yuk1kwBBdixLXBXQEU29Ua7AiudkppN3/U7iv9E5CZwnFFNihKGgmtLm1RFcRb97cmJF0d/1ABWNz2pT9xKZR8BBCjHAKkngl6XOa0iAw9cn6KNIhRQF1phOm+S5XmNZRgciQjbC7SAGtlmiXFMfj5RG5fmRVkT4/S13qjB0SmChI6pFwd8EiR7q8YOVPgCXOme9wNYgA0oAKP/XtM3lvbvrEUHfaSyd5psk79l+iPrE3MjXDUS0RYcEWADNKqHrh1vG9jyQUbUtuOVRdWIPnFdNUPmnM/VIi8n0L5Qt4IphaPHWiMlC3EDya4cPnZh5aoSj/cZy9R9XePbpnf8jOlZX76w7nccz0E2+UGk2TJrliy/LO18uVfaKwFY3T748/7rj5WLZiw==\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "issue-donation",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEFGHJ",
      buyer: Object.freeze({
        type: "donation",
        loveCode: "000123",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"\",\"CustomerName\":\"\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"1\",\"LoveCode\":\"000123\",\"CarrierType\":\"\",\"CarrierNum\":\"\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGPg39dtJ+5coom1Lh4+6NeXZlNUj0h2vL6dcVtcoXbWHqMJ3/Y0o4kKuk8AvWRjJYl4pcCboorRbHKTiqgWkD5fpLYsEZhrOpRsuE6oUXTAU/aTPzh4Tp5eRpN4yUV2um3V//VmHsW5tuJg9Sgauh1aNftnziIAcqw1j34BPZrZ6sgIcBbI4+tNx/SrXQe5hLHU1s9LyL1NLPekU6xKMgOdCXen/izJ3rTQQoAXmBM35ByQvPC0/q9OQlBicxs+br3tkiiSu/j84xYBmd/u5WSyTxzvMTNiw1pWJ4Lj+/UJASkoqarbWRrA1tZFRMQ4X5BryCYHNuqmSreOvbPVKjoYw6+jbBoiStdE6ItZwrai9D0WP8bhg7YaPNngJqeCmDD3POtQbyZNmdvhrXv/5Sya/OuSp8cXr7ztLapG6myyxd/x1cIxoRpKCeOo2SLziusoHdHNXEjcHuoaDVj51G4+FLTBbSEzm8wrIgiiZhi0loH0ZgyfGhOkAZURojKIIna6tZ9VP8ctBiutVRS9E9bnYEOkjayBJ+M6bwvLawffyVhSBomYk+GLdfX+TqUs8tbnePlUlS4v6miazm3LBF2H5tOM/XRecR9oWQyNLwJEbZBoiBoQx+wOtP5o5Gipm7UzBG88xAGCM+DWOiDvhecEfyJ4mOs+ZCi/C54taKCIpPn/SnmHeeBZl32jdVf7wYxnUUqWi+Snqh4ER7IqTwQqGcj0szck9iypzuP8Hb1IbiygUXF4Fw5wu3ZEUu9JAsWo36ejwxPO6ZPSeq7CtqfnTRxB8C8UKIxVar2Gm2Pjz9B8OrQyhNOFkgiJgBo+/NcuUVXz+QoONPGhaAkTK6CLqfTzvbk9+/ZxWfCDHLTb6IlBxC7R7vpVwf5vw0pT6T8uf9kqIag/pM1//10veDajk5gZe/9MeqvfR/LnCOXaWz9XXxtTXcMUwuWHL/2KYxOhlh4zpZ//fyyKxjRRYO8+tu8b+bzJpzVR/EUCRBaYasmD8j+T+v5sRNhkmw9VWoe1h5lFtXUKrArYaxSrMaZucMOWciVkSp6uRT1OyGUN6oOoItU+Kdu0/DlYbLWgj0O5SeeNqapxWdAV1JZxSjbw5DqOmfjtujmOv2HsmtT5FQ7oC8m7SUPZCFRHMm30L29qR/9rEb59nMXKpKe7pnVG+Zuc4CdDopO4dY0K7OrGMvAXdZ8nC/ccSCit9a1VTbwTIoBHjIxniJRo7EpjNU1LA==",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvggPczolQiXSLfifWkDU1OQSadHkMaMDQLQtr3KzPZPVMp9yBE2661PwEXHrNJOyAZLQmmkqsriKtxsDA2WEse6uzdj7aG4z6xHTJHFqHhP3vNC2Ric25a8n78tNZg+mx0MWgH7Vdw+2aFvuV7iAYRBRLHUmsKUK1cJqKsFUr4Q5Ia5IGZeTfA1fMtAUL+T4BNpFMkIQGyDBXmH+mioUuj4qELW+t2C+GrqOkEbp+aJ9uZc4I8W+QYZ9TWKNskhGPg39dtJ+5coom1Lh4+6NeXZlNUj0h2vL6dcVtcoXbWHqMJ3/Y0o4kKuk8AvWRjJYl4pcCboorRbHKTiqgWkD5fpLYsEZhrOpRsuE6oUXTAU/aTPzh4Tp5eRpN4yUV2um3V//VmHsW5tuJg9Sgauh1aNftnziIAcqw1j34BPZrZ6sgIcBbI4+tNx/SrXQe5hLHU1s9LyL1NLPekU6xKMgOdCXen/izJ3rTQQoAXmBM35ByQvPC0/q9OQlBicxs+br3tkiiSu/j84xYBmd/u5WSyTxzvMTNiw1pWJ4Lj+/UJASkoqarbWRrA1tZFRMQ4X5BryCYHNuqmSreOvbPVKjoYw6+jbBoiStdE6ItZwrai9D0WP8bhg7YaPNngJqeCmDD3POtQbyZNmdvhrXv/5Sya/OuSp8cXr7ztLapG6myyxd/x1cIxoRpKCeOo2SLziusoHdHNXEjcHuoaDVj51G4+FLTBbSEzm8wrIgiiZhi0loH0ZgyfGhOkAZURojKIIna6tZ9VP8ctBiutVRS9E9bnYEOkjayBJ+M6bwvLawffyVhSBomYk+GLdfX+TqUs8tbnePlUlS4v6miazm3LBF2H5tOM/XRecR9oWQyNLwJEbZBoiBoQx+wOtP5o5Gipm7UzBG88xAGCM+DWOiDvhecEfyJ4mOs+ZCi/C54taKCIpPn/SnmHeeBZl32jdVf7wYxnUUqWi+Snqh4ER7IqTwQqGcj0szck9iypzuP8Hb1IbiygUXF4Fw5wu3ZEUu9JAsWo36ejwxPO6ZPSeq7CtqfnTRxB8C8UKIxVar2Gm2Pjz9B8OrQyhNOFkgiJgBo+/NcuUVXz+QoONPGhaAkTK6CLqfTzvbk9+/ZxWfCDHLTb6IlBxC7R7vpVwf5vw0pT6T8uf9kqIag/pM1//10veDajk5gZe/9MeqvfR/LnCOXaWz9XXxtTXcMUwuWHL/2KYxOhlh4zpZ//fyyKxjRRYO8+tu8b+bzJpzVR/EUCRBaYasmD8j+T+v5sRNhkmw9VWoe1h5lFtXUKrArYaxSrMaZucMOWciVkSp6uRT1OyGUN6oOoItU+Kdu0/DlYbLWgj0O5SeeNqapxWdAV1JZxSjbw5DqOmfjtujmOv2HsmtT5FQ7oC8m7SUPZCFRHMm30L29qR/9rEb59nMXKpKe7pnVG+Zuc4CdDopO4dY0K7OrGMvAXdZ8nC/ccSCit9a1VTbwTIoBHjIxniJRo7EpjNU1LA==\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "issue-company",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEFGHJ",
      buyer: Object.freeze({
        type: "company",
        ubn: "97025978",
        title: "測試股份有限公司",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"97025978\",\"CustomerName\":\"測試股份有限公司\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"1\",\"CarrierNum\":\"\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvU5WiZduQq/fkyxdBpO/C7w/YqE5JLF7q1zNkwoJIl96gtzLuJCYX5JNIvoAC40+hu2acmPpB2oxidgtou9j0r2gECPXpq7PxLpadfulHu2BBKwqSsQf1I0pnQV6363jPJhbUMKcQCy3/flaFy/dM8fWCyTD2NHY/pvobECGMasp0rxBKTy5lEZdCIusJ2riF8uQa4vGFLFe6QvHCr0r3F52EohslddXyTrT654RIZPEU/DbHpRNxm/dgnhFOvQe2EBnFleDXC733uNwb/+JoUKrbXjG9btcyr4LqOP5k/nNO8ZFsFkrq76dthZCK+XOc+OV0S3dYmLKMXm110RZRxrkNjuLh5tE5BVLghak+q/K/vbFzIZT7OpfDdlKDnQIXQKj/Z1SqyNf49xPDcG8OaCFdMyHzvupxKL1sxIEj6gJ5/fzK4GKCPY/fXRf7EL0n+dTQyAJD6ehYphnEM5UZZ6Zjhj66BPzaq/Q1Pcja5636Un4CeqHOWTgbI1cOoVMk8adBsIiMflnYn/N5oSz6kJLOLtwyXYPQccXeuhbm6gX1K+/bpPOXbbehj0pD6Axz77axtRv0noJ8aASWSxa40ZOQJRmstQ3qqc8wy/T4floDZ6n7MOTEEfN0HQPd9yt3gozSdc8gOEYo+7ppRjK4yRbhwxM7K5VBdgd9nQpkNi4pa5Iy56ax1xPvFShQle65OUg8y5RbVTifsmkwnMkdeCs85Tyf0KCEN7T1aqMAsXYqD1byImwZTk4pycaVu7fYFS/6lfQycLp9oWBqypvOatvmMv61d6qMdUToM70hFHpcwU8oVEKt6sHQeNnEbbFFWMBUEQOYQhJgj+kJ5yMZuBJreRdd/TBVatKLXcvlZNrmGPGrjcV4AaJatltdGTyjwwmiLncRrj3+nOyaZhJR8wzQxVXAEpYxznbOHWZhqmSoGa7rwWkRzhZ0JSJjogZsYtxzBq2GSACKc6rdtyFPAXrOwUdOe0dK0Aqz7HMbYVP+tYv3ScujUlBxdA1SmKrvpHBWXZOqj3S0KFIe/DWCVhvGFgBDVFMca3V/Ak7zeC4y0nEK+du285hm5ZyUjswETddbd2DrumsUAkuj4exlwgOB02Lip7I+VG7y8QkxHg0VUDVVvyKGkoB0yQSwK2O5BOAbW8oW4TCB+tvBVN/+Z9lw0aUI59I3cOIDqe/SM9TWiT82DZfeJKZ4PXD5F0sa3Sz9N1GD/CzMCgxxDidw1z4gcsMf7+RhGiMVmMdr1Xrz8cIbCl4zHg7ae+Zt5Wp1IxBuKNn0ikeVG3fWgcKZWIlulIWnzePsx4GOl6IkHqHX9dkQWUXc/1RojVOsqLtnBouPYheHrYqPwilcx2j9aj3tqgfTvAcJdJAHTpZhB99UvNb5hD9kp/5Z+cFTTOve3uYBI6MgVx0Ss61Ossjuxw1NN7z3WMbEg+yg3ueQUjOP8ItZ6ajw1rkxLaJvIlG5bUMAfv7bEnxTcfQCGrVRVosI6A5efSLzJKheMdlo3YNzsYXp26F8u4l1DxTCIzYP/kUSyNMAuPNNZR1+V7OyhLil2kzihwEwHK7cx/OTVPc=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvU5WiZduQq/fkyxdBpO/C7w/YqE5JLF7q1zNkwoJIl96gtzLuJCYX5JNIvoAC40+hu2acmPpB2oxidgtou9j0r2gECPXpq7PxLpadfulHu2BBKwqSsQf1I0pnQV6363jPJhbUMKcQCy3/flaFy/dM8fWCyTD2NHY/pvobECGMasp0rxBKTy5lEZdCIusJ2riF8uQa4vGFLFe6QvHCr0r3F52EohslddXyTrT654RIZPEU/DbHpRNxm/dgnhFOvQe2EBnFleDXC733uNwb/+JoUKrbXjG9btcyr4LqOP5k/nNO8ZFsFkrq76dthZCK+XOc+OV0S3dYmLKMXm110RZRxrkNjuLh5tE5BVLghak+q/K/vbFzIZT7OpfDdlKDnQIXQKj/Z1SqyNf49xPDcG8OaCFdMyHzvupxKL1sxIEj6gJ5/fzK4GKCPY/fXRf7EL0n+dTQyAJD6ehYphnEM5UZZ6Zjhj66BPzaq/Q1Pcja5636Un4CeqHOWTgbI1cOoVMk8adBsIiMflnYn/N5oSz6kJLOLtwyXYPQccXeuhbm6gX1K+/bpPOXbbehj0pD6Axz77axtRv0noJ8aASWSxa40ZOQJRmstQ3qqc8wy/T4floDZ6n7MOTEEfN0HQPd9yt3gozSdc8gOEYo+7ppRjK4yRbhwxM7K5VBdgd9nQpkNi4pa5Iy56ax1xPvFShQle65OUg8y5RbVTifsmkwnMkdeCs85Tyf0KCEN7T1aqMAsXYqD1byImwZTk4pycaVu7fYFS/6lfQycLp9oWBqypvOatvmMv61d6qMdUToM70hFHpcwU8oVEKt6sHQeNnEbbFFWMBUEQOYQhJgj+kJ5yMZuBJreRdd/TBVatKLXcvlZNrmGPGrjcV4AaJatltdGTyjwwmiLncRrj3+nOyaZhJR8wzQxVXAEpYxznbOHWZhqmSoGa7rwWkRzhZ0JSJjogZsYtxzBq2GSACKc6rdtyFPAXrOwUdOe0dK0Aqz7HMbYVP+tYv3ScujUlBxdA1SmKrvpHBWXZOqj3S0KFIe/DWCVhvGFgBDVFMca3V/Ak7zeC4y0nEK+du285hm5ZyUjswETddbd2DrumsUAkuj4exlwgOB02Lip7I+VG7y8QkxHg0VUDVVvyKGkoB0yQSwK2O5BOAbW8oW4TCB+tvBVN/+Z9lw0aUI59I3cOIDqe/SM9TWiT82DZfeJKZ4PXD5F0sa3Sz9N1GD/CzMCgxxDidw1z4gcsMf7+RhGiMVmMdr1Xrz8cIbCl4zHg7ae+Zt5Wp1IxBuKNn0ikeVG3fWgcKZWIlulIWnzePsx4GOl6IkHqHX9dkQWUXc/1RojVOsqLtnBouPYheHrYqPwilcx2j9aj3tqgfTvAcJdJAHTpZhB99UvNb5hD9kp/5Z+cFTTOve3uYBI6MgVx0Ss61Ossjuxw1NN7z3WMbEg+yg3ueQUjOP8ItZ6ajw1rkxLaJvIlG5bUMAfv7bEnxTcfQCGrVRVosI6A5efSLzJKheMdlo3YNzsYXp26F8u4l1DxTCIzYP/kUSyNMAuPNNZR1+V7OyhLil2kzihwEwHK7cx/OTVPc=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "issue-company_barcode",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEFGHJ",
      buyer: Object.freeze({
        type: "company",
        ubn: "97025978",
        title: "測試股份有限公司",
        barcode: "/AB12+-.",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"97025978\",\"CustomerName\":\"測試股份有限公司\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"3\",\"CarrierNum\":\"/AB12+-.\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvU5WiZduQq/fkyxdBpO/C7w/YqE5JLF7q1zNkwoJIl96gtzLuJCYX5JNIvoAC40+hu2acmPpB2oxidgtou9j0r2gECPXpq7PxLpadfulHu2BBKwqSsQf1I0pnQV6363jPJhbUMKcQCy3/flaFy/dM8fWCyTD2NHY/pvobECGMasp0rxBKTy5lEZdCIusJ2riF8uQa4vGFLFe6QvHCr0r3F52EohslddXyTrT654RIZPEU/DbHpRNxm/dgnhFOvQe2EBnFleDXC733uNwb/+JoUKrbXjG9btcyr4LqOP5k/nNO8ZFsFkrq76dthZCK+XOc+OV0S3dYmLKMXm110RZRxrkNjuLh5tE5BVLghak+q/K/vbFzIZT7OpfDdlKDnQIXQKj/Z1SqyNf49xPDcG8OaCFdMyHzvupxKL1sxIEj6gJb1hQb7hVe9rccSDePQnFOFFR8XbhuM5M33sJM8NEmB1gswDCw8mpPxky4xwy6qPghwZyTOK8AF4azRFBNRhG+uI85nv2SlBfjDJAJoFoycwUTGruebzMSD6bw6ekB5ALAX+gr8DRAU4g3UV7lgDh1MHKShCm3xQVOGUG7s4UbH84vOOGc/ygT4PsEfn/02kFwL1QVGy7S7sVQ9vug8fYEhmxjj/Gob9X+R86GA0sxctR6uEY2ax1T67h1V2GnP0cFPnI99vgwomW8I21aSmm1DiaNQb9Nxp9JTDeATNPwH2VkX14kVfQt7527N7DbfWW3uzm6MzQ5S7Bg7ao49I11GUdV64pBk7tLUUslHnZ4Ev4MEAJ5lVTb79teaaSrFfqTxYXrZ9R3VlszL0kK6iybpBGABD/aZhnupb11smi1l8F4dP0TxOCSdGyvnDbzi9m4kchr0jBCFMWoAgjFa03a24pLz2f6bIWbZXQsuZCJ03drlpvUg6J4BWq4DDXf2mhrobPxo9xQkUYSjbzZGBB52M9BAZqb7eLRQ0KmT14uMYpTpF8Ar3FsyS7UMpnHk5oyFJzmTqUq7Tr/yx1hWA0IErQlkQeH2xwlrctYKC+IOzvrOAR5a24gT+RrIGUkbxKj0wYX56yr7tT8ntw597bZWPeWazDiWOQ4YVeM9CVWiGG/A3krMZrftXkVgfBKUYS564ROu/W8RU1AQm8St5Igq9vE2OQ2nrU5qJxH8j+/pyWPwg0p646waPhXFG7upxRW/Jcmck9JRh4XVQtIGRwlNi+LyOvy54V0glWJcg+KT24NCuLg17InL+JanuzEI3InZUG/t6fkrgrtHZoD7y1v1ViHaywKAgJREUDQVeN8qh8b5cPQzh+if4lDx7tFk7R70G44Db/7atYyJaFdEKTuQdETKmke/y3zUztB25e+3pPMo5m5KIUU4LxSGRqyHcnRky4/qK61el2INPs0dRiBo1wERhY/k/+0oxExqR0pn6DlL01ZXSmCgugg7zriBqDWoPYYRl4FknzNNCQRfI4qDCZDSa/GVpAOR3AnAuNB3hOUjG5Of+qY6KKhjjGrbmpdCFRVlDJ3Sb7NfPLKjb5ne1RuIaEaDKGgA4WvkMoRq5OchJaVh4rJg7t5C/WoExhBrt20fk/3mMUSVPhIKPFW",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoAjlueLiHF338Ep1u+8sqsOaXQrzaPH3bPgyILxWgl3Crud4lbgSkTMCwbzmxtR36Wq8Md5MMlLBRFJix3JXCXvU5WiZduQq/fkyxdBpO/C7w/YqE5JLF7q1zNkwoJIl96gtzLuJCYX5JNIvoAC40+hu2acmPpB2oxidgtou9j0r2gECPXpq7PxLpadfulHu2BBKwqSsQf1I0pnQV6363jPJhbUMKcQCy3/flaFy/dM8fWCyTD2NHY/pvobECGMasp0rxBKTy5lEZdCIusJ2riF8uQa4vGFLFe6QvHCr0r3F52EohslddXyTrT654RIZPEU/DbHpRNxm/dgnhFOvQe2EBnFleDXC733uNwb/+JoUKrbXjG9btcyr4LqOP5k/nNO8ZFsFkrq76dthZCK+XOc+OV0S3dYmLKMXm110RZRxrkNjuLh5tE5BVLghak+q/K/vbFzIZT7OpfDdlKDnQIXQKj/Z1SqyNf49xPDcG8OaCFdMyHzvupxKL1sxIEj6gJb1hQb7hVe9rccSDePQnFOFFR8XbhuM5M33sJM8NEmB1gswDCw8mpPxky4xwy6qPghwZyTOK8AF4azRFBNRhG+uI85nv2SlBfjDJAJoFoycwUTGruebzMSD6bw6ekB5ALAX+gr8DRAU4g3UV7lgDh1MHKShCm3xQVOGUG7s4UbH84vOOGc/ygT4PsEfn/02kFwL1QVGy7S7sVQ9vug8fYEhmxjj/Gob9X+R86GA0sxctR6uEY2ax1T67h1V2GnP0cFPnI99vgwomW8I21aSmm1DiaNQb9Nxp9JTDeATNPwH2VkX14kVfQt7527N7DbfWW3uzm6MzQ5S7Bg7ao49I11GUdV64pBk7tLUUslHnZ4Ev4MEAJ5lVTb79teaaSrFfqTxYXrZ9R3VlszL0kK6iybpBGABD/aZhnupb11smi1l8F4dP0TxOCSdGyvnDbzi9m4kchr0jBCFMWoAgjFa03a24pLz2f6bIWbZXQsuZCJ03drlpvUg6J4BWq4DDXf2mhrobPxo9xQkUYSjbzZGBB52M9BAZqb7eLRQ0KmT14uMYpTpF8Ar3FsyS7UMpnHk5oyFJzmTqUq7Tr/yx1hWA0IErQlkQeH2xwlrctYKC+IOzvrOAR5a24gT+RrIGUkbxKj0wYX56yr7tT8ntw597bZWPeWazDiWOQ4YVeM9CVWiGG/A3krMZrftXkVgfBKUYS564ROu/W8RU1AQm8St5Igq9vE2OQ2nrU5qJxH8j+/pyWPwg0p646waPhXFG7upxRW/Jcmck9JRh4XVQtIGRwlNi+LyOvy54V0glWJcg+KT24NCuLg17InL+JanuzEI3InZUG/t6fkrgrtHZoD7y1v1ViHaywKAgJREUDQVeN8qh8b5cPQzh+if4lDx7tFk7R70G44Db/7atYyJaFdEKTuQdETKmke/y3zUztB25e+3pPMo5m5KIUU4LxSGRqyHcnRky4/qK61el2INPs0dRiBo1wERhY/k/+0oxExqR0pn6DlL01ZXSmCgugg7zriBqDWoPYYRl4FknzNNCQRfI4qDCZDSa/GVpAOR3AnAuNB3hOUjG5Of+qY6KKhjjGrbmpdCFRVlDJ3Sb7NfPLKjb5ne1RuIaEaDKGgA4WvkMoRq5OchJaVh4rJg7t5C/WoExhBrt20fk/3mMUSVPhIKPFW\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "issue-cdn-attempt-1",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEF02E",
      buyer: Object.freeze({
        type: "member_carrier",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 1,
    dataJson: "{ \"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEF02E\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"\",\"CustomerName\":\"\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"1\",\"CarrierNum\":\"\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "gtnU4YlEEVUGganqHe3Yfl0iFGWqf8cElspVkv8rimNY+a/GzSQ2hwe8Phe/4iPRlTHk+QYGC8pJtvsxXiyFamCzh9kOIDdfsDrwGT7FHrKoUN0a26UO73hzDrQ6c2T2WzMOi6DJWzmHZbGA3vxqSk8FwQdwHPTMyMlsJ22MG3Vuf9wTQ8niB7IkN75nGkRbnykINfiPJI5VEvIgcaJ+nS6WTwGQL8Xk2Bzc1G51yE4SDuGapvZABclcNYPDXcvimZ5SK1yuDtWtWNmscjb605nLQc27G5xbxFH294KXlMKadvVfgHi4/cn8kdIfxnNKgv0BuPvfDx8EPgAwSw50fkZ7SqJPrQcFBYGg5nFU47ec3olcKcMC974/exLlEzaGlrkIgrg5G5KrLHFf4S+h2vvOo0GA5K4lWR20XF+30LcYweT++dxsqBMDrKAAnL2V1D4m0uv+/5bafFSxUtNpU7WhpZ7kEYXj50XMzH/MK7EZaL335qx3l/0fmpHERwkkILwN0lsuNYKkraAReCzANEfL4FZ0DR8jS8RRKIDRbDwkEOXuZzmTLGfNssO0U2shDoNGy8q2olmc6ubmCTP3uUnqRczFT0YiYsj+YOHfGgELRybpcX0MzoM2WW7+71Z2+00uqcg5vLsv9mzyUQiDEq4I1R7tGyolYNbN1HneXteLoLDLXvdNV4cS4iLpdwzZLGGzgTDHvEIRVM18t2qOlT58RwujGVXf98/Tvhp+EmnXywWkjcbvmtU9A17F1SHHFZLXn8DY25xorUG0XJ4xLgEAGeQxfSUuvCBZsGPfk6hzi1u6ETO11Gbk6U5vszs908/D6tLZ2UgOCWMJDj0zSWqAT+c6pcAShmrfOhMX9Z6Q23+ZD11vYnXCoET2ybAw70EmAXVJlp3n9IWX1y8xtlbvoO0mp+Tp17eRdwbzMxWJFm3v0/AYU30C7zTkhz/XS1MQ+rpzELxebthJchCcaHDcZM7Gh78buYpH/7Xun+53iO+uOKFPX6YBh6tcSNGFVlwcoC6KZcd+EH91bhsDJtJJf3OtsJRMonQwpadkNw2IokrHm+GCCAv5m/ZWf2oaf94gZ0yQvNjQIi3ZMaJiTriqLAL/rzPWsgtZ+JbqMhzeOLYgZSlOmAEU8k8nDdtcwTVZ4kKl7uM5ZMP/eq4DLaPZYjPVHDjRA+Z+qFsKavIykbZIpQTdSf/Irl1B1Cz2lIum9k27RhOmNw1aEGSxbWrsure7a6UgOFqOu0HwXCiB2F/Uj13DcuS9m9ApE8Hg9inJintdQo4sVnU1lyv5m5MP+I3ypPifdf65qmPXhPCqjV+0to0PcWMfBQ8XgeHnxag1WoJJ1Xu0cij1Hdyh5yu9Cul6RPC0wh9zBurMKO2exlb4RLbEpRmI/UtPiPDiRwqcWLHhrDb6Iq5/2EW8Yrz3HXhgPjRY+w4eTWnM4kZDLiuo2mZpqF3Dnf2JINFfy/N+u9RGNaXh9R/8KBVga82+Cox98TsLwC/G9b2k+tBS1DvNkW+m6WinJn+6anmQkDdkBzzUYDCTbyECrm7hzQgIEKwnybSRg+BGymX7+HPjKdLTd14EGzMJgp57i50JaTkeW5CVHQ/g1rtoy9a41zpUP/+fMaKk6TyXwrgyQROazK7aBFf21Th0Slz6Mar7",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"gtnU4YlEEVUGganqHe3Yfl0iFGWqf8cElspVkv8rimNY+a/GzSQ2hwe8Phe/4iPRlTHk+QYGC8pJtvsxXiyFamCzh9kOIDdfsDrwGT7FHrKoUN0a26UO73hzDrQ6c2T2WzMOi6DJWzmHZbGA3vxqSk8FwQdwHPTMyMlsJ22MG3Vuf9wTQ8niB7IkN75nGkRbnykINfiPJI5VEvIgcaJ+nS6WTwGQL8Xk2Bzc1G51yE4SDuGapvZABclcNYPDXcvimZ5SK1yuDtWtWNmscjb605nLQc27G5xbxFH294KXlMKadvVfgHi4/cn8kdIfxnNKgv0BuPvfDx8EPgAwSw50fkZ7SqJPrQcFBYGg5nFU47ec3olcKcMC974/exLlEzaGlrkIgrg5G5KrLHFf4S+h2vvOo0GA5K4lWR20XF+30LcYweT++dxsqBMDrKAAnL2V1D4m0uv+/5bafFSxUtNpU7WhpZ7kEYXj50XMzH/MK7EZaL335qx3l/0fmpHERwkkILwN0lsuNYKkraAReCzANEfL4FZ0DR8jS8RRKIDRbDwkEOXuZzmTLGfNssO0U2shDoNGy8q2olmc6ubmCTP3uUnqRczFT0YiYsj+YOHfGgELRybpcX0MzoM2WW7+71Z2+00uqcg5vLsv9mzyUQiDEq4I1R7tGyolYNbN1HneXteLoLDLXvdNV4cS4iLpdwzZLGGzgTDHvEIRVM18t2qOlT58RwujGVXf98/Tvhp+EmnXywWkjcbvmtU9A17F1SHHFZLXn8DY25xorUG0XJ4xLgEAGeQxfSUuvCBZsGPfk6hzi1u6ETO11Gbk6U5vszs908/D6tLZ2UgOCWMJDj0zSWqAT+c6pcAShmrfOhMX9Z6Q23+ZD11vYnXCoET2ybAw70EmAXVJlp3n9IWX1y8xtlbvoO0mp+Tp17eRdwbzMxWJFm3v0/AYU30C7zTkhz/XS1MQ+rpzELxebthJchCcaHDcZM7Gh78buYpH/7Xun+53iO+uOKFPX6YBh6tcSNGFVlwcoC6KZcd+EH91bhsDJtJJf3OtsJRMonQwpadkNw2IokrHm+GCCAv5m/ZWf2oaf94gZ0yQvNjQIi3ZMaJiTriqLAL/rzPWsgtZ+JbqMhzeOLYgZSlOmAEU8k8nDdtcwTVZ4kKl7uM5ZMP/eq4DLaPZYjPVHDjRA+Z+qFsKavIykbZIpQTdSf/Irl1B1Cz2lIum9k27RhOmNw1aEGSxbWrsure7a6UgOFqOu0HwXCiB2F/Uj13DcuS9m9ApE8Hg9inJintdQo4sVnU1lyv5m5MP+I3ypPifdf65qmPXhPCqjV+0to0PcWMfBQ8XgeHnxag1WoJJ1Xu0cij1Hdyh5yu9Cul6RPC0wh9zBurMKO2exlb4RLbEpRmI/UtPiPDiRwqcWLHhrDb6Iq5/2EW8Yrz3HXhgPjRY+w4eTWnM4kZDLiuo2mZpqF3Dnf2JINFfy/N+u9RGNaXh9R/8KBVga82+Cox98TsLwC/G9b2k+tBS1DvNkW+m6WinJn+6anmQkDdkBzzUYDCTbyECrm7hzQgIEKwnybSRg+BGymX7+HPjKdLTd14EGzMJgp57i50JaTkeW5CVHQ/g1rtoy9a41zpUP/+fMaKk6TyXwrgyQROazK7aBFf21Th0Slz6Mar7\"}",
    blockedTerms: Object.freeze([
      "CD/",
    ]),
  }),
  Object.freeze({
    id: "issue-cdn-attempt-2",
    op: "issue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEF0PP",
      buyer: Object.freeze({
        type: "member_carrier",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 2,
    dataJson: "{  \"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEF0PP\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"\",\"CustomerName\":\"\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"1\",\"CarrierNum\":\"\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}",
    dataCipher: "FXXvV+WkadNnxaaO6U4onYDsMOhB1TU4yy8/EYFqG2YBS5+bK7D7Il1KZEgZk9YneG3M3xQQpMb32x0mmnNW0LxMHNancxmDTs7zQMdwfrFWr/N//StHU7MeluYZM9kfCvZO5dvds/EY7cRAddXAvOyai3bovxQvnhdfDpETOBRue5kfFvRZ1wdGSAGMh7soZT2dVudJ1i4WqBORIzlALPKnCSJn6DfJTb+/TDcXBDPVekJQoZxAw1Kg4N8gjiSL1z2KYmg10iXfb0kkiHt7pjeM9luBBiuSEyBp4mRXt+NjgV3MX1l4NEEWk2M3e3+fZkz45aIB+PtgaybVzjwmhbdD1foTVO/szfBVhs68WWjNt3rpweR8SGf6v5rHYy0i+PTqEqcACMTBGDGnrRHnGXF5rM9XXo3IpoMLMbMM8JvAKjb1Yh7ZK7AHYHBHNaa31oKstosYB9tfn7CzrxlvAtCFm2dHWvilbI4SsmDGvnBd8W4Ti7yV7oV7b4LNBPNs7E7XstKCvM76RI6CsdzO+V8RylYvdfb3Z/zhLyVPP23uR2POf43P9zyiuGEdFoNtN0hajcNLrv5mmLLK8obPR8uJmOJ5iMbBT9AT6KcA84AQj+Kd1UXckZBWkKihWw1FCiigL+SfQZulxU/Q16AY2mbM7wUIMoqd4vLoXVDxf5WMCleKSslEnjyS9BgQr4JUDV1Oq9jptYtbktS1JFaT+6sGoqVjtoZf063+megdHUUNR3DxzhXaaam//fzF+nXRbk/4v3ZvsXIwCOjkkI+lMbeBN75tlt6GVWJdLdUNHjpVwoJL3NDOa304pTZvsoanwZKWw/fQOv5AK9zzOaRPHkhUtkasl0um0KI9HVF8FJVLWJvLPQg2aYuRjHYU2OxFOHM4K6Y4EDTg+1H2qdpGGR6/KpxGUNju9mpq64SBJK56o93qkRJep0Xct/0cGZ1RWXXwlmZgjMg2rrXLiQOvZtXbghvN0r0trsUPQfmUkzAFVCuK+K6XiK72D/cew/wVhOFRb7WMbraaAuXhbeNYG94E9YmyCsybjoJASwm3dJgbFn7cMfrk9Zmw4t1D97cRk+8l2dXgMHwYbeHlHHqV+usbY8A0dmFrsfwwH9PviVODvMl4I6D5zM/GcpQLvmc5SwodDQG87VXU8NULEYATD2tZL9T/JGlQ1qV3EVxiOSE8jg/ksapZXn7Mmp3oTxiVNiP7uOHkaUrQG+fTvtyLMcG1r/++YF+e1WiYvtKdt0AaJZUWgRywiif0Ue2+XxEolXK3bhN/gt6MTnKVvNA6iO8n8yiatnn45rJ8mdfZw7fD7neeQwZ+I8YqZU5zpsff07tUbc8FQQw/c3Zf2Z0vI/q9NxgWf+I2QkXFpX+W+ssixTjh4Va5QBw8OMWlQ3bcxo3S4zZWtgshAwsgAkPP5C5OnFsbRWJDlsh1dllL6qIxuEPnUPJX0LSNOQRFm38khned/jv4Y+XYH7ZCbKdGpVQuQz6yc4M72PlVRD5wZG3NV4JTKfZB9nEmlNnkudihqFg+pRXpd44R/kYQpOTJNmSEAne3fZ58lga3KQUtoF1qPu1pjnJNlKWt38iz7ONNcLb5QTqP8zb+uAjGN7oMYAILGdrS95NRy+fZ2Hhg18xxVTPIm/Vkif00vi/O6PZn",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"FXXvV+WkadNnxaaO6U4onYDsMOhB1TU4yy8/EYFqG2YBS5+bK7D7Il1KZEgZk9YneG3M3xQQpMb32x0mmnNW0LxMHNancxmDTs7zQMdwfrFWr/N//StHU7MeluYZM9kfCvZO5dvds/EY7cRAddXAvOyai3bovxQvnhdfDpETOBRue5kfFvRZ1wdGSAGMh7soZT2dVudJ1i4WqBORIzlALPKnCSJn6DfJTb+/TDcXBDPVekJQoZxAw1Kg4N8gjiSL1z2KYmg10iXfb0kkiHt7pjeM9luBBiuSEyBp4mRXt+NjgV3MX1l4NEEWk2M3e3+fZkz45aIB+PtgaybVzjwmhbdD1foTVO/szfBVhs68WWjNt3rpweR8SGf6v5rHYy0i+PTqEqcACMTBGDGnrRHnGXF5rM9XXo3IpoMLMbMM8JvAKjb1Yh7ZK7AHYHBHNaa31oKstosYB9tfn7CzrxlvAtCFm2dHWvilbI4SsmDGvnBd8W4Ti7yV7oV7b4LNBPNs7E7XstKCvM76RI6CsdzO+V8RylYvdfb3Z/zhLyVPP23uR2POf43P9zyiuGEdFoNtN0hajcNLrv5mmLLK8obPR8uJmOJ5iMbBT9AT6KcA84AQj+Kd1UXckZBWkKihWw1FCiigL+SfQZulxU/Q16AY2mbM7wUIMoqd4vLoXVDxf5WMCleKSslEnjyS9BgQr4JUDV1Oq9jptYtbktS1JFaT+6sGoqVjtoZf063+megdHUUNR3DxzhXaaam//fzF+nXRbk/4v3ZvsXIwCOjkkI+lMbeBN75tlt6GVWJdLdUNHjpVwoJL3NDOa304pTZvsoanwZKWw/fQOv5AK9zzOaRPHkhUtkasl0um0KI9HVF8FJVLWJvLPQg2aYuRjHYU2OxFOHM4K6Y4EDTg+1H2qdpGGR6/KpxGUNju9mpq64SBJK56o93qkRJep0Xct/0cGZ1RWXXwlmZgjMg2rrXLiQOvZtXbghvN0r0trsUPQfmUkzAFVCuK+K6XiK72D/cew/wVhOFRb7WMbraaAuXhbeNYG94E9YmyCsybjoJASwm3dJgbFn7cMfrk9Zmw4t1D97cRk+8l2dXgMHwYbeHlHHqV+usbY8A0dmFrsfwwH9PviVODvMl4I6D5zM/GcpQLvmc5SwodDQG87VXU8NULEYATD2tZL9T/JGlQ1qV3EVxiOSE8jg/ksapZXn7Mmp3oTxiVNiP7uOHkaUrQG+fTvtyLMcG1r/++YF+e1WiYvtKdt0AaJZUWgRywiif0Ue2+XxEolXK3bhN/gt6MTnKVvNA6iO8n8yiatnn45rJ8mdfZw7fD7neeQwZ+I8YqZU5zpsff07tUbc8FQQw/c3Zf2Z0vI/q9NxgWf+I2QkXFpX+W+ssixTjh4Va5QBw8OMWlQ3bcxo3S4zZWtgshAwsgAkPP5C5OnFsbRWJDlsh1dllL6qIxuEPnUPJX0LSNOQRFm38khned/jv4Y+XYH7ZCbKdGpVQuQz6yc4M72PlVRD5wZG3NV4JTKfZB9nEmlNnkudihqFg+pRXpd44R/kYQpOTJNmSEAne3fZ58lga3KQUtoF1qPu1pjnJNlKWt38iz7ONNcLb5QTqP8zb+uAjGN7oMYAILGdrS95NRy+fZ2Hhg18xxVTPIm/Vkif00vi/O6PZn\"}",
    blockedTerms: Object.freeze([
      "CD/",
      "Cd/",
    ]),
  }),
  Object.freeze({
    id: "void",
    op: "void",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Invalid",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      invoiceDate: "2026-10-15",
      reason: "訂單取消",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"InvoiceDate\":\"2026-10-15\",\"Reason\":\"訂單取消\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjVs9bYn2ye0fv0v/L51SaYOnbdUk8CQttKSPg7f5UefORlJcvHSjqwSaQeRFKSTgUNL5TRiXIxhUvX/MvDvm5y8=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjVs9bYn2ye0fv0v/L51SaYOnbdUk8CQttKSPg7f5UefORlJcvHSjqwSaQeRFKSTgUNL5TRiXIxhUvX/MvDvm5y8=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "allowance-person",
    op: "allowance",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Allowance",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      invoiceDate: "2026-10-15",
      companyTitle: null,
      email: "buyer@example.test",
      allowanceAmountMinor: 9700,
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9700,
          amountMinor: 9700,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"InvoiceDate\":\"2026-10-15\",\"AllowanceNotify\":\"E\",\"CustomerName\":\"\",\"NotifyMail\":\"buyer@example.test\",\"NotifyPhone\":\"\",\"AllowanceAmount\":97,\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":97}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjYEZMNIV5yK3R2uLsocBAk5i8c1Z4Cr/FWWFdcIOWRMbhB4mPpIm2mFCQ/Lc45JElGSkWklYqOJ6PgzW+XGJZYgEWxpp9YzeWgUVTjosDnRrA3+Sd8nrYoNfrgGxdvorzDvoMcA7NQGYurwugAE2WX8AOQaXgcD1ad1UkMyPVfV9SMe7uzzUruGX2QH2ggcn7LVDT+Y/eGRV0qiq8dcN5EZj3DcLIepcZpu8xQ0wmyyp9MzAgK5iajzG1Pv6kyMi244lN3actlsnf7422uPezcVtisM4V6ejNdxS5DDxPTZ3OJnvHpQK6bNppzRiuzuCRSI5aEOwL3W1MZH6N7LKyfNtNRQkotGDOi3o3zjSkeReDY8XBktR0YVIM2ZSIR1Tel29uWYap3nNXgJS0YVLGTIj1cldpSvY36Du79WA8810NVV26JbxVoGhgvFkO1+Pc21f9PSe0gTQyMNCsLf9F2vhtsVq/83gtIKEnoz9R2XyunBd7Xw1TV7Q63PJiqreUYfK6eTNqXyTUBdbUDF5cap3ZqSxEZzw6Te79oyFnaS71TqV5WpKe6hZuLhmuxXw1w==",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjYEZMNIV5yK3R2uLsocBAk5i8c1Z4Cr/FWWFdcIOWRMbhB4mPpIm2mFCQ/Lc45JElGSkWklYqOJ6PgzW+XGJZYgEWxpp9YzeWgUVTjosDnRrA3+Sd8nrYoNfrgGxdvorzDvoMcA7NQGYurwugAE2WX8AOQaXgcD1ad1UkMyPVfV9SMe7uzzUruGX2QH2ggcn7LVDT+Y/eGRV0qiq8dcN5EZj3DcLIepcZpu8xQ0wmyyp9MzAgK5iajzG1Pv6kyMi244lN3actlsnf7422uPezcVtisM4V6ejNdxS5DDxPTZ3OJnvHpQK6bNppzRiuzuCRSI5aEOwL3W1MZH6N7LKyfNtNRQkotGDOi3o3zjSkeReDY8XBktR0YVIM2ZSIR1Tel29uWYap3nNXgJS0YVLGTIj1cldpSvY36Du79WA8810NVV26JbxVoGhgvFkO1+Pc21f9PSe0gTQyMNCsLf9F2vhtsVq/83gtIKEnoz9R2XyunBd7Xw1TV7Q63PJiqreUYfK6eTNqXyTUBdbUDF5cap3ZqSxEZzw6Te79oyFnaS71TqV5WpKe6hZuLhmuxXw1w==\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "allowance-company",
    op: "allowance",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/Allowance",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      invoiceDate: "2026-10-15",
      companyTitle: "測試股份有限公司",
      email: "buyer@example.test",
      allowanceAmountMinor: 9700,
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9700,
          amountMinor: 9700,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"InvoiceDate\":\"2026-10-15\",\"AllowanceNotify\":\"E\",\"CustomerName\":\"測試股份有限公司\",\"NotifyMail\":\"buyer@example.test\",\"NotifyPhone\":\"\",\"AllowanceAmount\":97,\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":97}]}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjYEZMNIV5yK3R2uLsocBAk5i8c1Z4Cr/FWWFdcIOWRMbhB4mPpIm2mFCQ/Lc45JElOF48gY7L+ifnqDtvFwZDNXC2KWJ2ZR5esA4TLJMy9x2uZj8rADkM57pqy4U+23IcsK6gnhOyqgR4iWpKmCk2GqF5PC/v5oYiP58tSONReDA2/bjJN8UIlgTJA2ztf4XBhsQa21U4UfKRjEM3WLNejNrKWZqDcGfj77ox2plj8LjyLDr2qKqjkjUPC4mp3KRRJ6rwGKeRCGCFlgL+b5roQCFcj/ez9ti+1rdYaLfmsAHHhIKpGbFOAHj0LoB3eq2Ha1xmvyRNalIVDmNX5PEpThjPIdGyECacwKIaqrd2363hrYPujVx8uPpq1MRQYxzr90g71G5c5u6hpCnCcLPcpsBitDH/cAxlX5RUfV2rTb6cj8kUcqoZeUsdPZkyGk3Lg1PzP87dYIzWMFsfpvkAM1n5Y8Q0VlbQjvaRVbhx8w3qIt4bsLDDNFJ2I+/DeTDi6t96fUPMo6Sk65yrCzFod5MckrlCPYrV1L/2sMK877ArcrgMq3nBGsP7bvL3XuiXpOCX3d4OouHT2fldWdg4JT08jUCh/0FuicLrFFZY9w1iQ0kw8qj1rLJcIDykoj3EBAajtVDZ/85NOPYsDnTrWY=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjYEZMNIV5yK3R2uLsocBAk5i8c1Z4Cr/FWWFdcIOWRMbhB4mPpIm2mFCQ/Lc45JElOF48gY7L+ifnqDtvFwZDNXC2KWJ2ZR5esA4TLJMy9x2uZj8rADkM57pqy4U+23IcsK6gnhOyqgR4iWpKmCk2GqF5PC/v5oYiP58tSONReDA2/bjJN8UIlgTJA2ztf4XBhsQa21U4UfKRjEM3WLNejNrKWZqDcGfj77ox2plj8LjyLDr2qKqjkjUPC4mp3KRRJ6rwGKeRCGCFlgL+b5roQCFcj/ez9ti+1rdYaLfmsAHHhIKpGbFOAHj0LoB3eq2Ha1xmvyRNalIVDmNX5PEpThjPIdGyECacwKIaqrd2363hrYPujVx8uPpq1MRQYxzr90g71G5c5u6hpCnCcLPcpsBitDH/cAxlX5RUfV2rTb6cj8kUcqoZeUsdPZkyGk3Lg1PzP87dYIzWMFsfpvkAM1n5Y8Q0VlbQjvaRVbhx8w3qIt4bsLDDNFJ2I+/DeTDi6t96fUPMo6Sk65yrCzFod5MckrlCPYrV1L/2sMK877ArcrgMq3nBGsP7bvL3XuiXpOCX3d4OouHT2fldWdg4JT08jUCh/0FuicLrFFZY9w1iQ0kw8qj1rLJcIDykoj3EBAajtVDZ/85NOPYsDnTrWY=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "online-allowance",
    op: "onlineAllowance",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/AllowanceByCollegiate",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      invoiceDate: "2026-10-15",
      companyTitle: null,
      email: "buyer@example.test",
      allowanceAmountMinor: 9700,
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9700,
          amountMinor: 9700,
        }),
      ]),
      returnUrl: "https://freedom.example.test/api/v1/provider-callbacks/ecpay/a1b2c3/invoice-allowance",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"InvoiceDate\":\"2026-10-15\",\"AllowanceNotify\":\"E\",\"CustomerName\":\"\",\"NotifyMail\":\"buyer@example.test\",\"AllowanceAmount\":97,\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":97}],\"ReturnURL\":\"https://freedom.example.test/api/v1/provider-callbacks/ecpay/a1b2c3/invoice-allowance\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjYEZMNIV5yK3R2uLsocBAk5i8c1Z4Cr/FWWFdcIOWRMbhB4mPpIm2mFCQ/Lc45JElGSkWklYqOJ6PgzW+XGJZYgEWxpp9YzeWgUVTjosDnRrA3+Sd8nrYoNfrgGxdvorzDvoMcA7NQGYurwugAE2WX9czE6xx5PjJ6VCtK84kkZHUzL4xWu5SQTXTbpyORoyMAX2uD/4wSO4NcN6V1eeU/RKv2IVD3gxOCDhqPcCXu8lQ1hrY3x5lvNUa5sytHMI4QUT78On5/rZuaW7pblwMXYDpqrcp4wPLOHgawlOr19S8eihS2oVynx3eD7l5Q4a/8AVQ51sjC5bEZsH46o4QTTlsggsqZbg6YPoQnPll+r/NS7Jbo2QEKwS8vf0AXMJL+5evaxAKbLCa2Gc+g42L/ORKkc40uf5wnhcxleaRywh0wV1iatdGHEd506oJhJIYrl6rJDm2Dbnfnvqm5uSVXEK0PTNdJ6InU1KHz9KXkOE9WP4Ax/llBZ+LKWeGGctbJkDNscU8Cf501ONGOW/NDXOP4TZXbmKPV4R7sefZgW19XP5gMNDzi32DQMdszWgDU36aQjeTEsqaQC6j1U9AdECTM8iFA3j9NenWZTM81kLGikXLevNykkGy3g7qW9xv9egctFR8qtqeaizoutUGpxcRwtBgjEidMIA/u5wqmPI2fcng/4DdGNxY2NCZAy2Iw==",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjYEZMNIV5yK3R2uLsocBAk5i8c1Z4Cr/FWWFdcIOWRMbhB4mPpIm2mFCQ/Lc45JElGSkWklYqOJ6PgzW+XGJZYgEWxpp9YzeWgUVTjosDnRrA3+Sd8nrYoNfrgGxdvorzDvoMcA7NQGYurwugAE2WX9czE6xx5PjJ6VCtK84kkZHUzL4xWu5SQTXTbpyORoyMAX2uD/4wSO4NcN6V1eeU/RKv2IVD3gxOCDhqPcCXu8lQ1hrY3x5lvNUa5sytHMI4QUT78On5/rZuaW7pblwMXYDpqrcp4wPLOHgawlOr19S8eihS2oVynx3eD7l5Q4a/8AVQ51sjC5bEZsH46o4QTTlsggsqZbg6YPoQnPll+r/NS7Jbo2QEKwS8vf0AXMJL+5evaxAKbLCa2Gc+g42L/ORKkc40uf5wnhcxleaRywh0wV1iatdGHEd506oJhJIYrl6rJDm2Dbnfnvqm5uSVXEK0PTNdJ6InU1KHz9KXkOE9WP4Ax/llBZ+LKWeGGctbJkDNscU8Cf501ONGOW/NDXOP4TZXbmKPV4R7sefZgW19XP5gMNDzi32DQMdszWgDU36aQjeTEsqaQC6j1U9AdECTM8iFA3j9NenWZTM81kLGikXLevNykkGy3g7qW9xv9egctFR8qtqeaizoutUGpxcRwtBgjEidMIA/u5wqmPI2fcng/4DdGNxY2NCZAy2Iw==\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "void-allowance",
    op: "voidAllowance",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/AllowanceInvalid",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      allowanceNo: "2026101512345678",
      reason: "折讓作廢",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"AllowanceNo\":\"2026101512345678\",\"Reason\":\"折讓作廢\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8RUXOSoVmxwU+RGwhPbgU/cUnVb9g/djA1vm1BNFDy74rcyrFYb+9ruM2TtxU0/4lEs2gzCuG1hZkPdot6fykDSzT6ozOWBqw+VP5RN3UDcd+yYUNKY4m77wV84yz922JaTgEj/OJYNINtX8OeMbNyHvODu0qiwKFa3OyPAzo9PE",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8RUXOSoVmxwU+RGwhPbgU/cUnVb9g/djA1vm1BNFDy74rcyrFYb+9ruM2TtxU0/4lEs2gzCuG1hZkPdot6fykDSzT6ozOWBqw+VP5RN3UDcd+yYUNKY4m77wV84yz922JaTgEj/OJYNINtX8OeMbNyHvODu0qiwKFa3OyPAzo9PE\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "cancel-online-allowance",
    op: "cancelOnlineAllowance",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/AllowanceInvalidByCollegiate",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      allowanceNo: "2026101512345678",
      reason: "取消折讓",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"AllowanceNo\":\"2026101512345678\",\"Reason\":\"取消折讓\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8RUXOSoVmxwU+RGwhPbgU/cUnVb9g/djA1vm1BNFDy74rcyrFYb+9ruM2TtxU0/4lEs2gzCuG1hZkPdot6fykDQQZXj/AQN7e36wQ3SFYfFoj0wXSZGpgNACHaVxy310yZ/nrW8nLWE9yTfzG65qnWqyRWS4PZUewEu540f1bugx",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8RUXOSoVmxwU+RGwhPbgU/cUnVb9g/djA1vm1BNFDy74rcyrFYb+9ruM2TtxU0/4lEs2gzCuG1hZkPdot6fykDQQZXj/AQN7e36wQ3SFYfFoj0wXSZGpgNACHaVxy310yZ/nrW8nLWE9yTfzG65qnWqyRWS4PZUewEu540f1bugx\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "void-with-reissue",
    op: "voidWithReissue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/VoidWithReIssue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      voidReason: "買受人資料更正",
      relateNumber: "I0123456789ABCDEFGHJ",
      invoiceDateTime: "2026-10-15 10:20:30",
      buyer: Object.freeze({
        type: "company",
        ubn: "97025978",
        title: "測試股份有限公司",
      }),
      email: "buyer@example.test",
      salesAmountMinor: 35000,
      remark: "訂單 261015-7K3M9Q",
      itemWord: "件",
      items: Object.freeze([
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 1,
          priceMinor: 9600,
          amountMinor: 9600,
        }),
        Object.freeze({
          name: "手工皂（薰衣草）",
          count: 2,
          priceMinor: 9700,
          amountMinor: 19400,
        }),
        Object.freeze({
          name: "運費",
          count: 1,
          priceMinor: 6000,
          amountMinor: 6000,
        }),
      ]),
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"VoidModel\":{\"InvoiceNo\":\"AB12345678\",\"VoidReason\":\"買受人資料更正\"},\"IssueModel\":{\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"InvoiceDate\":\"2026-10-15 10:20:30\",\"CustomerID\":\"\",\"CustomerIdentifier\":\"97025978\",\"CustomerName\":\"測試股份有限公司\",\"CustomerAddr\":\"\",\"CustomerPhone\":\"\",\"CustomerEmail\":\"buyer@example.test\",\"Print\":\"0\",\"Donation\":\"0\",\"LoveCode\":\"\",\"CarrierType\":\"1\",\"CarrierNum\":\"\",\"TaxType\":\"1\",\"SalesAmount\":350,\"InvoiceRemark\":\"訂單 261015-7K3M9Q\",\"InvType\":\"07\",\"vat\":\"1\",\"Items\":[{\"ItemSeq\":1,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":96,\"ItemAmount\":96},{\"ItemSeq\":2,\"ItemName\":\"手工皂（薰衣草）\",\"ItemCount\":2,\"ItemWord\":\"件\",\"ItemPrice\":97,\"ItemAmount\":194},{\"ItemSeq\":3,\"ItemName\":\"運費\",\"ItemCount\":1,\"ItemWord\":\"件\",\"ItemPrice\":60,\"ItemAmount\":60}]}}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTVwa4+s0ZUdNDfBJ+ZNGtceeClb9tqqrFKYp0wQKBnp4TC5TLlaUybpSTy1WFH6RrRh5YN+Nlf1AbBMsuM87auEnuiiz1AYZsCuMSj061bVPYpimasA/2z27g/5ptga0h7X3md1Dey4Fl5hQhVPATuzPVlC+VrYKROTbmfUv6mvfhlgPCTIBzW3JxN4HZtsE5t0bNz7XP460dIJBavPAcsSqu99DO4D5BR9xPGDuqQBkuCqvOfAUq9nGpIqsr2jMzCfYcUZVtM3OA9LX2sPkwqP4K+NdfR7BmI2xhgQ5k9MqaAVI7+qmhJGMu26bYGswv/0QIqFQKAq+j61sEj5ymSoksyhz9pxyuZR+N2k94rbMviT49boc0IMm9/jyYIhJQVPrN/36WWuvyxvXKLir+r6Dwh11nM2sh5oDIvBf4WqkpHjtvd5iurv++9CKOJqpWxqH2yfWlyAUnw1TIps5EKVfqWSQKbQprjG5We1LZreKZs82N0ZzIUvuK7YuXG16lp2cPP/g63z6lQ2KpmjAu7llMOORYHmZkJWMHAozj1xkVCKNjYpbVapZKVuFF4tfAT2bqQooh84KWJaMz6RWT1r1rAali74PVCg8MC07UOw+gIhVqrAZwNo8bCK21dvPFsIQZ9R3t/ZTvJQ6QQg5WbL6zwsVivXHG6VVmw/XrmXhkesuK4ip+N5Tr+HceWOHURY++YEqDUUMUIa3XsNm856OTiZCUb1c3NEp2KKdcZBU9iEf9+v2crhY0o9Q8fLDzeO7XbciFK0suYZK73Pd/Ehqwc5vittHL5167adR0111+e6PQcNNOlGI0w54/DbNrWQy7w41E3xkNtqkgGvDTtbDB3e5fJ0SPobbIX5KjGrOlVwuIqDsN3kUhDptkg0Us0V/ml54O1mz4+3/v4Ij/2viGmH/oGJpjwbLpKPB6rQ6yivxhKkfwVZErIJLz4mK1VNVGPGn93fB3WSP4BTMcg99X1HGjzYRg38qxwvsZyV5dvmEpMihZdq0mKdopvcTfH0Sb8DWGLbuM/KO5FIE7QFtBSsOj/dOa5a6lYHaPx+8Mmx1dAnEKYxtn0xyPvfbIRcMasP5QwSXnP3njJFChAl2Z3lxPmCEdBv01H0r7Di8/SJyODy2vhFhDPJEMF2oWPgQ7CdDOVmckT0qA7kmkWyOJwCUo0+IWQi0+a+NKh0FhD/uuW6QJMj+/tz/lZ/Y+OZoTrZsVft2uNE90auUwdlTl6iYDoNkZR/7yJ5s2FVgo2T4AxvtLdpmjbhvMuYxDicNAJNF+O2u5VbLLHcI8iV4LRGRKLaLby9OjtrOW6qoefvvx4DkX2n62b7/rE9ANpiIO9SEYf6xM4vpcTrk0CaqSILb2KENgXoe7yBVMhgsQJ62R/EzGpGSVOSDzCA/+Hx57Sc3mC/zUxyzPBcnnobkN2dTtbzpN2vSNfL69Ic2qdd7pYVePGncKYm9YEvVqmLvQ6u2VKQ2w/2ARx3jxAHvoej/hv8gvz7Swj0vU2ox44Rilbi5fqxt7Y1ZOAdNt0/SSiOQyfoS0GSVJ/8rm+BSiR5PP0THtf8yZeYGP5kHJHAyIG+XEWBT+JtguUgfgKepmX+LA21JtZtgTmLau85xjG7NIvZBs4HwhvvgP28lgHdToL7W2gJgAJuuJofG68Ev7NKHth32W5/et0rUpT9sTIGFCbmWgwZigza2TkZZlPOA1qu8RD2i3ot/00HQf63hRDcj71MACNjT1BuXdkoLcPKa4Pa2YE0TsklDL0OYsgI5RwwFXwrPEXkElv4mXgHLO98Zv9pAWgygKkA6Ut8tOet4C3oG4nDEO9kxwdB5ylc95NvPkWZTnTMyHN4VdT1hTt0U2pTzi0uimBnYbaE67h/l60XIeTiLoVVBXZd38SUOeEUqYF/lPCgGMvkFS6sV82biZr8v7VPzdUHWzNqp8NLDCzkSdi8eZRC+1OfTwkw816vyKTIbB1cBDN6cX6LZHjpnLJOUvEwvWZTyct3z8auYVHp9ku0i28PQ6irm7VuaVI4loGVeaP7xvKU0wk=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"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\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "get-issue-by-relate-number",
    op: "getIssue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetIssue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      by: "relate_number",
      relateNumber: "I0123456789ABCDEFGHJ",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoDMWY4SHHCVU4+/iYTuxwD/",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoDMWY4SHHCVU4+/iYTuxwD/\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "get-issue-by-invoice-no",
    op: "getIssue",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetIssue",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      by: "invoice_no",
      invoiceNo: "AB12345678",
      invoiceDate: "2026-10-15",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"InvoiceDate\":\"2026-10-15\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjf4EOFdsM7HVqBZaeDxrwUI=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8SHq3Ze/EtmP0RKAaGQrWIveqkGPSQ8/2wsv8DoeCZqmSSsoPX4nKu9lHKDCCLutjf4EOFdsM7HVqBZaeDxrwUI=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "get-allowances-by-allowance-no",
    op: "getAllowanceList",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetAllowanceList",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      by: "allowance_no",
      allowanceNo: "2026101512345678",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"SearchType\":\"0\",\"AllowanceNo\":\"2026101512345678\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBmp/Q5/LDofurfsLleirOAJKCM6Df+1uT1zhIYf3jGdjEVc3/KYipwlzqgEwMMZiZCXQQlv7YXOOUwGqlW8geV7Kr5rPH8M+ih66yUIw/wz2eT2asoMZ+MQBMkJ0/Yrs=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBmp/Q5/LDofurfsLleirOAJKCM6Df+1uT1zhIYf3jGdjEVc3/KYipwlzqgEwMMZiZCXQQlv7YXOOUwGqlW8geV7Kr5rPH8M+ih66yUIw/wz2eT2asoMZ+MQBMkJ0/Yrs=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "get-allowances-by-invoice-date",
    op: "getAllowanceList",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetAllowanceList",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      by: "invoice_date",
      invoiceNo: "AB12345678",
      date: "2026-10-15",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"SearchType\":\"1\",\"InvoiceNo\":\"AB12345678\",\"Date\":\"2026-10-15\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBmp/Q5/LDofurfsLleirOaIzstV2QSu6o11IUIRjXJWCsW2rCzsW8tIM4a70N0MjVFqP8Uo1xrH9uyZZ1Wsywmu6jKgP4Wya5USpfuiaXGXAU8GxejBBJBr+AIzd78Mev0IISv7yCksH+hh65yOE9",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBmp/Q5/LDofurfsLleirOaIzstV2QSu6o11IUIRjXJWCsW2rCzsW8tIM4a70N0MjVFqP8Uo1xrH9uyZZ1Wsywmu6jKgP4Wya5USpfuiaXGXAU8GxejBBJBr+AIzd78Mev0IISv7yCksH+hh65yOE9\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "get-allowances-by-allowance-date",
    op: "getAllowanceList",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetAllowanceList",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      by: "allowance_date",
      invoiceNo: "AB12345678",
      date: "2026-10-16",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"SearchType\":\"2\",\"InvoiceNo\":\"AB12345678\",\"Date\":\"2026-10-16\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBmp/Q5/LDofurfsLleirOGI2/HMMbMJ/CjemkHhGZv5SFOcRPg7KrFJexb2XDKXZ8TJq37r9I3miOPtZLmi+H5mn98FPAaGmCJojozYGo/ylRmNMWDd/CIVbGyMmsXUMaupOmZx5ccp6OCzDZmLsU",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBmp/Q5/LDofurfsLleirOGI2/HMMbMJ/CjemkHhGZv5SFOcRPg7KrFJexb2XDKXZ8TJq37r9I3miOPtZLmi+H5mn98FPAaGmCJojozYGo/ylRmNMWDd/CIVbGyMmsXUMaupOmZx5ccp6OCzDZmLsU\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "get-invalid",
    op: "getInvalid",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetInvalid",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      relateNumber: "I0123456789ABCDEFGHJ",
      invoiceNo: "AB12345678",
      invoiceDate: "2026-10-15",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"RelateNumber\":\"I0123456789ABCDEFGHJ\",\"InvoiceNo\":\"AB12345678\",\"InvoiceDate\":\"2026-10-15\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoDpHb1+J+/snTCdPoSqCf2KYxIqW7Q4FcM3OFAb6NniUWmWp0YD0m787KI1pRl9AbKduUylCot6m9Pnjizp7EbRmD6DfX0o9Xt0vs4EbuoAGwS9wssleJpf2N5AM931UnE=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTV7XoPByaStato0iqOI39rIU0jfSjBTLYv83MNpnflnivY4yszrjy0ZJUAgwXmKAoDpHb1+J+/snTCdPoSqCf2KYxIqW7Q4FcM3OFAb6NniUWmWp0YD0m787KI1pRl9AbKduUylCot6m9Pnjizp7EbRmD6DfX0o9Xt0vs4EbuoAGwS9wssleJpf2N5AM931UnE=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "get-allowance-invalid",
    op: "getAllowanceInvalid",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetAllowanceInvalid",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceNo: "AB12345678",
      allowanceNo: "2026101512345678",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceNo\":\"AB12345678\",\"AllowanceNo\":\"2026101512345678\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8RUXOSoVmxwU+RGwhPbgU/cUnVb9g/djA1vm1BNFDy74rcyrFYb+9ruM2TtxU0/4lAyrRWLrgBoyDWBkIgC4zoo=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwgIoBmposlBeqKqWsP9uJ8RUXOSoVmxwU+RGwhPbgU/cUnVb9g/djA1vm1BNFDy74rcyrFYb+9ruM2TtxU0/4lAyrRWLrgBoyDWBkIgC4zoo=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "check-barcode",
    op: "checkBarcode",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/CheckBarcode",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      barcode: "/AB12+-.",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"BarCode\":\"/AB12+-.\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTW3DVa6yI7vKmjBRp2eulDhgRJxBAJ4naFxx8xdOeIyrfBNt/B6ZBavqyDxqFrNJXs=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTW3DVa6yI7vKmjBRp2eulDhgRJxBAJ4naFxx8xdOeIyrfBNt/B6ZBavqyDxqFrNJXs=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "check-love-code",
    op: "checkLoveCode",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/CheckLoveCode",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      loveCode: "000123",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"LoveCode\":\"000123\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTX5GPq4C0iHkAYpj2V9lP+JSXOky4kOh81rzt+oHRnvRM1j7FisAurCdnBIoWaRRIE=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTX5GPq4C0iHkAYpj2V9lP+JSXOky4kOh81rzt+oHRnvRM1j7FisAurCdnBIoWaRRIE=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "company-name",
    op: "companyName",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetCompanyNameByTaxID",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      ubn: "97025978",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"UnifiedBusinessNo\":\"97025978\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTWzPVQ9hX9PsLNlUlrWaxUfXYihqKmN5JEa68w5ctIiDZXhEB4GzM9wAeJ3v2VRbg6x4U4hzNCfyz89ZAb93RG0",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTWzPVQ9hX9PsLNlUlrWaxUfXYihqKmN5JEa68w5ctIiDZXhEB4GzM9wAeJ3v2VRbg6x4U4hzNCfyz89ZAb93RG0\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "word-setting",
    op: "wordSetting",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetInvoiceWordSetting",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceYear: "115",
      invoiceTerm: 5,
      useStatus: 2,
      invType: "07",
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceYear\":\"115\",\"InvoiceTerm\":5,\"UseStatus\":2,\"InvoiceCategory\":1,\"InvType\":\"07\"}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwDj7z58fWxDqR8ZFb4oqdx6DJ6XJ08STErmI92o/7VI+Ar9FIZ2YAI9xQrCFv20bC7fJA6u1VNRQdHP1psJOnm3t+mqyPE8Lg6U+CLEeUgNjQYnMF3n5d92ACnQEdE2Fi0LfKm/ep5riwzkNWY2SfqkTGdx2EoLg4jD5SAstavdk=",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwDj7z58fWxDqR8ZFb4oqdx6DJ6XJ08STErmI92o/7VI+Ar9FIZ2YAI9xQrCFv20bC7fJA6u1VNRQdHP1psJOnm3t+mqyPE8Lg6U+CLEeUgNjQYnMF3n5d92ACnQEdE2Fi0LfKm/ep5riwzkNWY2SfqkTGdx2EoLg4jD5SAstavdk=\"}",
    blockedTerms: Object.freeze([]),
  }),
  Object.freeze({
    id: "word-setting-all",
    op: "wordSetting",
    url: "https://einvoice-stage.ecpay.com.tw/B2CInvoice/GetInvoiceWordSetting",
    input: Object.freeze({
      environment: "sandbox",
      merchantId: "2000132",
      timestampSeconds: 1792044000,
      invoiceYear: "115",
      invoiceTerm: 0,
      useStatus: 0,
      invType: null,
    }),
    attempt: 0,
    dataJson: "{\"MerchantID\":\"2000132\",\"InvoiceYear\":\"115\",\"InvoiceTerm\":0,\"UseStatus\":0,\"InvoiceCategory\":1}",
    dataCipher: "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwDj7z58fWxDqR8ZFb4oqdx6DJ6XJ08STErmI92o/7VI8pr9YO1vKSpPuc/ALZ2SSnL/VzJEsRSb5LnwHGDBZZ3Ki24c/LjDhsJyzKSxDAs6eMVHrNt+njBEg0xb2HeO5h+XD+jQc/M0rWN3VMCJMfWA==",
    bodyText: "{\"PlatformID\":\"\",\"MerchantID\":\"2000132\",\"RqHeader\":{\"Timestamp\":1792044000},\"Data\":\"XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTUBUbt3mZEoyD3XQjjBRhcwDj7z58fWxDqR8ZFb4oqdx6DJ6XJ08STErmI92o/7VI8pr9YO1vKSpPuc/ALZ2SSnL/VzJEsRSb5LnwHGDBZZ3Ki24c/LjDhsJyzKSxDAs6eMVHrNt+njBEg0xb2HeO5h+XD+jQc/M0rWN3VMCJMfWA==\"}",
    blockedTerms: Object.freeze([]),
  }),
]);

export const B2C_INVOICE_ISSUE_RESPONSE_LOWER_HEX: B2cInvoiceIssueResponseLowerHexGolden = Object.freeze({
  body: "{\"MerchantID\":\"2000132\",\"RpHeader\":{\"Timestamp\":1792044003},\"TransCode\":1,\"TransMsg\":\"\",\"Data\":\"6xafbXXjyQnBuHWKr5nDl3elIhyu1OUPiZsXnreThwQMIYbPFyWZHL9ALxDT9maQm1zzov+o2Suh56+NpeqrtK7A6EwTVdAJGbl/4ATxEScKukTLEjpSflzkNBeN513sqfGsjM8REOlO29AJFOeRnvpwg2zmqmBCZEaBlTjMSa1Wm8doK8B4zL7q1j9cvDby2MC/TJk/f0aHCzS+5lCl8tb7BzN1Q/7uoJ+EK88/QT+A0hnrOYIQXF94eMh+m47brK1fSR2qGOtCaXjtgRyiXvsP2wSK4qbL0TeWR3BHCgWy3HBOVpJKRnRUaYxKjPhx\"}",
  expected: Object.freeze({
    invoiceNo: "AB12345678",
    invoiceDateTime: "2026-10-15 14:00:03",
    invoiceAtEpochMs: 1792044003000,
    randomNumber: "0042",
  }),
});
