import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FulfilmentRuleError,
  SERVICE_KEYS,
  DELIVERY_METHODS,
  UNAVAILABLE_REASONS,
  TEMPERATURES,
  CVS_PARCEL_VALUE_MAX_MINOR,
  POST_MAX_WEIGHT_G,
  POSTAL_SOURCE,
  methodOfService,
  logisticsSubTypeOfService,
  isKnownPostalPrefix,
  isOutlyingPostalPrefix,
  validateRecipientName,
  normalizeMobile,
  validateHomeRecipient,
  validateCvsRecipient,
  normalizeCvsStoreSelection,
  computeShipBy,
  planDelivery,
  availableMethods,
  SHIPMENT_STATE_ORDER,
  ALL_SHIPMENT_STATES,
  VALID_INCOMING_STATES,
  mapLogisticsStatus,
  applyTrackingState,
  applyLogisticsEvent,
  type DeliveryMethod,
  type DeliveryOption,
  type ItemShippingAttributes,
  type PlanInput,
  type ProfileService,
  type QuoteLine,
  type ServiceKey,
  type ShippingProfile,
  type LogisticsStatusResult,
  type LogisticsEventInput,
  type LogisticsEventOutcome,
} from '../../modules/agent-commerce/fulfilment/rules/index.js';
import { ECPAY_LOGISTICS_STATUS_TABLE } from '../../modules/agent-commerce/fulfilment/rules/tracking.js';

// --- Fixture Builders ---

function makeAttributes(overrides: Partial<ItemShippingAttributes> = {}): ItemShippingAttributes {
  return {
    weight_g: 500,
    length_mm: 200,
    width_mm: 150,
    height_mm: 100,
    temperature: 'ambient',
    cvs_allowed: true,
    ship_alone: false,
    max_per_parcel: null,
    ...overrides,
  };
}

function makeService(overrides: Partial<ProfileService> = {}): ProfileService {
  return {
    service_key: 'ecpay.logistics.home.tcat',
    ship_from_location_id: 'loc-default',
    temperature: 'ambient',
    handling_days: 2,
    cutoff_time: '15:00',
    limits: {
      max_weight_g: 20_000,
      max_longest_side_mm: 1500,
      max_dimension_sum_mm: 1500,
    },
    outlying_islands: 'allowed',
    ...overrides,
  };
}

function makeProfile(shopId: string, services: ProfileService[], overrides: Partial<ShippingProfile> = {}): ShippingProfile {
  return {
    shop_id: shopId,
    version: 'v1',
    working_days: [1, 2, 3, 4, 5],
    services,
    ...overrides,
  };
}

function makeLine(ref: string, overrides: Partial<QuoteLine> = {}): QuoteLine {
  return {
    line_ref: ref,
    quantity: 1,
    unit_price_minor: 10000,
    attributes: makeAttributes(),
    fulfilment: { kind: 'self' },
    ...overrides,
  };
}

describe('1. Two shippers (spec §12 row 1)', () => {
  it('plans delivery across two shippers and checks availableMethods and free shipping', () => {
    // Seller shop-s profile v"s1": services [home.tcat (loc-s, handling 1, cutoff 15:00, limits 20000 g / 1500 mm / 1500 mm, outlying excluded),
    // cvs.unimartc2c (loc-s, handling 2, cutoff 15:00, limits 5000 g / 450 mm / 1050 mm, outlying allowed)], working days Mon–Fri.
    const profileS: ShippingProfile = {
      shop_id: 'shop-s',
      version: 's1',
      working_days: [1, 2, 3, 4, 5],
      services: [
        makeService({
          service_key: 'ecpay.logistics.home.tcat',
          ship_from_location_id: 'loc-s',
          handling_days: 1,
          cutoff_time: '15:00',
          limits: { max_weight_g: 20000, max_longest_side_mm: 1500, max_dimension_sum_mm: 1500 },
          outlying_islands: 'excluded',
        }),
        makeService({
          service_key: 'ecpay.logistics.cvs.unimartc2c',
          ship_from_location_id: 'loc-s',
          handling_days: 2,
          cutoff_time: '15:00',
          limits: { max_weight_g: 5000, max_longest_side_mm: 450, max_dimension_sum_mm: 1050 },
          outlying_islands: 'allowed',
        }),
      ],
    };

    // Supplier shop-p profile v"p1": services [home.tcat (loc-p, handling 2, cutoff 12:00, same limits, outlying excluded)].
    const profileP: ShippingProfile = {
      shop_id: 'shop-p',
      version: 'p1',
      working_days: [1, 2, 3, 4, 5],
      services: [
        makeService({
          service_key: 'ecpay.logistics.home.tcat',
          ship_from_location_id: 'loc-p',
          handling_days: 2,
          cutoff_time: '12:00',
          limits: { max_weight_g: 20000, max_longest_side_mm: 1500, max_dimension_sum_mm: 1500 },
          outlying_islands: 'excluded',
        }),
      ],
    };

    const deliveryOptions: DeliveryOption[] = [
      {
        method: 'home',
        fee_per_parcel_minor: 10000,
        free_over_minor: 200000,
        outlying: { kind: 'excluded' },
      },
      {
        method: 'cvs:UNIMARTC2C',
        fee_per_parcel_minor: 6000,
        free_over_minor: null,
        outlying: { kind: 'excluded' },
      },
    ];

    // Lines (in this order):
    // a drop-ship from shop-p (agreement ag-1 v1, service_keys [home.tcat]), qty 2, unit price 30000, 800 g 300×200×100;
    // b self, qty 1, unit price 50000, 1200 g 400×300×200.
    const lineA = makeLine('a', {
      quantity: 2,
      unit_price_minor: 30000,
      attributes: makeAttributes({
        weight_g: 800,
        length_mm: 300,
        width_mm: 200,
        height_mm: 100,
      }),
      fulfilment: {
        kind: 'drop_ship',
        executor_shop_id: 'shop-p',
        agreement_id: 'ag-1',
        agreement_version: '1',
        service_keys: ['ecpay.logistics.home.tcat'],
      },
    });

    const lineB = makeLine('b', {
      quantity: 1,
      unit_price_minor: 50000,
      attributes: makeAttributes({
        weight_g: 1200,
        length_mm: 400,
        width_mm: 300,
        height_mm: 200,
      }),
      fulfilment: { kind: 'self' },
    });

    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: deliveryOptions,
      profiles: { 'shop-s': profileS, 'shop-p': profileP },
      lines: [lineA, lineB],
      merchandise_net_minor: 110000,
      destination: { outlying: false },
    };

    // home -> plan with g1 = shop-p/drop_ship/ag-1/loc-p/home.tcat/handling 2/cutoff 12:00 and one parcel g1-p1 [a×2] 1600 g declared 60000;
    // g2 = shop-s/self/loc-s with parcel g2-p1 [b×1]; each shipping_minor 10000; total 20000.
    const planHome = planDelivery(input, 'home');
    assert.equal(planHome.kind, 'plan');
    if (planHome.kind === 'plan') {
      assert.equal(planHome.method, 'home');
      assert.equal(planHome.shipping_total_minor, 20000);
      assert.equal(planHome.groups.length, 2);

      const [g1, g2] = planHome.groups;
      assert.equal(g1.group_ref, 'g1');
      assert.equal(g1.executor_shop_id, 'shop-p');
      assert.equal(g1.fulfilment_mode, 'drop_ship');
      assert.equal(g1.agreement_id, 'ag-1');
      assert.equal(g1.agreement_version, '1');
      assert.equal(g1.profile_version, 'p1');
      assert.equal(g1.service_key, 'ecpay.logistics.home.tcat');
      assert.equal(g1.logistics_sub_type, 'TCAT');
      assert.equal(g1.ship_from_location_id, 'loc-p');
      assert.equal(g1.temperature, 'ambient');
      assert.equal(g1.handling_days, 2);
      assert.equal(g1.cutoff_time, '12:00');
      assert.deepEqual(g1.working_days, [1, 2, 3, 4, 5]);
      assert.equal(g1.shipping_minor, 10000);
      assert.equal(g1.parcels.length, 1);
      assert.deepEqual(g1.parcels[0], {
        parcel_ref: 'g1-p1',
        lines: [{ line_ref: 'a', quantity: 2 }],
        weight_g: 1600,
        declared_value_minor: 60000,
      });

      assert.equal(g2.group_ref, 'g2');
      assert.equal(g2.executor_shop_id, 'shop-s');
      assert.equal(g2.fulfilment_mode, 'self');
      assert.equal(g2.agreement_id, null);
      assert.equal(g2.agreement_version, null);
      assert.equal(g2.profile_version, 's1');
      assert.equal(g2.service_key, 'ecpay.logistics.home.tcat');
      assert.equal(g2.logistics_sub_type, 'TCAT');
      assert.equal(g2.ship_from_location_id, 'loc-s');
      assert.equal(g2.temperature, 'ambient');
      assert.equal(g2.handling_days, 1);
      assert.equal(g2.cutoff_time, '15:00');
      assert.deepEqual(g2.working_days, [1, 2, 3, 4, 5]);
      assert.equal(g2.shipping_minor, 10000);
      assert.equal(g2.parcels.length, 1);
      assert.deepEqual(g2.parcels[0], {
        parcel_ref: 'g2-p1',
        lines: [{ line_ref: 'b', quantity: 1 }],
        weight_g: 1200,
        declared_value_minor: 50000,
      });
    }

    // cvs:UNIMARTC2C -> unavailable [{ line_ref: 'a', reason: 'method_unsupported' }]
    const planCvs = planDelivery(input, 'cvs:UNIMARTC2C');
    assert.deepEqual(planCvs, {
      kind: 'unavailable',
      method: 'cvs:UNIMARTC2C',
      lines: [{ line_ref: 'a', reason: 'method_unsupported' }],
    });

    // availableMethods returns both in option order
    const available = availableMethods(input);
    assert.equal(available.length, 2);
    assert.equal(available[0].method, 'home');
    assert.equal(available[0].result.kind, 'plan');
    assert.equal(available[1].method, 'cvs:UNIMARTC2C');
    assert.equal(available[1].result.kind, 'unavailable');

    // With merchandise_net_minor 200000 -> total 0 (free shipping)
    const inputFree: PlanInput = {
      ...input,
      merchandise_net_minor: 200000,
    };
    const planFree = planDelivery(inputFree, 'home');
    assert.equal(planFree.kind, 'plan');
    if (planFree.kind === 'plan') {
      assert.equal(planFree.shipping_total_minor, 0);
      assert.equal(planFree.groups[0].shipping_minor, 0);
      assert.equal(planFree.groups[1].shipping_minor, 0);
    }
  });
});

describe('2. Reason precedence', () => {
  const baseService = makeService({
    service_key: 'ecpay.logistics.home.tcat',
    limits: { max_weight_g: 20000, max_longest_side_mm: 1500, max_dimension_sum_mm: 1500 },
    outlying_islands: 'allowed',
  });
  const cvsService = makeService({
    service_key: 'ecpay.logistics.cvs.unimartc2c',
    limits: { max_weight_g: 5000, max_longest_side_mm: 450, max_dimension_sum_mm: 1050 },
    outlying_islands: 'allowed',
  });
  const postService = makeService({
    service_key: 'ecpay.logistics.home.post',
    limits: { max_weight_g: 30000, max_longest_side_mm: 1500, max_dimension_sum_mm: 3000 },
    outlying_islands: 'allowed',
  });

  const baseProfiles = {
    'shop-s': makeProfile('shop-s', [baseService, cvsService, postService]),
    'shop-p': makeProfile('shop-p', [baseService]),
  };

  const defaultOptions: DeliveryOption[] = [
    { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'surcharge', surcharge_per_parcel_minor: 2000 } },
    { method: 'cvs:UNIMARTC2C', fee_per_parcel_minor: 6000, free_over_minor: null, outlying: { kind: 'excluded' } },
  ];

  function runCheck(lines: QuoteLine[], method: DeliveryMethod = 'home', destOutlying = false, opts = defaultOptions) {
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: opts,
      profiles: baseProfiles,
      lines,
      merchandise_net_minor: 10000,
      destination: { outlying: destOutlying },
    };
    return planDelivery(input, method);
  }

  it('not_agreed + null attributes -> fulfilment_not_agreed', () => {
    const res = runCheck([makeLine('l1', { fulfilment: { kind: 'not_agreed' }, attributes: null })]);
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'fulfilment_not_agreed' }],
    });
  });

  it('null attributes -> shipping_attributes_missing', () => {
    const res = runCheck([makeLine('l1', { attributes: null })]);
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'shipping_attributes_missing' }],
    });
  });

  it('seller without the method -> method_unsupported', () => {
    const res = runCheck([makeLine('l1')], 'cvs:FAMIC2C');
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'cvs:FAMIC2C',
      lines: [{ line_ref: 'l1', reason: 'method_unsupported' }],
    });
  });

  it('drop-ship whose agreement lacks the service -> method_unsupported', () => {
    const res = runCheck([
      makeLine('l1', {
        fulfilment: {
          kind: 'drop_ship',
          executor_shop_id: 'shop-p',
          agreement_id: 'ag-1',
          agreement_version: '1',
          service_keys: ['ecpay.logistics.home.post'], // shop-p profile only has home.tcat!
        },
      }),
    ], 'home');
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'method_unsupported' }],
    });
  });

  it('cvs_allowed false on a cvs method -> method_unsupported', () => {
    const res = runCheck([
      makeLine('l1', { attributes: makeAttributes({ cvs_allowed: false }) }),
    ], 'cvs:UNIMARTC2C');
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'cvs:UNIMARTC2C',
      lines: [{ line_ref: 'l1', reason: 'method_unsupported' }],
    });
  });

  it('frozen item -> temperature_unsupported', () => {
    const res = runCheck([
      makeLine('l1', { attributes: makeAttributes({ temperature: 'frozen' }) }),
    ]);
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'temperature_unsupported' }],
    });
  });

  it('1600 mm side -> too_large', () => {
    const res = runCheck([
      makeLine('l1', { attributes: makeAttributes({ length_mm: 1600, width_mm: 100, height_mm: 100 }) }),
    ]);
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'too_large' }],
    });
  });

  it('sum over the limit -> too_large', () => {
    const res = runCheck([
      makeLine('l1', { attributes: makeAttributes({ length_mm: 1100, width_mm: 1000, height_mm: 1000 }) }),
    ]);
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'too_large' }],
    });
  });

  it('25 kg on home.post with limit 30000 -> too_large (20 kg cap)', () => {
    // A profile with ONLY home.post and limit 30000
    const profilePostOnly = makeProfile('shop-s', [
      makeService({
        service_key: 'ecpay.logistics.home.post',
        limits: { max_weight_g: 30000, max_longest_side_mm: 1500, max_dimension_sum_mm: 3000 },
      }),
    ]);
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: defaultOptions,
      profiles: { 'shop-s': profilePostOnly },
      lines: [makeLine('l1', { attributes: makeAttributes({ weight_g: 25000, length_mm: 200, width_mm: 200, height_mm: 200 }) })],
      merchandise_net_minor: 10000,
      destination: { outlying: false },
    };
    const res = planDelivery(input, 'home');
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'too_large' }],
    });
  });

  it('unit price 2_000_100 on cvs -> cvs_value_limit', () => {
    const res = runCheck([
      makeLine('l1', { unit_price_minor: 2_000_100 }),
    ], 'cvs:UNIMARTC2C');
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'cvs:UNIMARTC2C',
      lines: [{ line_ref: 'l1', reason: 'cvs_value_limit' }],
    });
  });

  it('outlying with option excluded -> outlying_unsupported', () => {
    const optsExcluded: DeliveryOption[] = [
      { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
    ];
    const res = runCheck([makeLine('l1')], 'home', true, optsExcluded);
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'outlying_unsupported' }],
    });
  });

  it('outlying with only home.post (allowed in profile) -> outlying_unsupported', () => {
    const profilePostOnly = makeProfile('shop-s', [
      makeService({
        service_key: 'ecpay.logistics.home.post',
        outlying_islands: 'allowed',
      }),
    ]);
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: defaultOptions,
      profiles: { 'shop-s': profilePostOnly },
      lines: [makeLine('l1')],
      merchandise_net_minor: 10000,
      destination: { outlying: true },
    };
    const res = planDelivery(input, 'home');
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [{ line_ref: 'l1', reason: 'outlying_unsupported' }],
    });
  });

  it('several failing lines are all listed in input order', () => {
    const lines = [
      makeLine('line-not-agreed', { fulfilment: { kind: 'not_agreed' } }),
      makeLine('line-missing-attr', { attributes: null }),
      makeLine('line-ok', { attributes: makeAttributes() }),
      makeLine('line-frozen', { attributes: makeAttributes({ temperature: 'frozen' }) }),
    ];
    const res = runCheck(lines, 'home');
    assert.deepEqual(res, {
      kind: 'unavailable',
      method: 'home',
      lines: [
        { line_ref: 'line-not-agreed', reason: 'fulfilment_not_agreed' },
        { line_ref: 'line-missing-attr', reason: 'shipping_attributes_missing' },
        { line_ref: 'line-frozen', reason: 'temperature_unsupported' },
      ],
    });
  });
});

describe('3. Service choice', () => {
  it('prefers a common service for the cluster when one exists', () => {
    // profile [home.post (20000 g / 1500 mm / 3000 mm), home.tcat (30000 g / 1500 mm / 3000 mm)],
    // self lines x 1000 g and y 25000 g (both ambient, small sides) -> both on home.tcat in one group g1, one parcel 26000 g
    const profile = makeProfile('shop-s', [
      makeService({
        service_key: 'ecpay.logistics.home.post',
        limits: { max_weight_g: 20000, max_longest_side_mm: 1500, max_dimension_sum_mm: 3000 },
      }),
      makeService({
        service_key: 'ecpay.logistics.home.tcat',
        limits: { max_weight_g: 30000, max_longest_side_mm: 1500, max_dimension_sum_mm: 3000 },
      }),
    ]);

    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: [
        { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
      ],
      profiles: { 'shop-s': profile },
      lines: [
        makeLine('x', { attributes: makeAttributes({ weight_g: 1000 }) }),
        makeLine('y', { attributes: makeAttributes({ weight_g: 25000 }) }),
      ],
      merchandise_net_minor: 20000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      assert.equal(res.groups.length, 1);
      const g = res.groups[0];
      assert.equal(g.group_ref, 'g1');
      assert.equal(g.service_key, 'ecpay.logistics.home.tcat');
      assert.equal(g.parcels.length, 1);
      assert.equal(g.parcels[0].weight_g, 26000);
      assert.deepEqual(g.parcels[0].lines, [
        { line_ref: 'x', quantity: 1 },
        { line_ref: 'y', quantity: 1 },
      ]);
    }
  });

  it('falls back to each line using its own first eligible service when no common service exists', () => {
    // profile [home.post (20000 g / 1600 mm / 3000 mm), home.tcat (30000 g / 1500 mm / 3000 mm)],
    // line u 1000 g with a 1550 mm side (only post fits) and line v 25000 g with small sides (only tcat fits) -> two groups, g1 post [u], g2 tcat [v]
    const profile = makeProfile('shop-s', [
      makeService({
        service_key: 'ecpay.logistics.home.post',
        ship_from_location_id: 'loc-post',
        limits: { max_weight_g: 20000, max_longest_side_mm: 1600, max_dimension_sum_mm: 3000 },
      }),
      makeService({
        service_key: 'ecpay.logistics.home.tcat',
        ship_from_location_id: 'loc-tcat',
        limits: { max_weight_g: 30000, max_longest_side_mm: 1500, max_dimension_sum_mm: 3000 },
      }),
    ]);

    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: [
        { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
      ],
      profiles: { 'shop-s': profile },
      lines: [
        makeLine('u', { attributes: makeAttributes({ weight_g: 1000, length_mm: 1550, width_mm: 100, height_mm: 100 }) }),
        makeLine('v', { attributes: makeAttributes({ weight_g: 25000, length_mm: 200, width_mm: 200, height_mm: 200 }) }),
      ],
      merchandise_net_minor: 20000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      assert.equal(res.groups.length, 2);
      assert.equal(res.groups[0].group_ref, 'g1');
      assert.equal(res.groups[0].service_key, 'ecpay.logistics.home.post');
      assert.deepEqual(res.groups[0].parcels[0].lines, [{ line_ref: 'u', quantity: 1 }]);

      assert.equal(res.groups[1].group_ref, 'g2');
      assert.equal(res.groups[1].service_key, 'ecpay.logistics.home.tcat');
      assert.deepEqual(res.groups[1].parcels[0].lines, [{ line_ref: 'v', quantity: 1 }]);
    }
  });

  it('splits two drop-ship lines from the same supplier under different agreements into two groups', () => {
    const profileP = makeProfile('shop-p', [
      makeService({
        service_key: 'ecpay.logistics.home.tcat',
        ship_from_location_id: 'loc-p',
      }),
    ]);

    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: [
        { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
      ],
      profiles: {
        'shop-s': makeProfile('shop-s', []),
        'shop-p': profileP,
      },
      lines: [
        makeLine('ds1', {
          fulfilment: {
            kind: 'drop_ship',
            executor_shop_id: 'shop-p',
            agreement_id: 'ag-alpha',
            agreement_version: '1',
            service_keys: ['ecpay.logistics.home.tcat'],
          },
        }),
        makeLine('ds2', {
          fulfilment: {
            kind: 'drop_ship',
            executor_shop_id: 'shop-p',
            agreement_id: 'ag-beta',
            agreement_version: '1',
            service_keys: ['ecpay.logistics.home.tcat'],
          },
        }),
      ],
      merchandise_net_minor: 20000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      assert.equal(res.groups.length, 2);
      assert.equal(res.groups[0].agreement_id, 'ag-alpha');
      assert.equal(res.groups[1].agreement_id, 'ag-beta');
    }
  });
});

describe('4. Parcels packing', () => {
  const profile = makeProfile('shop-s', [
    makeService({
      service_key: 'ecpay.logistics.home.tcat',
      limits: { max_weight_g: 20000, max_longest_side_mm: 1500, max_dimension_sum_mm: 1500 },
    }),
    makeService({
      service_key: 'ecpay.logistics.cvs.unimartc2c',
      limits: { max_weight_g: 5000, max_longest_side_mm: 450, max_dimension_sum_mm: 1050 },
    }),
  ]);

  const deliveryOptions: DeliveryOption[] = [
    { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
    { method: 'cvs:UNIMARTC2C', fee_per_parcel_minor: 6000, free_over_minor: null, outlying: { kind: 'excluded' } },
  ];

  it('4 × 6000 g on tcat (20000 limit) -> p1 3 units 18000 g, p2 1 unit 6000 g', () => {
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: deliveryOptions,
      profiles: { 'shop-s': profile },
      lines: [
        makeLine('heavy', {
          quantity: 4,
          attributes: makeAttributes({ weight_g: 6000 }),
        }),
      ],
      merchandise_net_minor: 40000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      const g = res.groups[0];
      assert.equal(g.parcels.length, 2);
      assert.equal(g.parcels[0].parcel_ref, 'g1-p1');
      assert.equal(g.parcels[0].weight_g, 18000);
      assert.deepEqual(g.parcels[0].lines, [{ line_ref: 'heavy', quantity: 3 }]);

      assert.equal(g.parcels[1].parcel_ref, 'g1-p2');
      assert.equal(g.parcels[1].weight_g, 6000);
      assert.deepEqual(g.parcels[1].lines, [{ line_ref: 'heavy', quantity: 1 }]);
    }
  });

  it('ship_alone qty 2 followed by a line with max_per_parcel 2 qty 3 -> p1 [l1×1], p2 [l1×1], p3 [l2×2], p4 [l2×1]', () => {
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: deliveryOptions,
      profiles: { 'shop-s': profile },
      lines: [
        makeLine('l1', {
          quantity: 2,
          attributes: makeAttributes({ weight_g: 500, ship_alone: true }),
        }),
        makeLine('l2', {
          quantity: 3,
          attributes: makeAttributes({ weight_g: 500, max_per_parcel: 2 }),
        }),
      ],
      merchandise_net_minor: 50000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      const g = res.groups[0];
      assert.equal(g.parcels.length, 4);
      assert.equal(g.parcels[0].parcel_ref, 'g1-p1');
      assert.deepEqual(g.parcels[0].lines, [{ line_ref: 'l1', quantity: 1 }]);

      assert.equal(g.parcels[1].parcel_ref, 'g1-p2');
      assert.deepEqual(g.parcels[1].lines, [{ line_ref: 'l1', quantity: 1 }]);

      assert.equal(g.parcels[2].parcel_ref, 'g1-p3');
      assert.deepEqual(g.parcels[2].lines, [{ line_ref: 'l2', quantity: 2 }]);

      assert.equal(g.parcels[3].parcel_ref, 'g1-p4');
      assert.deepEqual(g.parcels[3].lines, [{ line_ref: 'l2', quantity: 1 }]);
    }
  });

  it('cvs 3 × 900000 -> p1 2 units (1_800_000), p2 1 unit (900000)', () => {
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: deliveryOptions,
      profiles: { 'shop-s': profile },
      lines: [
        makeLine('valuable', {
          quantity: 3,
          unit_price_minor: 900000,
          attributes: makeAttributes({ weight_g: 500 }),
        }),
      ],
      merchandise_net_minor: 2700000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'cvs:UNIMARTC2C');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      const g = res.groups[0];
      assert.equal(g.parcels.length, 2);
      assert.equal(g.parcels[0].declared_value_minor, 1800000);
      assert.deepEqual(g.parcels[0].lines, [{ line_ref: 'valuable', quantity: 2 }]);

      assert.equal(g.parcels[1].declared_value_minor, 900000);
      assert.deepEqual(g.parcels[1].lines, [{ line_ref: 'valuable', quantity: 1 }]);
    }
  });

  it('first-fit puts a light unit later back into an earlier parcel with room', () => {
    // p1 has 18000 g (room for 2000 g). Line 2 has 5000 g -> cannot fit in p1, opens p2. Line 3 has 1000 g -> fits into p1!
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: deliveryOptions,
      profiles: { 'shop-s': profile },
      lines: [
        makeLine('heavy1', { quantity: 1, attributes: makeAttributes({ weight_g: 18000 }) }),
        makeLine('heavy2', { quantity: 1, attributes: makeAttributes({ weight_g: 5000 }) }),
        makeLine('light', { quantity: 1, attributes: makeAttributes({ weight_g: 1000 }) }),
      ],
      merchandise_net_minor: 30000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      const g = res.groups[0];
      assert.equal(g.parcels.length, 2);
      assert.equal(g.parcels[0].parcel_ref, 'g1-p1');
      assert.equal(g.parcels[0].weight_g, 19000);
      // Notice sorted by input order: heavy1 then light
      assert.deepEqual(g.parcels[0].lines, [
        { line_ref: 'heavy1', quantity: 1 },
        { line_ref: 'light', quantity: 1 },
      ]);

      assert.equal(g.parcels[1].parcel_ref, 'g1-p2');
      assert.equal(g.parcels[1].weight_g, 5000);
      assert.deepEqual(g.parcels[1].lines, [{ line_ref: 'heavy2', quantity: 1 }]);
    }
  });

  it('weight exactly at the cap fits', () => {
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: deliveryOptions,
      profiles: { 'shop-s': profile },
      lines: [
        makeLine('exact-cap', { quantity: 1, attributes: makeAttributes({ weight_g: 20000 }) }),
      ],
      merchandise_net_minor: 10000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      assert.equal(res.groups[0].parcels.length, 1);
      assert.equal(res.groups[0].parcels[0].weight_g, 20000);
    }
  });
});

describe('5. Fees calculation', () => {
  const profile = makeProfile('shop-s', [
    makeService({
      service_key: 'ecpay.logistics.home.tcat',
      limits: { max_weight_g: 10000, max_longest_side_mm: 1500, max_dimension_sum_mm: 1500 },
      outlying_islands: 'allowed',
    }),
  ]);

  it('free_over reached -> 0 base; outlying surcharge applies even when free; free_over equal to net -> free', () => {
    // 2 parcels (2 lines of 8000 g each)
    const options: DeliveryOption[] = [
      {
        method: 'home',
        fee_per_parcel_minor: 10000,
        free_over_minor: 150000,
        outlying: { kind: 'surcharge', surcharge_per_parcel_minor: 20000 },
      },
    ];

    const lines = [
      makeLine('l1', { attributes: makeAttributes({ weight_g: 8000 }) }),
      makeLine('l2', { attributes: makeAttributes({ weight_g: 8000 }) }),
    ];

    // Case A: merchandise_net_minor = 150000 (equal to free_over), outlying = true
    const inputA: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: options,
      profiles: { 'shop-s': profile },
      lines,
      merchandise_net_minor: 150000,
      destination: { outlying: true },
    };

    const resA = planDelivery(inputA, 'home');
    assert.equal(resA.kind, 'plan');
    if (resA.kind === 'plan') {
      const g = resA.groups[0];
      assert.equal(g.parcels.length, 2);
      assert.equal(g.fee_per_parcel_minor, 0); // free
      assert.equal(g.outlying_surcharge_per_parcel_minor, 20000); // surcharge applies!
      assert.equal(g.shipping_minor, 40000); // 2 * (0 + 20000)
      assert.equal(resA.shipping_total_minor, 40000);
    }

    // Case B: merchandise_net_minor = 149900 (not free), outlying = true
    const inputB: PlanInput = {
      ...inputA,
      merchandise_net_minor: 149900,
    };
    const resB = planDelivery(inputB, 'home');
    assert.equal(resB.kind, 'plan');
    if (resB.kind === 'plan') {
      const g = resB.groups[0];
      assert.equal(g.fee_per_parcel_minor, 10000);
      assert.equal(g.outlying_surcharge_per_parcel_minor, 20000);
      assert.equal(g.shipping_minor, 60000); // 2 * (10000 + 20000)
      assert.equal(resB.shipping_total_minor, 60000);
    }
  });
});

describe('6. Input validation (invalid_input)', () => {
  const validService = makeService();
  const validProfile = makeProfile('shop-s', [validService]);
  const validOptions: DeliveryOption[] = [
    { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: 200000, outlying: { kind: 'excluded' } },
  ];
  const validLine = makeLine('l1');

  function makeValidInput(overrides: Partial<PlanInput> = {}): PlanInput {
    return {
      seller_shop_id: 'shop-s',
      delivery_options: validOptions,
      profiles: { 'shop-s': validProfile },
      lines: [validLine],
      merchandise_net_minor: 50000,
      destination: { outlying: false },
      ...overrides,
    };
  }

  function assertInvalidInput(fn: () => void) {
    try {
      fn();
      assert.fail('Expected FulfilmentRuleError but nothing was thrown');
    } catch (err) {
      assert.ok(err instanceof FulfilmentRuleError);
      assert.equal((err as FulfilmentRuleError).code, 'invalid_input');
      assert.equal((err as Error).message, 'Invalid fulfilment rule input');
    }
  }

  it('rejects duplicate line_ref', () => {
    const input = makeValidInput({ lines: [makeLine('dup'), makeLine('dup')] });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects quantity 0 or 100', () => {
    const input0 = makeValidInput({ lines: [makeLine('l1', { quantity: 0 })] });
    assertInvalidInput(() => planDelivery(input0, 'home'));

    const input100 = makeValidInput({ lines: [makeLine('l1', { quantity: 100 })] });
    assertInvalidInput(() => planDelivery(input100, 'home'));
  });

  it('rejects non-ambient profile service', () => {
    // @ts-expect-error test non-ambient
    const badService = makeService({ temperature: 'frozen' });
    const input = makeValidInput({ profiles: { 'shop-s': makeProfile('shop-s', [badService]) } });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects duplicate service key in profile', () => {
    const input = makeValidInput({
      profiles: {
        'shop-s': makeProfile('shop-s', [
          makeService({ service_key: 'ecpay.logistics.home.tcat' }),
          makeService({ service_key: 'ecpay.logistics.home.tcat' }),
        ]),
      },
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects unknown service key', () => {
    const input = makeValidInput({
      profiles: {
        'shop-s': makeProfile('shop-s', [
          // @ts-expect-error test unknown service
          makeService({ service_key: 'ecpay.logistics.cvs.okmart' }),
        ]),
      },
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects invalid working_days: [], [0], [8], duplicates', () => {
    for (const badDays of [[], [0], [8], [1, 1], [1, 2, 8]] as const) {
      const input = makeValidInput({
        profiles: { 'shop-s': makeProfile('shop-s', [validService], { working_days: badDays }) },
      });
      assertInvalidInput(() => planDelivery(input, 'home'));
    }
  });

  it('rejects cutoff_time 24:00', () => {
    const input = makeValidInput({
      profiles: {
        'shop-s': makeProfile('shop-s', [makeService({ cutoff_time: '24:00' })]),
      },
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects fee 150 (not multiple of 100)', () => {
    const input = makeValidInput({
      delivery_options: [
        { method: 'home', fee_per_parcel_minor: 150, free_over_minor: null, outlying: { kind: 'excluded' } },
      ],
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects duplicate option methods', () => {
    const input = makeValidInput({
      delivery_options: [
        { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
        { method: 'home', fee_per_parcel_minor: 20000, free_over_minor: null, outlying: { kind: 'excluded' } },
      ],
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects profile key !== profile.shop_id', () => {
    const input = makeValidInput({
      profiles: {
        'wrong-key': makeProfile('shop-s', [validService]),
      },
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects 51 lines', () => {
    const input = makeValidInput({
      lines: Array.from({ length: 51 }, (_, i) => makeLine(`line-${i}`)),
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects drop_ship with empty service_keys', () => {
    const input = makeValidInput({
      lines: [
        makeLine('l1', {
          fulfilment: {
            kind: 'drop_ship',
            executor_shop_id: 'shop-p',
            agreement_id: 'ag-1',
            agreement_version: '1',
            service_keys: [],
          },
        }),
      ],
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects drop_ship whose executor is the seller', () => {
    const input = makeValidInput({
      lines: [
        makeLine('l1', {
          fulfilment: {
            kind: 'drop_ship',
            executor_shop_id: 'shop-s', // same as seller_shop_id!
            agreement_id: 'ag-1',
            agreement_version: '1',
            service_keys: ['ecpay.logistics.home.tcat'],
          },
        }),
      ],
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects two lines with same agreement_id but different agreement_version', () => {
    const input = makeValidInput({
      lines: [
        makeLine('l1', {
          fulfilment: {
            kind: 'drop_ship',
            executor_shop_id: 'shop-p',
            agreement_id: 'ag-1',
            agreement_version: '1',
            service_keys: ['ecpay.logistics.home.tcat'],
          },
        }),
        makeLine('l2', {
          fulfilment: {
            kind: 'drop_ship',
            executor_shop_id: 'shop-p',
            agreement_id: 'ag-1',
            agreement_version: '2', // mismatch!
            service_keys: ['ecpay.logistics.home.tcat'],
          },
        }),
      ],
    });
    assertInvalidInput(() => planDelivery(input, 'home'));
  });

  it('rejects unknown method argument in planDelivery', () => {
    const input = makeValidInput();
    // @ts-expect-error invalid method
    assertInvalidInput(() => planDelivery(input, 'express'));
  });

  it('ensures thrown message never contains input values', () => {
    const sensitiveName = 'SuperSecretSellerXYZ999';
    try {
      const input = makeValidInput({
        lines: [makeLine(sensitiveName, { quantity: 1000 })],
      });
      planDelivery(input, 'home');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal((err as Error).message, 'Invalid fulfilment rule input');
      assert.ok(!((err as Error).message.includes(sensitiveName)));
    }
  });
});

describe('7. Recipient and postal checks', () => {
  it('validates recipient name vectors from §4', () => {
    assert.deepEqual(validateRecipientName('王小明'), { ok: true, value: '王小明' });
    assert.deepEqual(validateRecipientName('王明'), { ok: true, value: '王明' });
    assert.deepEqual(validateRecipientName('歐陽娜娜娜'), { ok: true, value: '歐陽娜娜娜' });
    assert.deepEqual(validateRecipientName('Mary'), { ok: true, value: 'Mary' });
    assert.deepEqual(validateRecipientName('Ｍａｒｙ'), { ok: true, value: 'Mary' });
    assert.deepEqual(validateRecipientName('王David'), { ok: true, value: '王David' });
    assert.deepEqual(validateRecipientName('𠮷野家'), { ok: true, value: '𠮷野家' });
    assert.deepEqual(validateRecipientName('  王小明  '), { ok: true, value: '王小明' });

    assert.deepEqual(validateRecipientName('王'), { ok: false, code: 'too_short' });
    assert.deepEqual(validateRecipientName('Amy'), { ok: false, code: 'too_short' });
    assert.deepEqual(validateRecipientName('歐陽娜娜娜娜'), { ok: false, code: 'too_long' });
    assert.deepEqual(validateRecipientName('Christopher'), { ok: false, code: 'too_long' });

    assert.deepEqual(validateRecipientName('王 小明'), { ok: false, code: 'format' });
    assert.deepEqual(validateRecipientName('王小明1'), { ok: false, code: 'format' });
    assert.deepEqual(validateRecipientName('王·明'), { ok: false, code: 'format' });
    assert.deepEqual(validateRecipientName('王小明😀'), { ok: false, code: 'format' });
    assert.deepEqual(validateRecipientName(''), { ok: false, code: 'required' });
    assert.deepEqual(validateRecipientName(null), { ok: false, code: 'required' });
    assert.deepEqual(validateRecipientName(12345), { ok: false, code: 'format' });

    // CDN blocked terms and order of checks
    assert.deepEqual(validateRecipientName('Echo'), { ok: false, code: 'blocked_term' });
    assert.deepEqual(validateRecipientName('ECHO'), { ok: false, code: 'blocked_term' });
    assert.deepEqual(validateRecipientName('echo王'), { ok: false, code: 'blocked_term' });
    assert.deepEqual(validateRecipientName('王小echo'), { ok: false, code: 'blocked_term' });
    assert.deepEqual(validateRecipientName('Tftp'), { ok: false, code: 'blocked_term' });
    assert.deepEqual(validateRecipientName('EcoLin'), { ok: true, value: 'EcoLin' });
    assert.deepEqual(validateRecipientName('Chen'), { ok: true, value: 'Chen' });
    assert.deepEqual(validateRecipientName('王小明Echo王小明'), { ok: false, code: 'too_long' });
    assert.deepEqual(validateRecipientName('EchoEchoEcho'), { ok: false, code: 'too_long' });
  });

  it('normalizes mobile vectors from §4', () => {
    assert.deepEqual(normalizeMobile('0912-345-678'), { ok: true, value: '0912345678' });
    assert.deepEqual(normalizeMobile('+886912345678'), { ok: true, value: '0912345678' });
    assert.deepEqual(normalizeMobile('０９１２３４５６７８'), { ok: true, value: '0912345678' });

    assert.deepEqual(normalizeMobile('0212345678'), { ok: false, code: 'format' });
    assert.deepEqual(normalizeMobile('091234567'), { ok: false, code: 'format' });
    assert.deepEqual(normalizeMobile(''), { ok: false, code: 'required' });
    assert.deepEqual(normalizeMobile(null), { ok: false, code: 'required' });
    assert.deepEqual(normalizeMobile(912345678), { ok: false, code: 'format' });
  });

  it('postal code prefix table has exactly 368 codes and validates known/outlying prefixes', () => {
    assert.equal(POSTAL_SOURCE.title, '臺灣地區郵遞區號前3碼一覽表');

    let count = 0;
    for (let i = 0; i <= 999; i++) {
      const code = String(i).padStart(3, '0');
      if (isKnownPostalPrefix(code)) {
        count++;
      }
    }
    assert.equal(count, 368, 'Taiwan 3-digit prefix table must contain exactly 368 codes');

    // postal 100, 10048, 100048 ok, 1004 format, 101 unknown_postal_code, 818 unknown, 983 ok, 984 unknown
    assert.equal(isKnownPostalPrefix('100'), true);
    assert.equal(isKnownPostalPrefix('101'), false);
    assert.equal(isKnownPostalPrefix('818'), false);
    assert.equal(isKnownPostalPrefix('983'), true);
    assert.equal(isKnownPostalPrefix('984'), false);

    // outlying 209, 880, 896, 929, 951, 952, 817, 819, 290 true; 928, 950 false; 895 unknown prefix
    assert.equal(isOutlyingPostalPrefix('209'), true);
    assert.equal(isOutlyingPostalPrefix('880'), true);
    assert.equal(isOutlyingPostalPrefix('896'), true);
    assert.equal(isOutlyingPostalPrefix('929'), true);
    assert.equal(isOutlyingPostalPrefix('951'), true);
    assert.equal(isOutlyingPostalPrefix('952'), true);
    assert.equal(isOutlyingPostalPrefix('817'), true);
    assert.equal(isOutlyingPostalPrefix('819'), true);
    assert.equal(isOutlyingPostalPrefix('290'), true);

    assert.equal(isOutlyingPostalPrefix('928'), false);
    assert.equal(isOutlyingPostalPrefix('950'), false);
    assert.equal(isKnownPostalPrefix('895'), false);
  });

  it('validates address length and controls characters', () => {
    // 6 code points -> too_short, 7 ok, 60 ok, 61 too_long
    const res6 = validateHomeRecipient({
      name: '王小明',
      mobile: '0912345678',
      postal_code: '100',
      address: '一二三四五六', // 6 chars
    });
    assert.deepEqual(res6, {
      ok: false,
      errors: [{ field: 'address', code: 'too_short' }],
    });

    const res7 = validateHomeRecipient({
      name: '王小明',
      mobile: '0912345678',
      postal_code: '100',
      address: '一二三四五六七', // 7 chars
    });
    assert.equal(res7.ok, true);

    const addr60 = '一'.repeat(60);
    const res60 = validateHomeRecipient({
      name: '王小明',
      mobile: '0912345678',
      postal_code: '100',
      address: addr60,
    });
    assert.equal(res60.ok, true);

    const addr61 = '一'.repeat(61);
    const res61 = validateHomeRecipient({
      name: '王小明',
      mobile: '0912345678',
      postal_code: '100',
      address: addr61,
    });
    assert.deepEqual(res61, {
      ok: false,
      errors: [{ field: 'address', code: 'too_long' }],
    });

    // Control characters stripped before counting
    const addrWithCtrl = '一二三四五六七\u0000\u001F\u007F\u0080';
    const resCtrl = validateHomeRecipient({
      name: '王小明',
      mobile: '0912345678',
      postal_code: '100',
      address: addrWithCtrl,
    });
    assert.equal(resCtrl.ok, true);
    if (resCtrl.ok) {
      assert.equal(resCtrl.recipient.address, '一二三四五六七');
    }

    // Lone UTF-16 surrogates are malformed (ECPay assertHomeAddress rejects them); a valid pair stays accepted
    for (const address of ['一二三四五六七\uD800', '一二三四五六七\uDC00', '一二三四五\uD840\u0000\uDC00六七']) {
      assert.deepEqual(validateHomeRecipient({ name: '王小明', mobile: '0912345678', postal_code: '100', address }), {
        ok: false,
        errors: [{ field: 'address', code: 'format' }],
      });
    }
    const resPair = validateHomeRecipient({ name: '王小明', mobile: '0912345678', postal_code: '100', address: '一二三四五六\uD840\uDC00' });
    assert.equal(resPair.ok, true);
    if (resPair.ok) {
      assert.equal(resPair.recipient.address, '一二三四五六\uD840\uDC00');
    }

    // Home address CDN blocked terms and HTML forbidden characters (<>&)
    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '台北市信義區A&B大樓1號',
      }),
      {
        ok: false,
        errors: [{ field: 'address', code: 'format' }],
      },
    );

    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '台北市信義區Ａ＆Ｂ大樓1號',
      }),
      {
        ok: false,
        errors: [{ field: 'address', code: 'format' }],
      },
    );

    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '<b>台北市信義區市府路1號</b>',
      }),
      {
        ok: false,
        errors: [{ field: 'address', code: 'format' }],
      },
    );

    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '台北市中正區echo路1號',
      }),
      {
        ok: false,
        errors: [{ field: 'address', code: 'blocked_term' }],
      },
    );

    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '台北市中正區cd/路1號',
      }),
      {
        ok: false,
        errors: [{ field: 'address', code: 'blocked_term' }],
      },
    );

    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '台北市中正區某路1號;',
      }),
      {
        ok: false,
        errors: [{ field: 'address', code: 'blocked_term' }],
      },
    );

    // 6-character address containing & -> format (format wins over too_short)
    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '台北&大樓1',
      }),
      {
        ok: false,
        errors: [{ field: 'address', code: 'format' }],
      },
    );

    // Normal address -> ok and unchanged
    assert.deepEqual(
      validateHomeRecipient({
        name: '王小明',
        mobile: '0912345678',
        postal_code: '100',
        address: '台北市中正區重慶南路一段122號',
      }),
      {
        ok: true,
        recipient: {
          name: '王小明',
          mobile: '0912345678',
          postal_code: '100',
          address: '台北市中正區重慶南路一段122號',
          postal_prefix: '100',
          outlying: false,
        },
      },
    );
  });

  it('validateHomeRecipient reports all errors in field order', () => {
    const res = validateHomeRecipient({
      name: '王', // too_short
      mobile: '123', // format
      postal_code: '1004', // format (4 digits)
      address: '', // required
    });
    assert.deepEqual(res, {
      ok: false,
      errors: [
        { field: 'name', code: 'too_short' },
        { field: 'mobile', code: 'format' },
        { field: 'postal_code', code: 'format' },
        { field: 'address', code: 'required' },
      ],
    });

    // postal unknown
    const resUnknown = validateHomeRecipient({
      name: '王小明',
      mobile: '0912345678',
      postal_code: '101',
      address: '台北市中正區重慶南路一段',
    });
    assert.deepEqual(resUnknown, {
      ok: false,
      errors: [{ field: 'postal_code', code: 'unknown_postal_code' }],
    });
  });

  it('validateCvsRecipient validates CVS recipient name and mobile', () => {
    const okRes = validateCvsRecipient({ name: '王小明', mobile: '0912345678' });
    assert.deepEqual(okRes, {
      ok: true,
      recipient: { name: '王小明', mobile: '0912345678' },
    });

    const errRes = validateCvsRecipient({ name: '', mobile: '123' });
    assert.deepEqual(errRes, {
      ok: false,
      errors: [
        { field: 'name', code: 'required' },
        { field: 'mobile', code: 'format' },
      ],
    });

    const blockedCvsRes = validateCvsRecipient({ name: 'Echo', mobile: '0912345678' });
    assert.deepEqual(blockedCvsRes, {
      ok: false,
      errors: [{ field: 'name', code: 'blocked_term' }],
    });
  });

  it('normalizeCvsStoreSelection normalizes and validates store map fields and Hi-Life outlying address fallback', () => {
    const ok = normalizeCvsStoreSelection({
      sub_type: 'UNIMARTC2C',
      store_id: '131386',
      store_name: '一二三四五六七八九十', // 10 code points
      store_address: '台北市大安區新生南路一段',
      outside: '0',
    });
    assert.deepEqual(ok, {
      ok: true,
      store: {
        sub_type: 'UNIMARTC2C',
        store_id: '131386',
        store_name: '一二三四五六七八九十',
        store_address: '台北市大安區新生南路一段',
        outlying: false,
      },
    });

    // 11-code-point name rejected
    const badName = normalizeCvsStoreSelection({
      sub_type: 'UNIMARTC2C',
      store_id: '131386',
      store_name: '一二三四五六七八九十一', // 11 code points
      store_address: '台北市大安區新生南路一段',
      outside: '0',
    });
    assert.deepEqual(badName, {
      ok: false,
      errors: [{ field: 'store_name', code: 'too_long' }],
    });

    // store_id 1234567 (7 chars -> too_long), outside '2' (format), sub_type UNIMART (B2C -> format)
    const badMisc = normalizeCvsStoreSelection({
      sub_type: 'UNIMART',
      store_id: '1234567',
      store_name: '示範門市',
      store_address: '台北市大安區新生南路一段',
      outside: '2',
    });
    assert.deepEqual(badMisc, {
      ok: false,
      errors: [
        { field: 'sub_type', code: 'format' },
        { field: 'store_id', code: 'too_long' },
        { field: 'outside', code: 'format' },
      ],
    });

    // store_id width checks: 1-6 ok; 7, 8, 9 too_long; 10 format; 12-456 format; full-width digits ok as 123456
    const baseStore = {
      sub_type: 'UNIMARTC2C' as const,
      store_name: '示範門市',
      store_address: '台北市大安區新生南路一段',
      outside: '0',
    };

    assert.deepEqual(
      normalizeCvsStoreSelection({ ...baseStore, store_id: '123456' }),
      {
        ok: true,
        store: {
          sub_type: 'UNIMARTC2C',
          store_id: '123456',
          store_name: '示範門市',
          store_address: '台北市大安區新生南路一段',
          outlying: false,
        },
      },
    );

    assert.deepEqual(
      normalizeCvsStoreSelection({ ...baseStore, store_id: '1234567' }),
      {
        ok: false,
        errors: [{ field: 'store_id', code: 'too_long' }],
      },
    );

    assert.deepEqual(
      normalizeCvsStoreSelection({ ...baseStore, store_id: '12345678' }),
      {
        ok: false,
        errors: [{ field: 'store_id', code: 'too_long' }],
      },
    );

    assert.deepEqual(
      normalizeCvsStoreSelection({ ...baseStore, store_id: '123456789' }),
      {
        ok: false,
        errors: [{ field: 'store_id', code: 'too_long' }],
      },
    );

    assert.deepEqual(
      normalizeCvsStoreSelection({ ...baseStore, store_id: '1234567890' }),
      {
        ok: false,
        errors: [{ field: 'store_id', code: 'format' }],
      },
    );

    assert.deepEqual(
      normalizeCvsStoreSelection({ ...baseStore, store_id: '12-456' }),
      {
        ok: false,
        errors: [{ field: 'store_id', code: 'format' }],
      },
    );

    assert.deepEqual(
      normalizeCvsStoreSelection({ ...baseStore, store_id: '１２３４５６' }),
      {
        ok: true,
        store: {
          sub_type: 'UNIMARTC2C',
          store_id: '123456',
          store_name: '示範門市',
          store_address: '台北市大安區新生南路一段',
          outlying: false,
        },
      },
    );

    // HILIFEC2C without outside and address 澎湖縣馬公市中正路1號 -> outlying true
    const h1 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '萊爾富澎湖店',
      store_address: '澎湖縣馬公市中正路1號',
    });
    assert.equal(h1.ok, true);
    if (h1.ok) assert.equal(h1.store.outlying, true);

    // 屏東縣琉球鄉中山路1號 -> true
    const h2 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '屏東縣琉球鄉中山路1號',
    });
    assert.equal(h2.ok, true);
    if (h2.ok) assert.equal(h2.store.outlying, true);

    // 馬公市中正路1號 -> true
    const h3 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '馬公市中正路1號',
    });
    assert.equal(h3.ok, true);
    if (h3.ok) assert.equal(h3.store.outlying, true);

    // 臺東縣綠島鄉南寮村1號 -> true
    const h4 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '臺東縣綠島鄉南寮村1號',
    });
    assert.equal(h4.ok, true);
    if (h4.ok) assert.equal(h4.store.outlying, true);

    // 金門縣金城鎮民生路1號 -> true
    const h5 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '金門縣金城鎮民生路1號',
    });
    assert.equal(h5.ok, true);
    if (h5.ok) assert.equal(h5.store.outlying, true);

    // 連江縣南竿鄉介壽村1號 -> true
    const h6 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '連江縣南竿鄉介壽村1號',
    });
    assert.equal(h6.ok, true);
    if (h6.ok) assert.equal(h6.store.outlying, true);

    // 澎湖縣 馬公市中正路1號 (a space) -> true
    const h7 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '澎湖縣 馬公市中正路1號',
    });
    assert.equal(h7.ok, true);
    if (h7.ok) assert.equal(h7.store.outlying, true);

    // 高雄市鼓山區琉球路1號 -> false
    const h8 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '高雄市鼓山區琉球路1號',
    });
    assert.equal(h8.ok, true);
    if (h8.ok) assert.equal(h8.store.outlying, false);

    // 臺北市中正區金門街1號 -> false
    const h9 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '臺北市中正區金門街1號',
    });
    assert.equal(h9.ok, true);
    if (h9.ok) assert.equal(h9.store.outlying, false);

    // HILIFEC2C with outside: '' and a mainland address -> false, no error
    const h10 = normalizeCvsStoreSelection({
      sub_type: 'HILIFEC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '台北市大安區新生南路一段',
      outside: '',
    });
    assert.equal(h10.ok, true);
    if (h10.ok) assert.equal(h10.store.outlying, false);

    // UNIMARTC2C with outside '1' and a mainland address -> true
    const u1 = normalizeCvsStoreSelection({
      sub_type: 'UNIMARTC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '台北市大安區新生南路一段',
      outside: '1',
    });
    assert.equal(u1.ok, true);
    if (u1.ok) assert.equal(u1.store.outlying, true);

    // UNIMARTC2C with outside '0' and 澎湖縣… -> false (the map value wins)
    const u2 = normalizeCvsStoreSelection({
      sub_type: 'UNIMARTC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '澎湖縣馬公市中正路1號',
      outside: '0',
    });
    assert.equal(u2.ok, true);
    if (u2.ok) assert.equal(u2.store.outlying, false);

    // FAMIC2C without outside and 澎湖縣… -> true
    const f1 = normalizeCvsStoreSelection({
      sub_type: 'FAMIC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '澎湖縣馬公市中正路1號',
    });
    assert.equal(f1.ok, true);
    if (f1.ok) assert.equal(f1.store.outlying, true);

    // outside '2' -> format
    const badOutside2 = normalizeCvsStoreSelection({
      sub_type: 'UNIMARTC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '台北市大安區新生南路一段',
      outside: '2',
    });
    assert.deepEqual(badOutside2, {
      ok: false,
      errors: [{ field: 'outside', code: 'format' }],
    });

    // outside 1 (a number) -> format
    const badOutsideNum = normalizeCvsStoreSelection({
      sub_type: 'UNIMARTC2C',
      store_id: '9999',
      store_name: '門市名',
      store_address: '台北市大安區新生南路一段',
      outside: 1,
    });
    assert.deepEqual(badOutsideNum, {
      ok: false,
      errors: [{ field: 'outside', code: 'format' }],
    });
  });
});

describe('8. Ship-by calculation', () => {
  it('verifies all 10 vectors from the §5 table', () => {
    const vectors = [
      { name: 'Monday before cutoff', ms: 1792371600000, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '15:00', handling_days: 1 }, exp: 1792511999000 },
      { name: 'Monday 1 ms before cutoff', ms: 1792393199999, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '15:00', handling_days: 1 }, exp: 1792511999000 },
      { name: 'Monday at cutoff', ms: 1792393200000, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '15:00', handling_days: 1 }, exp: 1792598399000 },
      { name: 'Friday after cutoff', ms: 1792742400000, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '15:00', handling_days: 1 }, exp: 1793116799000 },
      { name: 'Saturday', ms: 1792807200000, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '15:00', handling_days: 1 }, exp: 1793116799000 },
      { name: 'Thursday, handling_days 3', ms: 1792634400000, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '15:00', handling_days: 3 }, exp: 1793116799000 },
      { name: 'working_days [6]', ms: 1792375200000, opts: { working_days: [6], cutoff_time: '15:00', handling_days: 1 }, exp: 1793462399000 },
      { name: 'UTC date differs', ms: 1792341000000, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '15:00', handling_days: 1 }, exp: 1792511999000 },
      { name: 'cutoff 12:00, handling_days 14, year end', ms: 1798074000000, opts: { working_days: [1, 2, 3, 4, 5], cutoff_time: '12:00', handling_days: 14 }, exp: 1799855999000 },
      { name: 'all 7 days, cutoff 23:00', ms: 1792942200000, opts: { working_days: [1, 2, 3, 4, 5, 6, 7], cutoff_time: '23:00', handling_days: 1 }, exp: 1793116799000 },
    ];

    for (const v of vectors) {
      const res = computeShipBy(v.ms, v.opts);
      assert.equal(res, v.exp, `Failed on vector ${v.name}`);
    }
  });

  it('throws FulfilmentRuleError on invalid inputs', () => {
    assert.throws(
      () => computeShipBy(NaN, { working_days: [1], cutoff_time: '15:00', handling_days: 1 }),
      FulfilmentRuleError,
    );
    assert.throws(
      () => computeShipBy(1792371600000, { working_days: [], cutoff_time: '15:00', handling_days: 1 }),
      FulfilmentRuleError,
    );
    assert.throws(
      () => computeShipBy(1792371600000, { working_days: [1], cutoff_time: '24:00', handling_days: 1 }),
      FulfilmentRuleError,
    );
    assert.throws(
      () => computeShipBy(1792371600000, { working_days: [1], cutoff_time: '15:00', handling_days: 0 }),
      FulfilmentRuleError,
    );
    assert.throws(
      () => computeShipBy(1792371600000, { working_days: [1], cutoff_time: '15:00', handling_days: 15 }),
      FulfilmentRuleError,
    );
  });
});

describe('9. Tracking codes, ordering and events', () => {
  it('TSV equality: matches the official 278-row ECPay status map exactly', () => {
    const tsvContent = readFileSync(
      new URL('../../docs/platform-plan/execution/commerce/ecpay-logistics-status-map.tsv', import.meta.url),
      'utf8',
    );
    const lines = tsvContent.trim().split('\n');
    assert.equal(lines[0], 'sub_type\tcode\tecpay_message\teffect\tstate\texception');

    const dataRows = lines.slice(1).map(l => l.split('\t'));
    assert.equal(dataRows.length, 278);

    const keys = new Set<string>();
    const effectCounts = { progress: 0, exception: 0, informational: 0, ops_review: 0 };

    for (const [sub_type, code, _msg, effect, state, exception] of dataRows) {
      const key = `${sub_type}:${code}`;
      assert.equal(keys.has(key), false, `Duplicate key in TSV: ${key}`);
      keys.add(key);

      assert.ok(effect in effectCounts, `Unknown effect: ${effect}`);
      effectCounts[effect as keyof typeof effectCounts]++;

      const mapped = mapLogisticsStatus(sub_type, code);

      let expected: LogisticsStatusResult;
      switch (effect) {
        case 'progress':
          expected = {
            kind: 'progress',
            state: state as any,
            exception: (exception || null) as any,
          };
          break;
        case 'exception':
          expected = {
            kind: 'exception',
            exception: exception as any,
          };
          break;
        case 'informational':
          expected = { kind: 'informational' };
          break;
        case 'ops_review':
          expected = { kind: 'ops_review' };
          break;
        default:
          throw new Error(`Unexpected effect: ${effect}`);
      }

      assert.deepEqual(mapped, expected, `Mismatch for ${key}`);
    }

    assert.deepEqual(effectCounts, {
      progress: 143,
      exception: 115,
      informational: 9,
      ops_review: 11,
    });
  });

  it('Nothing extra: returns unmapped for codes 0..9999 not in TSV and invalid inputs', () => {
    const tsvContent = readFileSync(
      new URL('../../docs/platform-plan/execution/commerce/ecpay-logistics-status-map.tsv', import.meta.url),
      'utf8',
    );
    const dataRows = tsvContent.trim().split('\n').slice(1).map(l => l.split('\t'));
    const tsvKeys = new Set(dataRows.map(([sub_type, code]) => `${sub_type}:${code}`));

    const subtypes = ['UNIMARTC2C', 'FAMIC2C', 'HILIFEC2C', 'TCAT', 'POST'] as const;
    for (const st of subtypes) {
      for (let i = 0; i < 10000; i++) {
        const code = String(i);
        if (!tsvKeys.has(`${st}:${code}`)) {
          assert.deepEqual(mapLogisticsStatus(st, code), { kind: 'unmapped' });
        }
      }
    }

    // UNIMART / FAMI / HILIFE / UNIMARTFREEZE with 300 and 2030 -> unmapped
    for (const st of ['UNIMART', 'FAMI', 'HILIFE', 'UNIMARTFREEZE']) {
      assert.deepEqual(mapLogisticsStatus(st, '300'), { kind: 'unmapped' });
      assert.deepEqual(mapLogisticsStatus(st, '2030'), { kind: 'unmapped' });
    }

    // Unknown subtype
    assert.deepEqual(mapLogisticsStatus('UNKNOWN', '300'), { kind: 'unmapped' });

    // Non-string subtype/code
    assert.deepEqual(mapLogisticsStatus(123, '300'), { kind: 'unmapped' });
    assert.deepEqual(mapLogisticsStatus('UNIMARTC2C', null), { kind: 'unmapped' });
    assert.deepEqual(mapLogisticsStatus(null, '300'), { kind: 'unmapped' });
    assert.deepEqual(mapLogisticsStatus('UNIMARTC2C', 300), { kind: 'unmapped' });

    // Weird codes
    for (const badCode of ['', ' 300', '300 ', '+300', '3e2', '0300', '123456789']) {
      assert.deepEqual(mapLogisticsStatus('UNIMARTC2C', badCode), { kind: 'unmapped' });
    }
  });

  it('Same code, different meaning across subtypes', () => {
    // TCAT/5004 -> progress returning
    assert.deepEqual(mapLogisticsStatus('TCAT', '5004'), {
      kind: 'progress',
      state: 'returning',
      exception: null,
    });
    // HILIFEC2C/5004 -> exception carrier_attention
    assert.deepEqual(mapLogisticsStatus('HILIFEC2C', '5004'), {
      kind: 'exception',
      exception: 'carrier_attention',
    });
    // HILIFEC2C/7003 -> exception carrier_attention
    assert.deepEqual(mapLogisticsStatus('HILIFEC2C', '7003'), {
      kind: 'exception',
      exception: 'carrier_attention',
    });
    // TCAT/7003 -> exception recipient_address_invalid
    assert.deepEqual(mapLogisticsStatus('TCAT', '7003'), {
      kind: 'exception',
      exception: 'recipient_address_invalid',
    });
  });

  it('applyTrackingState: applies monotonicity rules and record_handover', () => {
    // Keep existing rule tests updated for record_handover:
    // create_unknown -> created advance (record_handover false, order 1 -> 2)
    assert.deepEqual(applyTrackingState('create_unknown', 'created'), {
      next: 'created',
      change: 'advance',
      record_handover: false,
    });

    // created -> in_transit advance (record_handover true, order 2 -> 4)
    assert.deepEqual(applyTrackingState('created', 'in_transit'), {
      next: 'in_transit',
      change: 'advance',
      record_handover: true,
    });

    // handed_over -> in_transit advance (record_handover false, order 3 -> 4)
    assert.deepEqual(applyTrackingState('handed_over', 'in_transit'), {
      next: 'in_transit',
      change: 'advance',
      record_handover: false,
    });

    // Example 1: ready_for_pickup -> late in_transit = ignore_older
    assert.deepEqual(applyTrackingState('ready_for_pickup', 'in_transit'), {
      next: 'ready_for_pickup',
      change: 'ignore_older',
      record_handover: false,
    });

    // Example 2: ready_for_pickup -> returning = advance
    assert.deepEqual(applyTrackingState('ready_for_pickup', 'returning'), {
      next: 'returning',
      change: 'advance',
      record_handover: false,
    });

    // ready_for_pickup -> returned advance
    assert.deepEqual(applyTrackingState('ready_for_pickup', 'returned'), {
      next: 'returned',
      change: 'advance',
      record_handover: false,
    });

    // Example 3: delivered -> returning = contradiction
    assert.deepEqual(applyTrackingState('delivered', 'returning'), {
      next: 'delivered',
      change: 'contradiction',
      record_handover: false,
    });

    // Example 4: returning -> delivered = contradiction
    assert.deepEqual(applyTrackingState('returning', 'delivered'), {
      next: 'returning',
      change: 'contradiction',
      record_handover: false,
    });

    // returned -> ready_for_pickup ignore_older
    assert.deepEqual(applyTrackingState('returned', 'ready_for_pickup'), {
      next: 'returned',
      change: 'ignore_older',
      record_handover: false,
    });

    // returned -> returning ignore_older
    assert.deepEqual(applyTrackingState('returned', 'returning'), {
      next: 'returned',
      change: 'ignore_older',
      record_handover: false,
    });

    // returning -> returned advance
    assert.deepEqual(applyTrackingState('returning', 'returned'), {
      next: 'returned',
      change: 'advance',
      record_handover: false,
    });

    // voided -> contradiction
    assert.deepEqual(applyTrackingState('voided', 'created'), {
      next: 'voided',
      change: 'contradiction',
      record_handover: false,
    });

    // incoming === current -> none
    assert.deepEqual(applyTrackingState('in_transit', 'in_transit'), {
      next: 'in_transit',
      change: 'none',
      record_handover: false,
    });

    // Additional tests specified:
    // created + handed_over -> true
    assert.deepEqual(applyTrackingState('created', 'handed_over'), {
      next: 'handed_over',
      change: 'advance',
      record_handover: true,
    });

    // draft + returning -> true
    assert.deepEqual(applyTrackingState('draft', 'returning'), {
      next: 'returning',
      change: 'advance',
      record_handover: true,
    });

    // create_unknown + created -> false
    assert.deepEqual(applyTrackingState('create_unknown', 'created'), {
      next: 'created',
      change: 'advance',
      record_handover: false,
    });

    // handed_over + in_transit -> false
    assert.deepEqual(applyTrackingState('handed_over', 'in_transit'), {
      next: 'in_transit',
      change: 'advance',
      record_handover: false,
    });

    // Invalid incoming throws
    assert.throws(() => applyTrackingState('created', 'draft' as any), FulfilmentRuleError);
    assert.throws(() => applyTrackingState('created', 'voided' as any), FulfilmentRuleError);
  });

  it('applyLogisticsEvent: handles events per §6.4 exception rules and state machine', () => {
    // 1. UNIMARTC2C/2074 at ready_for_pickup, nothing open -> returning, advance, open uncollected; with ['uncollected'] open -> open_exception null
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2074',
        current: 'ready_for_pickup',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'returning', exception: 'uncollected' },
        next: 'returning',
        change: 'advance',
        record_handover: false,
        open_exception: 'uncollected',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2074',
        current: 'ready_for_pickup',
        open_exception_kinds: ['uncollected'],
      }),
      {
        status: { kind: 'progress', state: 'returning', exception: 'uncollected' },
        next: 'returning',
        change: 'advance',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );

    // 2. FAMIC2C/7016 at in_transit, nothing open -> returning, open carrier_attention; with ['pickup_store_closed'] open -> null
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '7016',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'returning', exception: null },
        next: 'returning',
        change: 'advance',
        record_handover: false,
        open_exception: 'carrier_attention',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '7016',
        current: 'in_transit',
        open_exception_kinds: ['pickup_store_closed'],
      }),
      {
        status: { kind: 'progress', state: 'returning', exception: null },
        next: 'returning',
        change: 'advance',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );

    // 3. UNIMARTC2C/2070 at returning, nothing open -> returned, advance, null (already returning)
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2070',
        current: 'returning',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'returned', exception: null },
        next: 'returned',
        change: 'advance',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );

    // 4. UNIMARTC2C/2072 at created, nothing open -> returned, record_handover true, open carrier_attention
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2072',
        current: 'created',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'returned', exception: null },
        next: 'returned',
        change: 'advance',
        record_handover: true,
        open_exception: 'carrier_attention',
        daily_review: false,
      },
    );

    // 5. UNIMARTC2C/2068 at created -> handed_over, record_handover true, null
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2068',
        current: 'created',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'handed_over', exception: null },
        next: 'handed_over',
        change: 'advance',
        record_handover: true,
        open_exception: null,
        daily_review: false,
      },
    );

    // 6. UNIMARTC2C/2074 at delivered -> contradiction, next delivered, open contradicting_event
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2074',
        current: 'delivered',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'returning', exception: 'uncollected' },
        next: 'delivered',
        change: 'contradiction',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );

    // 7. FAMIC2C/3022 at returning -> contradiction, open contradicting_event
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '3022',
        current: 'returning',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'delivered', exception: null },
        next: 'returning',
        change: 'contradiction',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );

    // 8. At voided: FAMIC2C/3024 -> contradicting_event; FAMIC2C/7006 -> contradicting_event; UNIMARTC2C/2062 -> nothing
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '3024',
        current: 'voided',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'in_transit', exception: null },
        next: 'voided',
        change: 'contradiction',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '7006',
        current: 'voided',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'lost' },
        next: 'voided',
        change: 'none',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2062',
        current: 'voided',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'informational' },
        next: 'voided',
        change: 'none',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );

    // 9. UNIMARTC2C/2030 at ready_for_pickup -> ignore_older, nothing; at in_transit -> none, nothing
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2030',
        current: 'ready_for_pickup',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'in_transit', exception: null },
        next: 'ready_for_pickup',
        change: 'ignore_older',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2030',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'in_transit', exception: null },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );

    // 10. UNIMARTC2C/2092 (pickup_store_closed): opened at created, handed_over, in_transit, ready_for_pickup;
    // nothing at draft, creating, create_unknown, create_failed, returning, returned;
    // contradicting_event at delivered
    for (const st of ['created', 'handed_over', 'in_transit', 'ready_for_pickup'] as const) {
      assert.deepEqual(
        applyLogisticsEvent({
          sub_type: 'UNIMARTC2C',
          rtn_code: '2092',
          current: st,
          open_exception_kinds: [],
        }),
        {
          status: { kind: 'exception', exception: 'pickup_store_closed' },
          next: st,
          change: 'none',
          record_handover: false,
          open_exception: 'pickup_store_closed',
          daily_review: false,
        },
      );
    }
    for (const st of [
      'draft',
      'creating',
      'create_unknown',
      'create_failed',
      'returning',
      'returned',
    ] as const) {
      assert.deepEqual(
        applyLogisticsEvent({
          sub_type: 'UNIMARTC2C',
          rtn_code: '2092',
          current: st,
          open_exception_kinds: [],
        }),
        {
          status: { kind: 'exception', exception: 'pickup_store_closed' },
          next: st,
          change: 'none',
          record_handover: false,
          open_exception: null,
          daily_review: false,
        },
      );
    }
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2092',
        current: 'delivered',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'pickup_store_closed' },
        next: 'delivered',
        change: 'none',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );

    // 11. TCAT/3008 (recipient_address_invalid): the same pattern as 10
    for (const st of ['created', 'handed_over', 'in_transit', 'ready_for_pickup'] as const) {
      assert.deepEqual(
        applyLogisticsEvent({
          sub_type: 'TCAT',
          rtn_code: '3008',
          current: st,
          open_exception_kinds: [],
        }),
        {
          status: { kind: 'exception', exception: 'recipient_address_invalid' },
          next: st,
          change: 'none',
          record_handover: false,
          open_exception: 'recipient_address_invalid',
          daily_review: false,
        },
      );
    }
    for (const st of [
      'draft',
      'creating',
      'create_unknown',
      'create_failed',
      'returning',
      'returned',
    ] as const) {
      assert.deepEqual(
        applyLogisticsEvent({
          sub_type: 'TCAT',
          rtn_code: '3008',
          current: st,
          open_exception_kinds: [],
        }),
        {
          status: { kind: 'exception', exception: 'recipient_address_invalid' },
          next: st,
          change: 'none',
          record_handover: false,
          open_exception: null,
          daily_review: false,
        },
      );
    }
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'TCAT',
        rtn_code: '3008',
        current: 'delivered',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'recipient_address_invalid' },
        next: 'delivered',
        change: 'none',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );

    // 12. FAMIC2C/7006 (lost): opened at in_transit and at returning; contradicting_event at delivered; null when lost is already open
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '7006',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'lost' },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: 'lost',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '7006',
        current: 'returning',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'lost' },
        next: 'returning',
        change: 'none',
        record_handover: false,
        open_exception: 'lost',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '7006',
        current: 'delivered',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'lost' },
        next: 'delivered',
        change: 'none',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'FAMIC2C',
        rtn_code: '7006',
        current: 'in_transit',
        open_exception_kinds: ['lost'],
      }),
      {
        status: { kind: 'exception', exception: 'lost' },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );

    // 13. TCAT/3016 at in_transit -> open contradicting_event
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'TCAT',
        rtn_code: '3016',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'contradicting_event' },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: 'contradicting_event',
        daily_review: false,
      },
    );

    // 14. TCAT/5004 at in_transit, nothing open -> returning, open carrier_attention;
    // HILIFEC2C/5004 at in_transit -> state unchanged, open carrier_attention
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'TCAT',
        rtn_code: '5004',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'progress', state: 'returning', exception: null },
        next: 'returning',
        change: 'advance',
        record_handover: false,
        open_exception: 'carrier_attention',
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'HILIFEC2C',
        rtn_code: '5004',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'exception', exception: 'carrier_attention' },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: 'carrier_attention',
        daily_review: false,
      },
    );

    // 15. UNIMARTC2C/2062 -> informational, nothing, daily_review false;
    // UNIMARTC2C/2069 -> daily_review true;
    // UNIMART/2030 -> unmapped, daily_review true
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2062',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'informational' },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: null,
        daily_review: false,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMARTC2C',
        rtn_code: '2069',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'ops_review' },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: null,
        daily_review: true,
      },
    );
    assert.deepEqual(
      applyLogisticsEvent({
        sub_type: 'UNIMART',
        rtn_code: '2030',
        current: 'in_transit',
        open_exception_kinds: [],
      }),
      {
        status: { kind: 'unmapped' },
        next: 'in_transit',
        change: 'none',
        record_handover: false,
        open_exception: null,
        daily_review: true,
      },
    );

    // 16. The §6.4 chain at ready_for_pickup: UNIMARTC2C/2030 (ignore) -> UNIMARTC2C/2074 (advance to returning, open uncollected)
    const step1 = applyLogisticsEvent({
      sub_type: 'UNIMARTC2C',
      rtn_code: '2030',
      current: 'ready_for_pickup',
      open_exception_kinds: [],
    });
    assert.deepEqual(step1, {
      status: { kind: 'progress', state: 'in_transit', exception: null },
      next: 'ready_for_pickup',
      change: 'ignore_older',
      record_handover: false,
      open_exception: null,
      daily_review: false,
    });
    const step2 = applyLogisticsEvent({
      sub_type: 'UNIMARTC2C',
      rtn_code: '2074',
      current: step1.next,
      open_exception_kinds: [],
    });
    assert.deepEqual(step2, {
      status: { kind: 'progress', state: 'returning', exception: 'uncollected' },
      next: 'returning',
      change: 'advance',
      record_handover: false,
      open_exception: 'uncollected',
      daily_review: false,
    });

    // 17. Throws: current: 'shipped'; open_exception_kinds not an array, [''], [1], 33 entries; a non-object input. No throw for sub_type: 5, rtn_code: null (-> unmapped).
    assert.throws(
      () =>
        applyLogisticsEvent({
          sub_type: 'UNIMARTC2C',
          rtn_code: '2030',
          current: 'shipped' as any,
          open_exception_kinds: [],
        }),
      FulfilmentRuleError,
    );
    assert.throws(
      () =>
        applyLogisticsEvent({
          sub_type: 'UNIMARTC2C',
          rtn_code: '2030',
          current: 'created',
          open_exception_kinds: 'none' as any,
        }),
      FulfilmentRuleError,
    );
    assert.throws(
      () =>
        applyLogisticsEvent({
          sub_type: 'UNIMARTC2C',
          rtn_code: '2030',
          current: 'created',
          open_exception_kinds: [''],
        }),
      FulfilmentRuleError,
    );
    assert.throws(
      () =>
        applyLogisticsEvent({
          sub_type: 'UNIMARTC2C',
          rtn_code: '2030',
          current: 'created',
          open_exception_kinds: [1 as any],
        }),
      FulfilmentRuleError,
    );
    assert.throws(
      () =>
        applyLogisticsEvent({
          sub_type: 'UNIMARTC2C',
          rtn_code: '2030',
          current: 'created',
          open_exception_kinds: Array.from({ length: 33 }, (_, i) => `e${i}`),
        }),
      FulfilmentRuleError,
    );
    assert.throws(() => applyLogisticsEvent(null as any), FulfilmentRuleError);
    assert.throws(() => applyLogisticsEvent('input' as any), FulfilmentRuleError);
    assert.throws(() => applyLogisticsEvent([] as any), FulfilmentRuleError);

    // No throw for sub_type: 5, rtn_code: null (-> unmapped)
    const noThrow = applyLogisticsEvent({
      sub_type: 5,
      rtn_code: null,
      current: 'created',
      open_exception_kinds: [],
    });
    assert.deepEqual(noThrow, {
      status: { kind: 'unmapped' },
      next: 'created',
      change: 'none',
      record_handover: false,
      open_exception: null,
      daily_review: true,
    });
  });
});

describe('10. Immutability / Frozen results', () => {
  function assertNoFrozenObjects(val: unknown, seen = new Set<unknown>()): void {
    if (val === null || typeof val !== 'object') return;
    if (seen.has(val)) return;
    seen.add(val);
    assert.equal(Object.isFrozen(val), false, `Object should not be frozen: ${JSON.stringify(val)}`);
    if (Array.isArray(val)) {
      for (const item of val) {
        assertNoFrozenObjects(item, seen);
      }
    } else {
      for (const value of Object.values(val)) {
        assertNoFrozenObjects(value, seen);
      }
    }
  }

  it('never freezes caller inputs and avoids aliasing caller arrays', () => {
    // 1. planDelivery & availableMethods
    const profile = makeProfile('shop-s', [makeService()]);
    const planInput: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: [
        { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
      ],
      profiles: { 'shop-s': profile },
      lines: [makeLine('l1')],
      merchandise_net_minor: 10000,
      destination: { outlying: false },
    };

    const planRes = planDelivery(planInput, 'home');
    assertNoFrozenObjects(planInput);

    // After planDelivery, push a day onto input working_days and assert result's working_days did not change
    if (planRes.kind === 'plan') {
      const initialWorkingDays = [...planRes.groups[0].working_days];
      (profile.working_days as number[]).push(6);
      assert.deepEqual(planRes.groups[0].working_days, initialWorkingDays);
      assert.equal(planRes.groups[0].working_days.includes(6), false);
    }

    const availableRes = availableMethods(planInput);
    assertNoFrozenObjects(planInput);

    // 2. validateHomeRecipient
    const homeInput = {
      name: '王小明',
      mobile: '0912345678',
      postal_code: '100',
      address: '台北市中正區重慶南路一段',
    };
    validateHomeRecipient(homeInput);
    assertNoFrozenObjects(homeInput);

    // 3. validateCvsRecipient
    const cvsInput = {
      name: '王小明',
      mobile: '0912345678',
    };
    validateCvsRecipient(cvsInput);
    assertNoFrozenObjects(cvsInput);

    // 4. normalizeCvsStoreSelection
    const storeInput = {
      sub_type: 'UNIMARTC2C',
      store_id: '131386',
      store_name: '門市名稱',
      store_address: '台北市大安區新生南路一段',
      outside: '0',
    };
    normalizeCvsStoreSelection(storeInput);
    assertNoFrozenObjects(storeInput);

    // 5. computeShipBy
    const shipByOptions = {
      working_days: [1, 2, 3, 4, 5],
      cutoff_time: '15:00',
      handling_days: 2,
    };
    computeShipBy(1792371600000, shipByOptions);
    assertNoFrozenObjects(shipByOptions);

    // 6. applyLogisticsEvent
    const eventInput = {
      sub_type: 'UNIMARTC2C',
      rtn_code: '2074',
      current: 'ready_for_pickup' as const,
      open_exception_kinds: ['carrier_attention'],
    };
    applyLogisticsEvent(eventInput);
    assertNoFrozenObjects(eventInput);
  });

  it('throws in strict mode when attempting to mutate nested result objects and arrays', () => {
    const profile = makeProfile('shop-s', [makeService()]);
    const input: PlanInput = {
      seller_shop_id: 'shop-s',
      delivery_options: [
        { method: 'home', fee_per_parcel_minor: 10000, free_over_minor: null, outlying: { kind: 'excluded' } },
      ],
      profiles: { 'shop-s': profile },
      lines: [makeLine('l1')],
      merchandise_net_minor: 10000,
      destination: { outlying: false },
    };

    const res = planDelivery(input, 'home');
    assert.equal(res.kind, 'plan');
    if (res.kind === 'plan') {
      assert.ok(Object.isFrozen(res));
      assert.ok(Object.isFrozen(res.groups));
      assert.ok(Object.isFrozen(res.groups[0]));
      assert.ok(Object.isFrozen(res.groups[0].working_days));
      assert.ok(Object.isFrozen(res.groups[0].parcels));
      assert.ok(Object.isFrozen(res.groups[0].parcels[0]));
      assert.ok(Object.isFrozen(res.groups[0].parcels[0].lines));
      assert.ok(Object.isFrozen(res.groups[0].parcels[0].lines[0]));

      assert.throws(() => {
        (res.groups[0].parcels as any).push({});
      }, TypeError);

      assert.throws(() => {
        (res.groups[0] as any).group_ref = 'g99';
      }, TypeError);
    }

    const recipient = validateHomeRecipient({
      name: '王小明',
      mobile: '0912345678',
      postal_code: '100',
      address: '台北市中正區重慶南路一段',
    });
    assert.ok(recipient.ok);
    if (recipient.ok) {
      assert.ok(Object.isFrozen(recipient));
      assert.ok(Object.isFrozen(recipient.recipient));
      assert.throws(() => {
        (recipient.recipient as any).name = '王大明';
      }, TypeError);
    }
  });

  it('freezes ECPAY_LOGISTICS_STATUS_TABLE and every entry, preserving mapLogisticsStatus behavior', () => {
    assert.equal(Object.isFrozen(ECPAY_LOGISTICS_STATUS_TABLE), true);
    assert.ok(ECPAY_LOGISTICS_STATUS_TABLE.length > 0);
    for (const entry of ECPAY_LOGISTICS_STATUS_TABLE) {
      assert.equal(Object.isFrozen(entry), true);
    }

    assert.throws(() => {
      (ECPAY_LOGISTICS_STATUS_TABLE[0] as any).state = 'delivered';
    }, TypeError);

    // mapLogisticsStatus results for existing codes are unchanged
    assert.deepEqual(mapLogisticsStatus('UNIMARTC2C', '300'), {
      kind: 'progress',
      state: 'created',
      exception: null,
    });
    assert.deepEqual(mapLogisticsStatus('TCAT', '5004'), {
      kind: 'progress',
      state: 'returning',
      exception: null,
    });
    assert.deepEqual(mapLogisticsStatus('HILIFEC2C', '5004'), {
      kind: 'exception',
      exception: 'carrier_attention',
    });
    assert.deepEqual(mapLogisticsStatus('HILIFEC2C', '7003'), {
      kind: 'exception',
      exception: 'carrier_attention',
    });
    assert.deepEqual(mapLogisticsStatus('TCAT', '7003'), {
      kind: 'exception',
      exception: 'recipient_address_invalid',
    });
    assert.deepEqual(mapLogisticsStatus('UNIMARTC2C', '2042'), {
      kind: 'exception',
      exception: 'lost',
    });
  });
});
