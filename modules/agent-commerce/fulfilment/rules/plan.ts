import { FulfilmentRuleError, deepFreeze } from './errors.js';
import {
  CVS_PARCEL_VALUE_MAX_MINOR,
  DELIVERY_METHODS,
  POST_MAX_WEIGHT_G,
  SERVICE_KEYS,
  TEMPERATURES,
  logisticsSubTypeOfService,
  methodOfService,
  type AvailableMethodOption,
  type DeliveryGroup,
  type DeliveryMethod,
  type DeliveryOption,
  type DeliveryParcel,
  type DeliveryParcelLine,
  type ItemShippingAttributes,
  type PlanDeliveryResult,
  type PlanInput,
  type ProfileService,
  type QuoteLine,
  type ServiceKey,
  type ShippingProfile,
  type UnavailableReason,
} from './types.js';

function effectiveMaxWeight(service: ProfileService): number {
  return service.service_key === 'ecpay.logistics.home.post'
    ? Math.min(service.limits.max_weight_g, POST_MAX_WEIGHT_G)
    : service.limits.max_weight_g;
}

function validatePlanInput(input: PlanInput, method?: DeliveryMethod): void {
  if (method !== undefined) {
    if (!DELIVERY_METHODS.includes(method)) {
      throw new FulfilmentRuleError();
    }
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new FulfilmentRuleError();
  }

  if (
    typeof input.seller_shop_id !== 'string' ||
    input.seller_shop_id.length === 0 ||
    input.seller_shop_id.length > 80
  ) {
    throw new FulfilmentRuleError();
  }

  if (!Array.isArray(input.delivery_options) || input.delivery_options.length > 10) {
    throw new FulfilmentRuleError();
  }

  const optionMethods = new Set<DeliveryMethod>();
  for (const opt of input.delivery_options) {
    if (typeof opt !== 'object' || opt === null) {
      throw new FulfilmentRuleError();
    }
    if (!DELIVERY_METHODS.includes(opt.method)) {
      throw new FulfilmentRuleError();
    }
    if (optionMethods.has(opt.method)) {
      throw new FulfilmentRuleError();
    }
    optionMethods.add(opt.method);

    if (
      typeof opt.fee_per_parcel_minor !== 'number' ||
      !Number.isSafeInteger(opt.fee_per_parcel_minor) ||
      opt.fee_per_parcel_minor < 0 ||
      opt.fee_per_parcel_minor % 100 !== 0 ||
      Object.is(opt.fee_per_parcel_minor, -0)
    ) {
      throw new FulfilmentRuleError();
    }

    if (opt.free_over_minor !== null) {
      if (
        typeof opt.free_over_minor !== 'number' ||
        !Number.isSafeInteger(opt.free_over_minor) ||
        opt.free_over_minor <= 0 ||
        opt.free_over_minor % 100 !== 0
      ) {
        throw new FulfilmentRuleError();
      }
    }

    if (typeof opt.outlying !== 'object' || opt.outlying === null) {
      throw new FulfilmentRuleError();
    }
    if (opt.outlying.kind === 'excluded') {
      // valid
    } else if (opt.outlying.kind === 'surcharge') {
      if (
        typeof opt.outlying.surcharge_per_parcel_minor !== 'number' ||
        !Number.isSafeInteger(opt.outlying.surcharge_per_parcel_minor) ||
        opt.outlying.surcharge_per_parcel_minor < 0 ||
        opt.outlying.surcharge_per_parcel_minor % 100 !== 0 ||
        Object.is(opt.outlying.surcharge_per_parcel_minor, -0)
      ) {
        throw new FulfilmentRuleError();
      }
    } else {
      throw new FulfilmentRuleError();
    }
  }

  if (typeof input.profiles !== 'object' || input.profiles === null || Array.isArray(input.profiles)) {
    throw new FulfilmentRuleError();
  }

  for (const [key, profile] of Object.entries(input.profiles)) {
    if (typeof profile !== 'object' || profile === null) {
      throw new FulfilmentRuleError();
    }
    if (profile.shop_id !== key) {
      throw new FulfilmentRuleError();
    }
    if (typeof profile.shop_id !== 'string' || profile.shop_id.length === 0 || profile.shop_id.length > 80) {
      throw new FulfilmentRuleError();
    }
    if (typeof profile.version !== 'string' || profile.version.length === 0 || profile.version.length > 80) {
      throw new FulfilmentRuleError();
    }
    if (
      !Array.isArray(profile.working_days) ||
      profile.working_days.length === 0 ||
      profile.working_days.length > 7
    ) {
      throw new FulfilmentRuleError();
    }
    const daysSet = new Set<number>();
    for (const day of profile.working_days) {
      if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 1 || day > 7 || daysSet.has(day)) {
        throw new FulfilmentRuleError();
      }
      daysSet.add(day);
    }

    if (!Array.isArray(profile.services)) {
      throw new FulfilmentRuleError();
    }
    const serviceKeySet = new Set<ServiceKey>();
    for (const service of profile.services) {
      if (typeof service !== 'object' || service === null) {
        throw new FulfilmentRuleError();
      }
      if (!SERVICE_KEYS.includes(service.service_key) || serviceKeySet.has(service.service_key)) {
        throw new FulfilmentRuleError();
      }
      serviceKeySet.add(service.service_key);

      if (
        typeof service.ship_from_location_id !== 'string' ||
        service.ship_from_location_id.length === 0 ||
        service.ship_from_location_id.length > 80
      ) {
        throw new FulfilmentRuleError();
      }
      if (service.temperature !== 'ambient') {
        throw new FulfilmentRuleError();
      }
      if (
        typeof service.handling_days !== 'number' ||
        !Number.isSafeInteger(service.handling_days) ||
        service.handling_days < 1 ||
        service.handling_days > 14
      ) {
        throw new FulfilmentRuleError();
      }
      if (
        typeof service.cutoff_time !== 'string' ||
        !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(service.cutoff_time)
      ) {
        throw new FulfilmentRuleError();
      }
      if (typeof service.limits !== 'object' || service.limits === null) {
        throw new FulfilmentRuleError();
      }
      for (const field of ['max_weight_g', 'max_longest_side_mm', 'max_dimension_sum_mm'] as const) {
        const val = service.limits[field];
        if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1) {
          throw new FulfilmentRuleError();
        }
      }
      if (service.outlying_islands !== 'allowed' && service.outlying_islands !== 'excluded') {
        throw new FulfilmentRuleError();
      }
    }
  }

  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) {
    throw new FulfilmentRuleError();
  }

  const lineRefs = new Set<string>();
  const agreements = new Map<
    string,
    { executor_shop_id: string; agreement_version: string; service_keys: Set<ServiceKey> }
  >();

  for (const line of input.lines) {
    if (typeof line !== 'object' || line === null) {
      throw new FulfilmentRuleError();
    }
    if (typeof line.line_ref !== 'string' || line.line_ref.length === 0 || line.line_ref.length > 80) {
      throw new FulfilmentRuleError();
    }
    if (lineRefs.has(line.line_ref)) {
      throw new FulfilmentRuleError();
    }
    lineRefs.add(line.line_ref);

    if (
      typeof line.quantity !== 'number' ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 99
    ) {
      throw new FulfilmentRuleError();
    }

    if (
      typeof line.unit_price_minor !== 'number' ||
      !Number.isSafeInteger(line.unit_price_minor) ||
      line.unit_price_minor < 0 ||
      Object.is(line.unit_price_minor, -0)
    ) {
      throw new FulfilmentRuleError();
    }

    if (line.attributes !== null) {
      if (typeof line.attributes !== 'object') {
        throw new FulfilmentRuleError();
      }
      if (
        typeof line.attributes.weight_g !== 'number' ||
        !Number.isSafeInteger(line.attributes.weight_g) ||
        line.attributes.weight_g < 1 ||
        line.attributes.weight_g > 1_000_000
      ) {
        throw new FulfilmentRuleError();
      }
      for (const dim of ['length_mm', 'width_mm', 'height_mm'] as const) {
        const val = line.attributes[dim];
        if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1 || val > 10_000) {
          throw new FulfilmentRuleError();
        }
      }
      if (!TEMPERATURES.includes(line.attributes.temperature)) {
        throw new FulfilmentRuleError();
      }
      if (typeof line.attributes.cvs_allowed !== 'boolean') {
        throw new FulfilmentRuleError();
      }
      if (typeof line.attributes.ship_alone !== 'boolean') {
        throw new FulfilmentRuleError();
      }
      if (line.attributes.max_per_parcel !== null) {
        if (
          typeof line.attributes.max_per_parcel !== 'number' ||
          !Number.isSafeInteger(line.attributes.max_per_parcel) ||
          line.attributes.max_per_parcel < 1 ||
          line.attributes.max_per_parcel > 999
        ) {
          throw new FulfilmentRuleError();
        }
      }
    }

    if (typeof line.fulfilment !== 'object' || line.fulfilment === null) {
      throw new FulfilmentRuleError();
    }

    if (line.fulfilment.kind === 'self') {
      // valid
    } else if (line.fulfilment.kind === 'not_agreed') {
      // valid
    } else if (line.fulfilment.kind === 'drop_ship') {
      const ds = line.fulfilment;
      if (
        typeof ds.executor_shop_id !== 'string' ||
        ds.executor_shop_id.length === 0 ||
        ds.executor_shop_id.length > 80
      ) {
        throw new FulfilmentRuleError();
      }
      if (ds.executor_shop_id === input.seller_shop_id) {
        throw new FulfilmentRuleError();
      }
      if (
        typeof ds.agreement_id !== 'string' ||
        ds.agreement_id.length === 0 ||
        ds.agreement_id.length > 80
      ) {
        throw new FulfilmentRuleError();
      }
      if (
        typeof ds.agreement_version !== 'string' ||
        ds.agreement_version.length === 0 ||
        ds.agreement_version.length > 80
      ) {
        throw new FulfilmentRuleError();
      }
      if (!Array.isArray(ds.service_keys) || ds.service_keys.length === 0) {
        throw new FulfilmentRuleError();
      }
      const sKeySet = new Set<ServiceKey>();
      for (const sk of ds.service_keys) {
        if (!SERVICE_KEYS.includes(sk) || sKeySet.has(sk)) {
          throw new FulfilmentRuleError();
        }
        sKeySet.add(sk);
      }

      if (agreements.has(ds.agreement_id)) {
        const existing = agreements.get(ds.agreement_id)!;
        if (
          existing.executor_shop_id !== ds.executor_shop_id ||
          existing.agreement_version !== ds.agreement_version ||
          existing.service_keys.size !== sKeySet.size ||
          ![...sKeySet].every(k => existing.service_keys.has(k))
        ) {
          throw new FulfilmentRuleError();
        }
      } else {
        agreements.set(ds.agreement_id, {
          executor_shop_id: ds.executor_shop_id,
          agreement_version: ds.agreement_version,
          service_keys: sKeySet,
        });
      }
    } else {
      throw new FulfilmentRuleError();
    }
  }

  if (
    typeof input.merchandise_net_minor !== 'number' ||
    !Number.isSafeInteger(input.merchandise_net_minor) ||
    input.merchandise_net_minor < 0 ||
    Object.is(input.merchandise_net_minor, -0)
  ) {
    throw new FulfilmentRuleError();
  }

  if (
    typeof input.destination !== 'object' ||
    input.destination === null ||
    typeof input.destination.outlying !== 'boolean'
  ) {
    throw new FulfilmentRuleError();
  }
}

interface EvaluatedLine {
  readonly line: QuoteLine;
  readonly executor_shop_id: string;
  readonly agreement_id: string | null;
  readonly agreement_version: string | null;
  readonly fulfilment_mode: 'self' | 'drop_ship';
  readonly eligible_services: readonly ProfileService[];
}

export function planDelivery(input: PlanInput, method: DeliveryMethod): PlanDeliveryResult {
  validatePlanInput(input, method);

  const option = input.delivery_options.find(o => o.method === method);
  const failingLines: { line_ref: string; reason: UnavailableReason }[] = [];
  const evaluatedLines: EvaluatedLine[] = [];

  // Step 1 — per-line eligibility
  for (const line of input.lines) {
    let failureReason: UnavailableReason | null = null;

    if (line.fulfilment.kind === 'not_agreed') {
      failureReason = 'fulfilment_not_agreed';
    } else if (line.attributes === null) {
      failureReason = 'shipping_attributes_missing';
    } else if (!option) {
      failureReason = 'method_unsupported';
    } else {
      const executorShopId =
        line.fulfilment.kind === 'self' ? input.seller_shop_id : line.fulfilment.executor_shop_id;
      const profile = input.profiles[executorShopId];

      if (!profile) {
        failureReason = 'method_unsupported';
      } else {
        let candidates = profile.services.filter(service => {
          if (methodOfService(service.service_key) !== method) {
            return false;
          }
          if (line.fulfilment.kind === 'drop_ship') {
            return line.fulfilment.service_keys.includes(service.service_key);
          }
          return true;
        });

        if (candidates.length === 0) {
          failureReason = 'method_unsupported';
        } else if (method.startsWith('cvs:') && line.attributes.cvs_allowed === false) {
          failureReason = 'method_unsupported';
        } else {
          candidates = candidates.filter(s => s.temperature === line.attributes!.temperature);
          if (candidates.length === 0) {
            failureReason = 'temperature_unsupported';
          } else {
            const attr = line.attributes;
            candidates = candidates.filter(s => {
              const maxWeight = effectiveMaxWeight(s);
              const longest = Math.max(attr.length_mm, attr.width_mm, attr.height_mm);
              const sum = attr.length_mm + attr.width_mm + attr.height_mm;
              return (
                attr.weight_g <= maxWeight &&
                longest <= s.limits.max_longest_side_mm &&
                sum <= s.limits.max_dimension_sum_mm
              );
            });

            if (candidates.length === 0) {
              failureReason = 'too_large';
            } else if (method.startsWith('cvs:') && line.unit_price_minor > CVS_PARCEL_VALUE_MAX_MINOR) {
              failureReason = 'cvs_value_limit';
            } else if (input.destination.outlying === true) {
              if (option.outlying.kind === 'excluded') {
                failureReason = 'outlying_unsupported';
              } else {
                candidates = candidates.filter(
                  s =>
                    s.outlying_islands === 'allowed' &&
                    s.service_key !== 'ecpay.logistics.home.post',
                );
                if (candidates.length === 0) {
                  failureReason = 'outlying_unsupported';
                }
              }
            }
          }
        }

        if (!failureReason) {
          evaluatedLines.push({
            line,
            executor_shop_id: executorShopId,
            agreement_id: line.fulfilment.kind === 'drop_ship' ? line.fulfilment.agreement_id : null,
            agreement_version:
              line.fulfilment.kind === 'drop_ship' ? line.fulfilment.agreement_version : null,
            fulfilment_mode: line.fulfilment.kind === 'self' ? 'self' : 'drop_ship',
            eligible_services: candidates,
          });
        }
      }
    }

    if (failureReason) {
      failingLines.push({ line_ref: line.line_ref, reason: failureReason });
    }
  }

  if (failingLines.length > 0) {
    return deepFreeze({
      kind: 'unavailable',
      method,
      lines: failingLines,
    });
  }

  // Step 2 — service choice
  // Cluster lines by (executor_shop_id, agreement_id or null, attributes.temperature)
  const clusters = new Map<string, EvaluatedLine[]>();
  for (const el of evaluatedLines) {
    const key = `${el.executor_shop_id}::${el.agreement_id ?? 'null'}::${el.line.attributes!.temperature}`;
    const list = clusters.get(key) ?? [];
    list.push(el);
    clusters.set(key, list);
  }

  const chosenServiceByLine = new Map<string, ProfileService>();
  for (const clusterLines of clusters.values()) {
    const executorProfile = input.profiles[clusterLines[0].executor_shop_id];
    // Find the first service in executor profile order eligible for EVERY line of cluster
    let commonService: ProfileService | null = null;
    for (const service of executorProfile.services) {
      const eligibleForEveryLine = clusterLines.every(el =>
        el.eligible_services.some(s => s.service_key === service.service_key),
      );
      if (eligibleForEveryLine) {
        commonService = service;
        break;
      }
    }

    for (const el of clusterLines) {
      if (commonService) {
        chosenServiceByLine.set(el.line.line_ref, commonService);
      } else {
        chosenServiceByLine.set(el.line.line_ref, el.eligible_services[0]);
      }
    }
  }

  // Step 3 — groups
  // Group key = (executor_shop_id, agreement_id or null, ship_from_location_id, temperature, service_key)
  interface GroupAccumulator {
    readonly group_ref: string;
    readonly executor_shop_id: string;
    readonly fulfilment_mode: 'self' | 'drop_ship';
    readonly agreement_id: string | null;
    readonly agreement_version: string | null;
    readonly profile_version: string;
    readonly service: ProfileService;
    readonly working_days: readonly number[];
    readonly lines: EvaluatedLine[];
  }

  const groupsByKey = new Map<string, GroupAccumulator>();
  const groupOrder: GroupAccumulator[] = [];

  for (const el of evaluatedLines) {
    const service = chosenServiceByLine.get(el.line.line_ref)!;
    const groupKey = `${el.executor_shop_id}::${el.agreement_id ?? 'null'}::${service.ship_from_location_id}::${service.temperature}::${service.service_key}`;

    let grp = groupsByKey.get(groupKey);
    if (!grp) {
      const executorProfile = input.profiles[el.executor_shop_id];
      grp = {
        group_ref: `g${groupOrder.length + 1}`,
        executor_shop_id: el.executor_shop_id,
        fulfilment_mode: el.fulfilment_mode,
        agreement_id: el.agreement_id,
        agreement_version: el.agreement_version,
        profile_version: executorProfile.version,
        service,
        working_days: [...executorProfile.working_days],
        lines: [],
      };
      groupsByKey.set(groupKey, grp);
      groupOrder.push(grp);
    }
    grp.lines.push(el);
  }

  // Step 4 — parcels (per group)
  interface ParcelDraft {
    readonly parcel_ref: string;
    readonly is_ship_alone: boolean;
    readonly line_counts: Map<string, number>;
    weight_g: number;
    declared_value_minor: number;
  }

  const lineOrderIndex = new Map(input.lines.map((l, idx) => [l.line_ref, idx]));

  // Step 5 calculation setup
  const isOutlying = input.destination.outlying;
  const isFreeShipping =
    option!.free_over_minor !== null && input.merchandise_net_minor >= option!.free_over_minor;
  const baseFeePerParcel = isFreeShipping ? 0 : option!.fee_per_parcel_minor;
  const outlyingSurchargePerParcel =
    isOutlying && option!.outlying.kind === 'surcharge'
      ? option!.outlying.surcharge_per_parcel_minor
      : 0;

  const finalGroups: DeliveryGroup[] = [];
  let shippingTotalMinor = 0;

  for (const grp of groupOrder) {
    const service = grp.service;
    const maxWeight = effectiveMaxWeight(service);
    const isCvs = method.startsWith('cvs:');
    const parcels: ParcelDraft[] = [];

    for (const el of grp.lines) {
      const attr = el.line.attributes!;
      for (let unit = 0; unit < el.line.quantity; unit++) {
        if (attr.ship_alone) {
          const pRef = `${grp.group_ref}-p${parcels.length + 1}`;
          parcels.push({
            parcel_ref: pRef,
            is_ship_alone: true,
            line_counts: new Map([[el.line.line_ref, 1]]),
            weight_g: attr.weight_g,
            declared_value_minor: el.line.unit_price_minor,
          });
        } else {
          let placed = false;
          for (const p of parcels) {
            if (p.is_ship_alone) continue;
            if (p.weight_g + attr.weight_g > maxWeight) continue;
            if (isCvs && p.declared_value_minor + el.line.unit_price_minor > CVS_PARCEL_VALUE_MAX_MINOR) {
              continue;
            }
            if (attr.max_per_parcel !== null) {
              const currentCount = p.line_counts.get(el.line.line_ref) ?? 0;
              if (currentCount >= attr.max_per_parcel) {
                continue;
              }
            }

            p.line_counts.set(el.line.line_ref, (p.line_counts.get(el.line.line_ref) ?? 0) + 1);
            p.weight_g += attr.weight_g;
            p.declared_value_minor += el.line.unit_price_minor;
            placed = true;
            break;
          }

          if (!placed) {
            const pRef = `${grp.group_ref}-p${parcels.length + 1}`;
            parcels.push({
              parcel_ref: pRef,
              is_ship_alone: false,
              line_counts: new Map([[el.line.line_ref, 1]]),
              weight_g: attr.weight_g,
              declared_value_minor: el.line.unit_price_minor,
            });
          }
        }
      }
    }

    const deliveryParcels: DeliveryParcel[] = parcels.map(p => {
      const sortedLines: DeliveryParcelLine[] = Array.from(p.line_counts.entries())
        .map(([line_ref, quantity]) => ({ line_ref, quantity }))
        .sort((a, b) => (lineOrderIndex.get(a.line_ref) ?? 0) - (lineOrderIndex.get(b.line_ref) ?? 0));
      return {
        parcel_ref: p.parcel_ref,
        lines: sortedLines,
        weight_g: p.weight_g,
        declared_value_minor: p.declared_value_minor,
      };
    });

    const groupShippingMinor =
      deliveryParcels.length * (baseFeePerParcel + outlyingSurchargePerParcel);
    shippingTotalMinor += groupShippingMinor;

    finalGroups.push({
      group_ref: grp.group_ref,
      executor_shop_id: grp.executor_shop_id,
      fulfilment_mode: grp.fulfilment_mode,
      agreement_id: grp.agreement_id,
      agreement_version: grp.agreement_version,
      profile_version: grp.profile_version,
      service_key: service.service_key,
      logistics_sub_type: logisticsSubTypeOfService(service.service_key),
      ship_from_location_id: service.ship_from_location_id,
      temperature: 'ambient',
      handling_days: service.handling_days,
      cutoff_time: service.cutoff_time,
      working_days: [...grp.working_days],
      parcels: deliveryParcels,
      fee_per_parcel_minor: baseFeePerParcel,
      outlying_surcharge_per_parcel_minor: outlyingSurchargePerParcel,
      shipping_minor: groupShippingMinor,
    });
  }

  return deepFreeze({
    kind: 'plan',
    method,
    groups: finalGroups,
    shipping_total_minor: shippingTotalMinor,
  });
}

export function availableMethods(input: PlanInput): readonly AvailableMethodOption[] {
  validatePlanInput(input);
  const options = input.delivery_options.map(option => ({
    method: option.method,
    result: planDelivery(input, option.method),
  }));
  return deepFreeze(options);
}
