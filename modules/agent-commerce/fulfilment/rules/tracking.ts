import { FulfilmentRuleError, deepFreeze } from './errors.js';

export type ShipmentState =
  | 'draft'
  | 'creating'
  | 'create_unknown'
  | 'create_failed'
  | 'created'
  | 'handed_over'
  | 'in_transit'
  | 'ready_for_pickup'
  | 'delivered'
  | 'returning'
  | 'returned'
  | 'voided';

export const SHIPMENT_STATE_ORDER: Readonly<Record<ShipmentState, number | null>> = Object.freeze({
  draft: 0,
  creating: 1,
  create_unknown: 1,
  create_failed: 1,
  created: 2,
  handed_over: 3,
  in_transit: 4,
  ready_for_pickup: 5,
  delivered: 6,
  returning: 7,
  returned: 8,
  voided: null,
});

export const ALL_SHIPMENT_STATES: readonly ShipmentState[] = Object.freeze([
  'draft',
  'creating',
  'create_unknown',
  'create_failed',
  'created',
  'handed_over',
  'in_transit',
  'ready_for_pickup',
  'delivered',
  'returning',
  'returned',
  'voided',
]);

export const VALID_INCOMING_STATES: readonly ShipmentState[] = Object.freeze([
  'created',
  'handed_over',
  'in_transit',
  'ready_for_pickup',
  'delivered',
  'returning',
  'returned',
]);

const FORWARD_STATES: readonly ShipmentState[] = Object.freeze([
  'created',
  'handed_over',
  'in_transit',
  'ready_for_pickup',
  'delivered',
]);

const RETURN_STATES: readonly ShipmentState[] = Object.freeze(['returning', 'returned']);

export type LogisticsStatusResult =
  | { readonly kind: 'state'; readonly state: ShipmentState; readonly exception: 'uncollected' | null }
  | { readonly kind: 'exception_only'; readonly exception: 'pickup_store_closed' }
  | { readonly kind: 'unmapped' };

/**
 * Maps ECPay logistics RtnCode and subType to domain shipment state/exception.
 * Strictly verified table only. Unknown subType or code returns { kind: 'unmapped' }.
 * Never throws.
 */
export function mapLogisticsStatus(subType: string, rtnCode: string): LogisticsStatusResult {
  if (typeof rtnCode !== 'string' || !/^[0-9]{1,8}$/.test(rtnCode)) {
    return deepFreeze({ kind: 'unmapped' });
  }

  if (typeof subType !== 'string') {
    return deepFreeze({ kind: 'unmapped' });
  }

  const code = rtnCode;
  const st = subType;

  // 300: created for UNIMART, UNIMARTC2C, FAMI, FAMIC2C, HILIFE, HILIFEC2C
  if (code === '300') {
    if (
      st === 'UNIMART' ||
      st === 'UNIMARTC2C' ||
      st === 'FAMI' ||
      st === 'FAMIC2C' ||
      st === 'HILIFE' ||
      st === 'HILIFEC2C'
    ) {
      return deepFreeze({ kind: 'state', state: 'created', exception: null });
    }
  }

  // 2030: in_transit for UNIMART, UNIMARTC2C
  if (code === '2030') {
    if (st === 'UNIMART' || st === 'UNIMARTC2C') {
      return deepFreeze({ kind: 'state', state: 'in_transit', exception: null });
    }
  }

  // 3024: in_transit for FAMI, FAMIC2C, HILIFE, HILIFEC2C
  if (code === '3024') {
    if (st === 'FAMI' || st === 'FAMIC2C' || st === 'HILIFE' || st === 'HILIFEC2C') {
      return deepFreeze({ kind: 'state', state: 'in_transit', exception: null });
    }
  }

  // 2063: ready_for_pickup for UNIMART
  if (code === '2063') {
    if (st === 'UNIMART') {
      return deepFreeze({ kind: 'state', state: 'ready_for_pickup', exception: null });
    }
  }

  // 2073: ready_for_pickup for UNIMARTC2C
  if (code === '2073') {
    if (st === 'UNIMARTC2C') {
      return deepFreeze({ kind: 'state', state: 'ready_for_pickup', exception: null });
    }
  }

  // 3018: ready_for_pickup for FAMI, FAMIC2C, HILIFE, HILIFEC2C
  if (code === '3018') {
    if (st === 'FAMI' || st === 'FAMIC2C' || st === 'HILIFE' || st === 'HILIFEC2C') {
      return deepFreeze({ kind: 'state', state: 'ready_for_pickup', exception: null });
    }
  }

  // 2067: delivered for UNIMART, UNIMARTC2C
  if (code === '2067') {
    if (st === 'UNIMART' || st === 'UNIMARTC2C') {
      return deepFreeze({ kind: 'state', state: 'delivered', exception: null });
    }
  }

  // 3022: delivered for FAMI, FAMIC2C, HILIFE, HILIFEC2C
  if (code === '3022') {
    if (st === 'FAMI' || st === 'FAMIC2C' || st === 'HILIFE' || st === 'HILIFEC2C') {
      return deepFreeze({ kind: 'state', state: 'delivered', exception: null });
    }
  }

  // 2074: returning + uncollected for UNIMART, UNIMARTC2C
  if (code === '2074') {
    if (st === 'UNIMART' || st === 'UNIMARTC2C') {
      return deepFreeze({ kind: 'state', state: 'returning', exception: 'uncollected' });
    }
  }

  // 3020: returning + uncollected for FAMI, FAMIC2C, HILIFE, HILIFEC2C
  if (code === '3020') {
    if (st === 'FAMI' || st === 'FAMIC2C' || st === 'HILIFE' || st === 'HILIFEC2C') {
      return deepFreeze({ kind: 'state', state: 'returning', exception: 'uncollected' });
    }
  }

  // 2098: ready_for_pickup for UNIMART, UNIMARTC2C
  if (code === '2098') {
    if (st === 'UNIMART' || st === 'UNIMARTC2C') {
      return deepFreeze({ kind: 'state', state: 'ready_for_pickup', exception: null });
    }
  }

  // 2099: returned for UNIMARTC2C
  if (code === '2099') {
    if (st === 'UNIMARTC2C') {
      return deepFreeze({ kind: 'state', state: 'returned', exception: null });
    }
  }

  // 2037: exception_only pickup_store_closed for UNIMART
  if (code === '2037') {
    if (st === 'UNIMART') {
      return deepFreeze({ kind: 'exception_only', exception: 'pickup_store_closed' });
    }
  }

  // 7011: exception_only pickup_store_closed for FAMI, HILIFE only (not C2C subtypes)
  if (code === '7011') {
    if (st === 'FAMI' || st === 'HILIFE') {
      return deepFreeze({ kind: 'exception_only', exception: 'pickup_store_closed' });
    }
  }

  return deepFreeze({ kind: 'unmapped' });
}

export type TrackingStateChange = 'advance' | 'none' | 'ignore_older' | 'contradiction';

export interface ApplyTrackingResult {
  readonly next: ShipmentState;
  readonly change: TrackingStateChange;
  readonly implies_handover: boolean;
}

/**
 * Applies incoming tracking state to current shipment state.
 * Spec §6.3, §6.4:
 * 1. current === 'voided' -> contradiction, next = 'voided'
 * 2. incoming === current -> none
 * 3. current order <= 1 -> advance
 * 4. current in F:
 *    incoming in F -> advance if higher order, else ignore_older
 *    incoming in R -> contradiction when current === 'delivered', else advance
 * 5. current in R:
 *    incoming in R -> advance from returning to returned, ignore_older from returned to returning
 *    incoming in F -> contradiction when incoming === 'delivered', else ignore_older
 */
export function applyTrackingState(
  current: ShipmentState,
  incoming: ShipmentState,
): ApplyTrackingResult {
  if (!ALL_SHIPMENT_STATES.includes(current)) {
    throw new FulfilmentRuleError();
  }
  if (!VALID_INCOMING_STATES.includes(incoming)) {
    throw new FulfilmentRuleError();
  }

  let change: TrackingStateChange;
  let next: ShipmentState;

  if (current === 'voided') {
    change = 'contradiction';
    next = 'voided';
  } else if (incoming === current) {
    change = 'none';
    next = current;
  } else {
    const currentOrder = SHIPMENT_STATE_ORDER[current]!;
    const incomingOrder = SHIPMENT_STATE_ORDER[incoming]!;

    if (currentOrder <= 1) {
      change = 'advance';
      next = incoming;
    } else if (FORWARD_STATES.includes(current)) {
      if (FORWARD_STATES.includes(incoming)) {
        if (incomingOrder > currentOrder) {
          change = 'advance';
          next = incoming;
        } else {
          change = 'ignore_older';
          next = current;
        }
      } else {
        // incoming in RETURN_STATES
        if (current === 'delivered') {
          change = 'contradiction';
          next = current;
        } else {
          change = 'advance';
          next = incoming;
        }
      }
    } else {
      // current in RETURN_STATES
      if (RETURN_STATES.includes(incoming)) {
        if (current === 'returning' && incoming === 'returned') {
          change = 'advance';
          next = incoming;
        } else {
          change = 'ignore_older';
          next = current;
        }
      } else {
        // incoming in FORWARD_STATES
        if (incoming === 'delivered') {
          change = 'contradiction';
          next = current;
        } else {
          change = 'ignore_older';
          next = current;
        }
      }
    }
  }

  const currentOrder = SHIPMENT_STATE_ORDER[current];
  const incomingOrder = SHIPMENT_STATE_ORDER[incoming];
  const impliesHandover =
    change === 'advance' &&
    currentOrder !== null &&
    currentOrder < 3 &&
    incomingOrder !== null &&
    incomingOrder >= 4;

  return deepFreeze({
    next,
    change,
    implies_handover: impliesHandover,
  });
}
