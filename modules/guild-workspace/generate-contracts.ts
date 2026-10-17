import * as shipping from '../../contracts/guild-launchpad/v1/hosted-shipping.js';
import * as commerceSetup from '../../contracts/guild-launchpad/v1/hosted-commerce-setup.js';
import * as sellerCheckout from '../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import * as offlinePayment from '../../contracts/guild-launchpad/v1/hosted-offline-payment.js';
import * as checkout from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import * as supplyCatalog from '../../contracts/guild-launchpad/v1/hosted-supply-catalog.js';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from '../../contracts/guild-launchpad/v1/config.js';
import { configSchema as assemblySchema } from '../../contracts/guild-launchpad/v2/config.js';
import {
  BackfillInput, BackfillReport, ClassificationInput, GuildClassification, LeaveV2Input, PreferenceView, SetPreferenceInput, SwitchInput,
} from '../../contracts/guild-launchpad/v1/guild-preferences.js';
import { Problem, ValidationFailedProblem } from '../../contracts/guild-launchpad/v1/primitives.js';
import {
  AcceptResultSchema, CreateResultSchema, EmptyObjectSchema, InvitationPageSchema, InvitationRevokeInputSchema, InvitationViewSchema,
  InviteCandidateSchema, InviteInputSchema, LeaveResultSchema, MemberChangeInputSchema, MemberPageSchema, MemberViewSchema,
  TenantCreateInputSchema, TenantEditInputSchema, TenantPageSchema, TenantViewSchema, WorkspaceCreateInputSchema, WorkspacePageSchema,
  WorkspaceViewSchema,
} from '../../contracts/guild-launchpad/v1/tenant.js';
import {
  EmptyObjectSchema as WorkArchiveInputSchema, EnableManualWorkSchema, FinalizeSchema, InstanceCandidateSchema, LaunchpadContextSchema,
  ManualWorkBindingSchema, ModuleInstancePageSchema, ModuleInstanceViewSchema, OperationSchema, ResultPageSchema, ResultSchema,
  UploadPrepareSchema, UploadSchema, UploadVerifiedSchema, WorkPageSchema, WorkSchema, WorkWriteSchema,
} from '../../contracts/guild-launchpad/v1/tenant-work.js';

import * as storefront from '../../contracts/guild-launchpad/v1/storefront.js';
import * as presentation from '../../contracts/guild-launchpad/v1/storefront-presentation.js';
import * as hostedMedia from '../../contracts/guild-launchpad/v1/hosted-store-media.js';
import * as sharedOrder from '../../contracts/guild-launchpad/v1/hosted-shared-order.js';
import * as hostedOrder from '../../contracts/guild-launchpad/v1/hosted-order.js';
import * as distribution from '../../contracts/guild-launchpad/v1/hosted-distribution.js';
import * as supplyTerms from '../../contracts/guild-launchpad/v1/hosted-supply-terms.js';
import * as supplierConsole from '../../contracts/guild-launchpad/v1/supplier-console.js';

const PREAMBLE = 'Structural shape only. The server decides identity, membership, capability, current version and quotas.';
const displayName = ['display_name_control_character'] as const;
const reason = ['reason_control_character'] as const;
const instanceGrants = ['instance_ids_unique', 'instance_capability_keys_unique'] as const;
const launchpad = [
  'guild_key_pattern_and_bounds', 'text_control_surrogate_and_utf8_bounds', 'block_id_stable_key',
  'block_kind_set_and_duplicates', 'block_order_range_and_uniqueness', 'mandatory_block_enabled',
  'application_duplicate', 'public_url_https',
] as const;

function description(rules: readonly string[]): string {
  return `${PREAMBLE} Server-only rules: ${rules.length ? rules.join(', ') : 'none'}.`;
}

const workText = [
  'work_title_trimmed_blank', 'work_title_control_character', 'work_title_lone_surrogate',
  'work_objective_trimmed_blank', 'work_objective_control_character', 'work_objective_lone_surrogate', 'work_objective_utf8_bytes',
] as const;
const fileName = [
  'file_display_name_slash', 'file_display_name_backslash', 'file_display_name_control_character',
  'file_display_name_lone_surrogate', 'file_display_name_non_bmp',
] as const;
const TENANT_WORK_DESCRIPTION = 'Tenant manual Work, human Results, module instances, and workspace launchpad context. Structural shapes only; the server decides identity, membership, capability, current version and quotas.';

const documents: ReadonlyArray<readonly [string, z.ZodType, 'input' | 'output', readonly string[]]> = [
  ['set-preference-input', SetPreferenceInput, 'input', []],
  ['leave-v2-input', LeaveV2Input, 'input', []],
  ['classification-input', ClassificationInput, 'input', [
    'capability_tag_trimmed_blank', 'capability_tag_control_or_markup', 'capability_tags_unique', 'classification_reason_trimmed_short',
  ]],
  ['preference-backfill-input', BackfillInput, 'input', []],
  ['preference-switch-input', SwitchInput, 'input', []],
  ['tenant-create-input', TenantCreateInputSchema, 'input', displayName],
  ['tenant-edit-input', TenantEditInputSchema, 'input', displayName],
  ['workspace-create-input', WorkspaceCreateInputSchema, 'input', displayName],
  ['tenant-invite-input', InviteInputSchema, 'input', instanceGrants],
  ['invitation-revoke-input', InvitationRevokeInputSchema, 'input', reason],
  ['member-change-input', MemberChangeInputSchema, 'input', [...reason, ...instanceGrants]],
  ['empty-command-input', EmptyObjectSchema, 'input', []],
  ['launchpad-config', configSchema, 'input', launchpad],
  ['guild-classification', GuildClassification, 'output', []],
  ['preference-view', PreferenceView, 'output', []],
  ['preference-backfill-report', BackfillReport, 'output', []],
  ['tenant-view', TenantViewSchema, 'output', displayName],
  ['workspace-view', WorkspaceViewSchema, 'output', displayName],
  ['member-view', MemberViewSchema, 'output', []],
  ['invitation-view', InvitationViewSchema, 'output', displayName],
  ['tenant-page', TenantPageSchema, 'output', displayName],
  ['workspace-page', WorkspacePageSchema, 'output', displayName],
  ['member-page', MemberPageSchema, 'output', []],
  ['invitation-page', InvitationPageSchema, 'output', displayName],
  ['tenant-leave-result', LeaveResultSchema, 'output', []],
  ['invitation-accept-result', AcceptResultSchema, 'output', displayName],
  ['tenant-create-result', CreateResultSchema, 'output', displayName],
  ['invite-candidate', InviteCandidateSchema, 'output', []],
  ['problem', Problem, 'output', []],
  ['validation-failed-problem', ValidationFailedProblem, 'output', []],
];

const tenantWorkDocuments: ReadonlyArray<readonly [string, z.ZodType, 'input' | 'output', readonly string[]]> = [
  ['work-write-input', WorkWriteSchema, 'input', workText],
  ['work-archive-input', WorkArchiveInputSchema, 'input', []],
  ['upload-prepare-input', UploadPrepareSchema, 'input', fileName],
  ['result-finalize-input', FinalizeSchema, 'input', []],
  ['enable-manual-work-input', EnableManualWorkSchema, 'input', []],
  ['work-operation', OperationSchema, 'output', []],
  ['work-view', WorkSchema, 'output', workText],
  ['work-page', WorkPageSchema, 'output', workText],
  ['upload-view', UploadSchema, 'output', fileName],
  ['upload-verified', UploadVerifiedSchema, 'output', []],
  ['result-view', ResultSchema, 'output', fileName],
  ['result-page', ResultPageSchema, 'output', fileName],
  ['module-instance-view', ModuleInstanceViewSchema, 'output', []],
  ['module-instance-page', ModuleInstancePageSchema, 'output', []],
  ['manual-work-binding', ManualWorkBindingSchema, 'output', []],
  ['launchpad-context', LaunchpadContextSchema, 'output', workText],
  ['instance-candidate', InstanceCandidateSchema, 'output', []],
];

const bundles: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, z.ZodType, 'input' | 'output', readonly string[]]>]> = [
  ['hosted-checkout', 'Public hosted checkout and payment handoff. Shape validation grants no payment, email or deployment authority.', [
    ['shipping-method-ref', checkout.ShippingMethodRefSchema, 'output', []],
    ['delivery-field-error-code', checkout.DeliveryFieldErrorCodeSchema, 'output', []],
    ['shipping-unavailable-reason', checkout.ShippingUnavailableReasonSchema, 'output', []],
    ['checkout-shipping', checkout.CheckoutShippingSchema, 'output', ['frozen_delivery_terms']],
    ['cart-quote-input', checkout.CartQuoteInputSchema, 'input', ['unique_skus_current_publication_prices']],
    ['cart-quote', checkout.CartQuoteResponseSchema, 'output', ['read_only_availability']],
    ['checkout-input', checkout.CheckoutInputSchema, 'input', ['exact_policy_set_structural_json_bounds']],
    ['checkout', checkout.CheckoutResponseSchema, 'output', ['absolute_expiry']],
    ['placement-input', checkout.PlaceOrderInputSchema, 'input', ['checkout_device_grant']],
    ['placement', checkout.PlaceOrderResponseSchema, 'output', ['first_buyer_replay']],
    ['payment-handoff-input', checkout.PaymentHandoffInputSchema, 'input', ['current_buyer_access']],
    ['payment-handoff', checkout.PaymentHandoffResponseSchema, 'output', ['single_use_handoff_token']],
    ['payment-query-input', checkout.PaymentQueryInputSchema, 'input', ['current_buyer_access','shared_order_query_budget']],
    ['payment-query', checkout.PaymentQueryResponseSchema, 'output', ['store_and_current_access']],
    ['order', checkout.PublicOrderSchema, 'output', ['store_and_current_access']],
    ['redeem-input', checkout.RedeemAccessInputSchema, 'input', ['single_use_link']],
    ['access-request-input', checkout.AccessRequestInputSchema, 'input', ['uniform_accepted_response']],
    ['forget-input', checkout.ForgetAccessInputSchema, 'input', []],
    ['error', checkout.CheckoutErrorSchema, 'output', []],
  ]],
  ['hosted-supply-catalog', 'Private supplier preparation without retail activation; existing inventory and consent authority.', [
    ['setup', supplyCatalog.SupplyCatalogSetupInputSchema, 'input', []],
    ['setup-receipt', supplyCatalog.SupplyCatalogReceiptSchema, 'output', ['stable_metadata_only_command_receipt']],
    ['product-receipt', supplyCatalog.SupplyProductReceiptSchema, 'output', ['stable_metadata_only_command_receipt']],
    ['view', supplyCatalog.SupplyCatalogViewSchema, 'output', ['current_tenant_instance_capabilities']],
    ['product-create', supplyCatalog.SupplyProductInputSchema, 'input', []],
    ['product-update', supplyCatalog.SupplyProductUpdateInputSchema, 'input', ['at_least_one_field']],
    ['product', supplyCatalog.SupplyProductViewSchema, 'output', ['store_write_required_for_cost']],
    ['products', supplyCatalog.SupplyProductPageSchema, 'output', ['store_write_required_for_cost']],
  ]],
  ['hosted-distribution', 'Explicit supplier offer and exact seller listing consent. One supplier item; no payment authority.', [
    ['offer', distribution.SupplyOfferSchema, 'output', ['explicit_supplier_publication']],
    ['offers', distribution.SupplyOffersSchema, 'output', ['bounded_catalog']],
    ['proposal', distribution.DistributionInputSchema, 'input', ['exact_offer_digest']],
    ['decision', distribution.DistributionDecisionSchema, 'input', ['exact_listing_digest_and_version']],
    ['selection', distribution.DistributionSchema, 'output', ['independent_seller_price']],
    ['selections', distribution.DistributionsSchema, 'output', ['private_participant_projection']],
  ]],
  ['hosted-supply-terms', 'Private supplier terms on the existing inventory item. No supply offer, acceptance or transaction is enabled.', [
    ['input', supplyTerms.SupplyTermsInputSchema, 'input', ['current_same_instance_store_write_capability', 'product_version_cas']],
    ['view', supplyTerms.SupplyTermsSchema, 'output', ['available_equals_stock_minus_reserved', 'private_cost_and_terms']],
  ]],
  ['supplier-console', 'Private supplier console read projections over the existing hosted supply authority. Commands stay on the existing routes, keys and versions; no payment, revenue or commission fact.', [
    ['overview', supplierConsole.SupplierOverviewSchema, 'output', ['single_statement_snapshot', 'store_write_required_for_counts', 'owner_required_for_reservation_lines', 'unavailable_is_not_zero']],
    ['products', supplierConsole.SupplierProductsSchema, 'output', ['complete_bounded_catalog', 'available_equals_stock_minus_reserved', 'private_cost_and_terms']],
    ['product', supplierConsole.SupplierProductDetailSchema, 'output', ['private_cost_and_terms', 'impact_preview_is_not_authority']],
    ['request', supplierConsole.SupplierRequestDetailSchema, 'output', ['single_statement_snapshot', 'supplier_relationship_only', 'current_selection_version_and_digest']],
    ['partners', supplierConsole.SupplierPartnersSchema, 'output', ['stable_seller_shop_id', 'supplier_relationship_only']],
    ['partner', supplierConsole.SupplierPartnerDetailSchema, 'output', ['stable_seller_shop_id', 'supplier_relationship_only']],
    ['profile-update', supplierConsole.SupplyProfileUpdateInputSchema, 'input', ['at_least_one_field', 'supply_only_profile', 'profile_version_cas']],
    ['profile-receipt', supplierConsole.SupplyProfileReceiptSchema, 'output', ['stable_metadata_only_command_receipt']],
    ['reservation-query', supplierConsole.SupplierReservationQuerySchema, 'input', ['half_open_created_at_window', 'filter_bound_signed_cursor']],
    ['reservations', supplierConsole.SupplierReservationsSchema, 'output', ['current_owner_only', 'state_decided_at_as_of', 'totals_share_page_snapshot', 'supply_amount_is_not_revenue']],
    ['reservation', supplierConsole.SupplierReservationDetailSchema, 'output', ['current_owner_only', 'state_decided_at_as_of', 'supplier_lines_only']],
    ['changes-query', supplierConsole.SupplierChangesQuerySchema, 'input', []],
    ['changes', supplierConsole.SupplierChangesSchema, 'output', ['own_tenant_journal_only', 'ids_and_versions_only', 'bounded_newest_first']],
    ['summary', supplierConsole.SupplierSummarySchema, 'output', ['one_business_per_read', 'store_write_required_for_counts', 'unavailable_is_not_zero']],
    ['report-query', supplierConsole.SupplierReportQuerySchema, 'input', ['taipei_calendar_days', 'inclusive_max_366_days']],
    ['report', supplierConsole.SupplierReportSchema, 'output', ['one_statement_at_as_of', 'store_write_required', 'reservations_owner_only', 'supply_amount_is_not_revenue', 'refused_above_max_csv_rows', 'not_a_data_export']],
    ['materials', supplierConsole.SupplyMaterialsSchema, 'output', ['store_write_required', 'own_business_only', 'shared_retained_space_not_zero_when_unavailable']],
    ['material', supplierConsole.SupplyMaterialDetailSchema, 'output', ['store_write_required', 'immutable_versions', 'grant_history_retained']],
    ['material-create', supplierConsole.SupplyMaterialCreateInputSchema, 'input', ['own_product_or_brand', 'idempotency_key']],
    ['material-update', supplierConsole.SupplyMaterialUpdateInputSchema, 'input', ['at_least_one_field', 'material_version_cas']],
    ['material-copy', supplierConsole.SupplyMaterialCopyInputSchema, 'input', ['copy_kind_only', 'material_version_cas']],
    ['material-access', supplierConsole.SupplyMaterialAccessInputSchema, 'input', ['public_use_needs_confirmation', 'material_version_cas']],
    ['material-grant', supplierConsole.SupplyMaterialGrantInputSchema, 'input', ['current_cooperation_only', 'one_row_per_shop_now', 'material_version_cas']],
    ['material-empty', supplierConsole.SupplyMaterialEmptyInputSchema, 'input', ['material_version_cas']],
    ['material-receipt', supplierConsole.SupplyMaterialReceiptSchema, 'output', ['stable_metadata_only_command_receipt']],
    ['partner-materials', supplierConsole.PartnerMaterialsSchema, 'output', ['own_storefront_store_read', 'active_grant_and_current_cooperation', 'current_version_only', 'no_storage_locator']],
    ['distribution-photos', supplierConsole.DistributionPhotosSchema, 'output', ['seller_owned_copy', 'source_usability_shared_with_publish']],
    ['distribution-photo-use', supplierConsole.DistributionPhotoUseInputSchema, 'input', ['current_public_use_image', 'exact_storefront_grant', 'pointer_version_cas']],
    ['distribution-photo-command', supplierConsole.DistributionPhotoCommandSchema, 'output', ['stable_receipt', 'seller_owned_copy']],
  ]],
  ['tenant-work', TENANT_WORK_DESCRIPTION, tenantWorkDocuments],
  ['hosted-shipping', 'Immutable hosted shipping settings. Identity, ownership, capability, availability and version checks remain server authority.', [
    ['logistics-service-key', shipping.LogisticsServiceKeySchema, 'output', []],
    ['delivery-method', shipping.DeliveryMethodSchema, 'output', []],
    ['logistics-delivery-method', shipping.LogisticsDeliveryMethodSchema, 'output', []],
    ['meetup-delivery-option', shipping.MeetupDeliveryOptionSchema, 'output', []],
    ['checkout-delivery-input', shipping.CheckoutDeliveryInputSchema, 'output', []],
    ['cart-delivery-input', shipping.CartDeliveryInputSchema, 'output', []],
    ['shipping-empty-input', shipping.ShippingEmptyInputSchema, 'output', []],
    ['ship-from-location-input', shipping.ShipFromLocationInputSchema, 'output', []],
    ['ship-from-location', shipping.ShipFromLocationSchema, 'output', []],
    ['ship-from-location-page', shipping.ShipFromLocationPageSchema, 'output', []],
    ['ship-from-location-retire-input', shipping.ShipFromLocationRetireInputSchema, 'output', []],
    ['parcel-limits', shipping.ParcelLimitsSchema, 'output', []],
    ['profile-service', shipping.ProfileServiceSchema, 'output', []],
    ['delivery-option', shipping.DeliveryOptionSchema, 'output', []],
    ['drop-ship-fee', shipping.DropShipFeeSchema, 'output', []],
    ['drop-ship', shipping.DropShipSchema, 'output', []],
    ['shipping-profile-document', shipping.ShippingProfileDocumentSchema, 'output', []],
    ['shipping-profile-input', shipping.ShippingProfileInputSchema, 'output', []],
    ['logistics-availability', shipping.LogisticsAvailabilitySchema, 'output', []],
    ['shipping-profile-view', shipping.ShippingProfileViewSchema, 'output', []],
    ['item-shipping-attributes-input', shipping.ItemShippingAttributesInputSchema, 'output', []],
    ['item-shipping-attributes', shipping.ItemShippingAttributesSchema, 'output', []],
    ['shipping-field-error-code', shipping.ShippingFieldErrorCodeSchema, 'output', []],
    ['shipping-field-error', shipping.ShippingFieldErrorSchema, 'output', []],
    ['shipping-error-code', shipping.ShippingErrorCodeSchema, 'output', []],
    ['shipping-error', shipping.ShippingErrorSchema, 'output', []],
  ]],
  ['hosted-store-media', 'Independent hosted store media candidate. No upload or read route is installed; Asset identity and current authorization stay server-only.', [
    ['product-media', hostedMedia.ProductMediaViewSchema, 'output', ['exact_product_version_path', 'current_same_instance_store_read', 'authorized_ready_photo_representation']],
    ['product-media-page', hostedMedia.ProductMediaPageSchema, 'output', ['unique_product_ids', 'current_same_instance_store_read']],
    ['product-media-command', hostedMedia.ProductMediaCommandSchema, 'output', ['same_product_identity', 'original_completed_version', 'current_version_not_older_than_completion', 'current_same_instance_store_write']],
    ['public-store-media', hostedMedia.PublicStoreMediaSchema, 'output', ['unique_skus', 'exact_publication_revision_sku_path', 'current_publication_liveness', 'immutable_media_digest']],
    ['remove-photo-input', hostedMedia.RemoveProductPhotoInputSchema, 'input', ['current_same_instance_store_write', 'product_selection_version_cas']],
  ]],
  ['storefront-presentation', 'Additive saved store presentation. Existing storefront/v1 content, releases and capabilities remain unchanged.', [
    ['appearance-input', presentation.StoreAppearanceInputSchema, 'input', []],
    ['appearance', presentation.StoreAppearanceSchema, 'output', ['current_same_instance_store_capability', 'profile_version_cas']],
  ]],
  ['hosted-shared-order', 'Explicit same-database shared supplier stock reservations. Original direct profile and financial exclusions remain intact; admission defaults OFF.', [
    ['shared-quote', sharedOrder.SharedQuoteSchema, 'output', ['unique_skus', 'line_and_merchandise_totals', 'five_minute_quote', 'current_exact_supply_consent']],
    ['shared-order', sharedOrder.SharedOrderSchema, 'output', ['unique_skus', 'line_and_merchandise_totals', 'thirty_minute_reservation', 'closure_ordering', 'authoritative_state']],
    ['reservation-page', sharedOrder.ReservationPageSchema, 'output', ['current_party_filter', 'signed_cursor', 'order_semantics']],
    ['reservation-setting-input', sharedOrder.ReservationSettingInputSchema, 'input', ['current_owner_only', 'host_admission_for_enable', 'profile_version_cas']],
    ['reservation-setting', sharedOrder.ReservationSettingSchema, 'output', ['current_owner_only']],
    ['supplier-reservation-page', sharedOrder.SupplierReservationPageSchema, 'output', ['current_supplier_owner', 'own_supplied_lines_only', 'signed_cursor', 'supplied_line_totals']],
  ]],
  ['hosted-order', 'HO-0 direct-sale order reservation candidate. No routes or releases enabled; payment/refund/fulfilment disabled.', [
    ['readiness', hostedOrder.ReadinessSchema, 'output', ['current_readiness_authority']],
    ['quote-input', hostedOrder.QuoteInputSchema, 'input', ['unique_skus']],
    ['quote', hostedOrder.QuoteSchema, 'output', ['unique_skus', 'line_and_merchandise_totals', 'five_minute_quote', 'current_buyer_publication_price_stock_authority']],
    ['submit-input', hostedOrder.SubmitInputSchema, 'input', ['current_buyer_quote_binding', 'same_intent_dedupe']],
    ['cancel-input', hostedOrder.CancelInputSchema, 'input', ['current_order_party', 'current_order_version']],
    ['order', hostedOrder.OrderSchema, 'output', ['unique_skus', 'line_and_merchandise_totals', 'thirty_minute_reservation', 'closure_ordering', 'authoritative_state']],
    ['intent-lookup-query', hostedOrder.IntentLookupQuerySchema, 'input', ['exact_buyer_shop_intent']],
    ['order-page-query', hostedOrder.OrderPageQuerySchema, 'input', ['unique_query_keys', 'signed_cursor']],
    ['order-page', hostedOrder.OrderPageSchema, 'output', ['current_party_filter', 'signed_cursor', 'order_semantics']],
  ]],
  ['hosted-seller-checkout', 'Private checkout orders, payment cases and manual unapplied refund records. Shapes grant no store or finance authority.', [
    ['payment-state', sellerCheckout.SellerPaymentStateSchema, 'output', []],
    ['inventory-state', sellerCheckout.SellerInventoryStateSchema, 'output', []],
    ['customer', sellerCheckout.SellerCustomerSchema, 'output', ['masked_name_and_redaction']],
    ['order-summary', sellerCheckout.SellerCheckoutOrderSummarySchema, 'output', ['current_store_authority','read_time_axes']],
    ['order-page', sellerCheckout.SellerCheckoutOrderPageSchema, 'output', ['signed_cursor_bound_after_authorization']],
    ['order-line', sellerCheckout.SellerOrderLineSchema, 'output', []],
    ['payment-attempt', sellerCheckout.SellerPaymentAttemptSchema, 'output', ['finance_capability','explicit_safe_fields']],
    ['payment-application', sellerCheckout.SellerPaymentApplicationSchema, 'output', ['finance_capability','unapplied_refund_cap']],
    ['refund', sellerCheckout.SellerRefundSchema, 'output', ['calendar_date','reference_only_receipt']],
    ['exception-case', sellerCheckout.ExceptionCaseViewSchema, 'output', ['finance_facts_only_with_capability','current_allowed_actions']],
    ['exception-case-page', sellerCheckout.ExceptionCasePageSchema, 'output', ['signed_cursor_bound_after_authorization']],
    ['order', sellerCheckout.SellerCheckoutOrderSchema, 'output', ['current_store_authority','finance_capability','read_time_axes']],
    ['order-contact', sellerCheckout.SellerOrderContactSchema, 'output', ['customer_capability','principal_budget','current_redaction']],
    ['empty-input', sellerCheckout.SellerCheckoutEmptyInputSchema, 'input', []],
    ['resolve-with-evidence-input', sellerCheckout.ResolveWithEvidenceInputSchema, 'input', ['calendar_date_not_future_in_taipei','kind_code_and_subject_state']],
    ['retry-allocation-input', sellerCheckout.RetryAllocationInputSchema, 'input', ['stock_and_case_version']],
    ['manual-refund-input', sellerCheckout.ManualRefundInputSchema, 'input', ['calendar_date_within_payment_and_today_taipei','settlement_unit_and_cap','negative_zero_forbidden']],
    ['refund-list', sellerCheckout.SellerRefundListSchema, 'output', []],
    ['order-query', sellerCheckout.SellerCheckoutOrderQuerySchema, 'input', ['filter_bound_signed_cursor']],
    ['offline-payment-confirm-input', sellerCheckout.OfflinePaymentConfirmInputSchema, 'input', ['amount_equals_order_total','taipei_calendar_date']],
    ['meetup-completion-input', sellerCheckout.MeetupCompletionInputSchema, 'input', ['amount_equals_order_total','taipei_calendar_date']],
    ['meetup-handover-input', sellerCheckout.MeetupHandoverInputSchema, 'input', ['taipei_calendar_date']],
    ['error-code', sellerCheckout.SellerCheckoutErrorCodeSchema, 'output', []],
  ]],
  ['hosted-offline-payment', 'Offline payment settings. The fresh-auth id is request metadata and is not stored or projected. Shapes grant no payment authority.', [
    ['settings-input', offlinePayment.OfflinePaymentSettingsInputSchema, 'input', ['fresh_auth_request_metadata','field_rules_are_not_structural']],
    ['settings-view', offlinePayment.OfflinePaymentSettingsViewSchema, 'output', ['version_saved_at_settings_together','account_number_null_exactly_for_last4']],
    ['field-error-code', offlinePayment.OfflineSettingsFieldErrorCodeSchema, 'output', []],
    ['field-error', offlinePayment.OfflineSettingsFieldErrorSchema, 'output', []],
    ['error-code', offlinePayment.OfflineSettingsErrorCodeSchema, 'output', []],
    ['error', offlinePayment.OfflineSettingsErrorSchema, 'output', []],
  ]],
  ['hosted-commerce-setup', 'Commerce release, account setup and controlled payment service verification. Shape validation grants no authority.', [
    ['empty-input', commerceSetup.CommerceSetupEmptyInputSchema, 'input', []],
    ['store-release', commerceSetup.StoreReleaseSchema, 'output', ['current_instance_release_and_authority']],
    ['provider-account-create-input', commerceSetup.ProviderAccountCreateInputSchema, 'input', ['fresh_auth_required','host_provider_environment']],
    ['provider-service-put-input', commerceSetup.ProviderServicePutInputSchema, 'input', ['purpose_profile_pair','credential_fields_never_persisted']],
    ['logistics-service-create-input', commerceSetup.LogisticsServiceCreateInputSchema, 'input', ['fresh_auth_required','account_version_cas']],
    ['provider-service-state-input', commerceSetup.ProviderServiceStateInputSchema, 'input', ['fresh_auth_required']],
    ['payment-activation', commerceSetup.PaymentActivationSchema, 'output', []],
    ['provider-activation-payment-input', commerceSetup.ProviderActivationPaymentInputSchema, 'input', ['fresh_auth_required','account_version_cas']],
    ['provider-activation-payment', commerceSetup.ProviderActivationPaymentResponseSchema, 'output', ['bearer_token_excluded_from_command_receipt']],
    ['provider-account', commerceSetup.ProviderAccountViewSchema, 'output', []],
    ['provider-account-page', commerceSetup.ProviderAccountPageSchema, 'output', []],
    ['store-admission-create-input', commerceSetup.StoreAdmissionCreateInputSchema, 'input', ['independent_active_platform_admin']],
    ['store-admission-revoke-input', commerceSetup.StoreAdmissionRevokeInputSchema, 'input', ['independent_active_platform_admin']],
    ['store-admission-query', commerceSetup.StoreAdmissionQuerySchema, 'input', []],
    ['store-admission', commerceSetup.StoreAdmissionViewSchema, 'output', []],
    ['store-admission-page', commerceSetup.StoreAdmissionPageSchema, 'output', []],
    ['error-code', commerceSetup.CommerceSetupErrorCodeSchema, 'output', []],
    ['error', commerceSetup.CommerceSetupErrorSchema, 'output', []],
  ]],
  ['storefront', 'Hosted store inputs, private views and allowlisted public projection. Ordering is not enabled.', [
    ['store-setup-input', storefront.StoreSetupInputSchema, 'input', ['text_trim_and_control_characters', 'slug_lowercase_reserved_unique']],
    ['store-update-input', storefront.StoreUpdateInputSchema, 'input', ['at_least_one_field', 'text_trim_and_control_characters']],
    ['product-input', storefront.ProductInputSchema, 'input', ['text_trim_and_control_characters']],
    ['product-update-input', storefront.ProductUpdateInputSchema, 'input', ['at_least_one_field', 'text_trim_and_control_characters']],
    ['empty-input', storefront.EmptyStoreInputSchema, 'input', []],
    ['slug-query', storefront.SlugQuerySchema, 'input', []],
    ['slug-availability', storefront.SlugAvailabilitySchema, 'output', []],
    ['store-view', storefront.StoreViewSchema, 'output', []],
    ['product-view', storefront.ProductViewSchema, 'output', []],
    ['product-page', storefront.ProductPageSchema, 'output', []],
    ['product-removed', storefront.ProductRemovedSchema, 'output', []],
    ['my-stores', storefront.MyStoresSchema, 'output', []],
    ['public-store-projection', storefront.PublicStoreProjectionSchema, 'output', []],
    ['store-preview', storefront.StorePreviewSchema, 'output', []],
  ]],
];

function inlineDef(name: string, schema: z.ZodType, io: 'input' | 'output', rules: readonly string[]) {
  const input = z.toJSONSchema(schema, { io: 'input' });
  const output = z.toJSONSchema(schema, { io: 'output' });
  if (JSON.stringify(input) !== JSON.stringify(output)) throw new Error(`${name} input and output JSON Schemas differ.`);
  const generated = { ...z.toJSONSchema(schema, { io }) } as Record<string, unknown>;
  if (JSON.stringify(generated).includes('"$ref"') || JSON.stringify(generated).includes('"$defs"')) {
    throw new Error(`${name} JSON Schema contains $ref or $defs; refusing to rewrite references.`);
  }
  delete generated.$schema;
  if (Object.prototype.hasOwnProperty.call(generated, '$id')) throw new Error(`${name} def carries $id`);
  generated.description = description(rules);
  return generated;
}

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema, io, rules] of documents) {
  const input = z.toJSONSchema(schema, { io: 'input' });
  const output = z.toJSONSchema(schema, { io: 'output' });
  if (JSON.stringify(input) !== JSON.stringify(output)) throw new Error(`${name} input and output JSON Schemas differ.`);
  const path = new URL(`../../contracts/guild-launchpad/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema, { io }), $id: `https://freetwai.com/contracts/guild-launchpad/v1/${name}`, description: description(rules) }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
for (const [bundleName, bundleDescription, defs] of bundles) {
  const seen = new Set<string>();
  const $defs: Record<string, unknown> = {};
  for (const [name, schema, io, rules] of defs) {
    if (seen.has(name)) throw new Error(`duplicate ${bundleName} def ${name}`);
    seen.add(name);
    $defs[name] = inlineDef(name, schema, io, rules);
  }
  const path = new URL(`../../contracts/guild-launchpad/v1/${bundleName}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://freetwai.com/contracts/guild-launchpad/v1/${bundleName}`,
    description: bundleDescription,
    $defs,
  }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${bundleName} bundle is stale.`);
  } else await writeFile(path, bytes);
}
const assemblyPath = new URL('../../contracts/guild-launchpad/v2/launchpad-config.schema.json', import.meta.url);
const assemblyBytes = JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://freetwai.com/contracts/guild-launchpad/v2/launchpad-config',
  ...inlineDef('launchpad-config/v2', assemblySchema, 'input', ['guild_key_match', 'content_and_url_bounds', 'unique_block_ids_orders_and_builtin_kinds', 'reviewed_block_versions', 'application_duplicate', 'canonical_size_limit']),
}, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(assemblyPath, 'utf8') !== assemblyBytes) throw new Error('Generated v2 launchpad config schema is stale.');
} else await writeFile(assemblyPath, assemblyBytes);
console.log(`${documents.length} v1 guild launchpad schemas, ${bundles.length} bundles and one v2 assembly schema checked/generated. Structural shapes only; no identity, membership, capability, version, or quota authority.`);
