export { FulfilmentRuleError } from './errors.js';

export {
  SERVICE_KEYS,
  DELIVERY_METHODS,
  UNAVAILABLE_REASONS,
  TEMPERATURES,
  CVS_PARCEL_VALUE_MAX_MINOR,
  POST_MAX_WEIGHT_G,
  methodOfService,
  logisticsSubTypeOfService,
  type ServiceKey,
  type DeliveryMethod,
  type UnavailableReason,
  type Temperature,
  type LogisticsSubType,
  type ItemShippingAttributes,
  type ParcelLimits,
  type ProfileService,
  type ShippingProfile,
  type DeliveryOption,
  type QuoteLineFulfilment,
  type QuoteLine,
  type PlanInput,
  type DeliveryParcelLine,
  type DeliveryParcel,
  type DeliveryGroup,
  type PlanDeliveryResult,
  type AvailableMethodOption,
} from './types.js';

export {
  POSTAL_SOURCE,
  isKnownPostalPrefix,
  isOutlyingPostalPrefix,
} from './postal.js';

export {
  validateRecipientName,
  normalizeMobile,
  validatePostalCode,
  validateHomeRecipient,
  validateCvsRecipient,
  normalizeCvsStoreSelection,
  type RecipientValidationCode,
  type RecipientValidationError,
  type FieldValidationResult,
  type HomeRecipient,
  type CvsRecipient,
  type NormalizedCvsStore,
  type HomeRecipientResult,
  type CvsRecipientResult,
  type CvsStoreSelectionResult,
} from './recipient.js';

export {
  computeShipBy,
  type ShipByOptions,
} from './ship-by.js';

export {
  planDelivery,
  availableMethods,
} from './plan.js';

export {
  SHIPMENT_STATE_ORDER,
  ALL_SHIPMENT_STATES,
  VALID_INCOMING_STATES,
  mapLogisticsStatus,
  applyTrackingState,
  applyLogisticsEvent,
  type ShipmentState,
  type TrackingExceptionKind,
  type LogisticsStatusResult,
  type TrackingStateChange,
  type ApplyTrackingResult,
  type LogisticsEventInput,
  type LogisticsEventOutcome,
} from './tracking.js';
