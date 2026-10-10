import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {checkVersion, digest} from '../../../packages/db/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import {SupplyOfferSchema, SupplyOffersSchema, SupplyOfferTermsSchema, DistributionInputSchema, DistributionDecisionSchema,
  DistributionSchema, DistributionsSchema, type SupplyOffer} from '../../../contracts/guild-launchpad/v1/hosted-distribution.js';
import type {Actor} from '../../identity-membership/service.js';
import {resellerArrangement} from '../distribution.js';
import {profile, ready, productCount, storeRead, storeCommand, storeFact, type Profile} from './store.js';

function offerView(row: Record<string, any>): SupplyOffer {
  return SupplyOfferSchema.parse({offer_id: row.offer_id, product_id: row.item_id, supplier_name: row.supplier_name,
    source_version: String(row.source_version), terms: row.terms, terms_sha256: row.terms_sha256, state: row.state, version: String(row.version)});
}
export async function listSupplyOffers(pool: Pool, actor: Actor, tenantId: string, instanceId: string, own = false) {
  return storeRead(pool, actor, tenantId, instanceId, 'store:write', async (q, context) => {
    const p = await profile(q, tenantId, instanceId); ready(p);
    const rows = (await q.query(`SELECT * FROM commerce_hosted_supply_offers WHERE community_id=$1
      AND state='offered' AND ($2::boolean AND instance_id=$3 OR NOT $2::boolean AND instance_id<>$3 AND terms->>'currency'=$4)
      ORDER BY offer_id LIMIT 101`, [context.community_id, own, instanceId, p.currency])).rows;
    return SupplyOffersSchema.parse({items: rows.slice(0, 100).map(offerView), truncated: rows.length>100});
  });
}
/** Publish only the named product's explicit supply allowlist. Saving private terms
 * never enters this member-visible catalog, and publishing does not accept a seller. */
export async function publishSupplyOffer(pool: Pool, actor: Actor, tenantId: string, instanceId: string, productId: string, key: string, expected: string) {
  return storeCommand(pool, actor, tenantId, instanceId, ['store:write','store:publish'], 'storefront.supply-offer.publish', {}, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const row = (await q.query(`SELECT i.*,l.aggregate_version::text AS version FROM commerce_items i
      JOIN commerce_selections l USING(item_id) WHERE i.item_id=$1 AND i.shop_id=$2 AND l.shop_id=$3 AND l.hosted_offer_id IS NULL`,
    [productId, p.supply_shop_id, p.storefront_shop_id])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這項商品。'); checkVersion(row.version, expected);
    const terms = SupplyOfferTermsSchema.parse({title: row.title, description: row.description, currency: p.currency,
      cost_minor: Number(row.price_minor), shipping_minor: Number(row.shipping_minor), shipping_terms: row.shipping_terms, return_terms: row.return_terms});
    const hash = digest(terms);
    const prior = (await q.query(`SELECT * FROM commerce_hosted_supply_offers WHERE item_id=$1 AND state='offered'`, [productId])).rows[0];
    if (prior && prior.terms_sha256===hash) return offerView(prior);
    if (prior) {
      await q.query(`UPDATE commerce_hosted_supply_offers SET state='withdrawn',version=version+1 WHERE offer_id=$1`, [prior.offer_id]);
      await storeFact(q, context, prior.offer_id, String(BigInt(prior.version)+1n), 'storefront.supply-offer.publish', 'hosted_supply_offer');
    }
    const id = randomUUID();
    const saved = (await q.query(`INSERT INTO commerce_hosted_supply_offers(offer_id,tenant_id,instance_id,item_id,community_id,supplier_name,source_version,terms,terms_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, tenantId, instanceId, productId, context.community_id, p.name, row.version, terms, hash])).rows[0];
    await storeFact(q, context, id, '1', 'storefront.supply-offer.publish', 'hosted_supply_offer');
    return offerView(saved);
  }, productId);
}
export async function withdrawSupplyOffer(pool: Pool, actor: Actor, tenantId: string, instanceId: string, offerId: string, key: string, expected: string) {
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.supply-offer.withdraw', {}, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const row = (await q.query(`SELECT * FROM commerce_hosted_supply_offers WHERE offer_id=$1 AND tenant_id=$2 AND instance_id=$3 FOR UPDATE`, [offerId, tenantId, instanceId])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這份供貨版本。'); checkVersion(String(row.version), expected);
    if (row.state==='withdrawn') return offerView(row);
    const saved = (await q.query(`UPDATE commerce_hosted_supply_offers SET state='withdrawn',version=version+1 WHERE offer_id=$1 RETURNING *`, [offerId])).rows[0];
    await storeFact(q, context, offerId, String(saved.version), 'storefront.supply-offer.withdraw', 'hosted_supply_offer');
    return offerView(saved);
  }, offerId);
}

async function selections(q: PoolClient, p: Profile, supplier: boolean, selectionId?: string) {
  return (await q.query(`SELECT l.selection_id,l.hosted_sku,l.retail_price_minor,l.snapshot,l.listing_sha256,l.acceptance_state,
      l.aggregate_version::text AS selection_version,s.name AS seller_name,s.owner_id AS seller_user_id,ss.owner_id AS supplier_user_id,o.*
    FROM commerce_selections l JOIN commerce_hosted_supply_offers o ON o.offer_id=l.hosted_offer_id AND o.item_id=l.item_id
    JOIN commerce_shops s ON s.shop_id=l.shop_id AND s.origin='hosted'
    JOIN commerce_storefront_profiles source ON source.instance_id=o.instance_id AND source.tenant_id=o.tenant_id
    JOIN commerce_shops ss ON ss.shop_id=source.supply_shop_id AND ss.origin='hosted'
    WHERE ($2::boolean AND o.tenant_id=$3 AND o.instance_id=$4 OR NOT $2::boolean AND l.shop_id=$1)
      AND ($5::uuid IS NULL OR l.selection_id=$5) ORDER BY l.selection_id LIMIT 201`,
  [p.storefront_shop_id, supplier, p.tenant_id, p.instance_id, selectionId ?? null])).rows;
}
function selectionView(row: Record<string, any>) {
  return DistributionSchema.parse({selection_id: row.selection_id, offer: offerView(row), sku: row.hosted_sku,
    seller_name: row.seller_name, retail_price_minor: Number(row.retail_price_minor), state: row.acceptance_state,
    listing_sha256: row.listing_sha256, version: row.selection_version});
}
export async function listDistributions(pool: Pool, actor: Actor, tenantId: string, instanceId: string, supplier = false) {
  return storeRead(pool, actor, tenantId, instanceId, 'store:write', async q => {
    const p = await profile(q, tenantId, instanceId); ready(p);
    const rows = await selections(q, p, supplier);
    return DistributionsSchema.parse({items: rows.slice(0, 200).map(selectionView), truncated: rows.length>200});
  });
}
/** A seller proposes its own retail price against one immutable offer. Supplier
 * consent always covers that exact listing digest; changing price clears consent. */
export async function proposeDistribution(pool: Pool, actor: Actor, tenantId: string, instanceId: string, raw: unknown, key: string, selectionId?: string, expected?: string) {
  const input = DistributionInputSchema.parse(raw);
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.distribution.propose', input, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const offer = (await q.query(`SELECT o.*,s.owner_id AS supplier_user_id FROM commerce_hosted_supply_offers o
      JOIN commerce_storefront_profiles p ON p.instance_id=o.instance_id AND p.tenant_id=o.tenant_id
      JOIN commerce_shops s ON s.shop_id=p.supply_shop_id AND s.origin='hosted'
      WHERE offer_id=$1 AND o.community_id=$2 AND o.instance_id<>$3 AND state='offered'`, [input.offer_id, context.community_id, instanceId])).rows[0];
    requireCondition(offer, 404, 'supply_offer_not_found', '找不到可選用的供貨版本。');
    requireCondition(offer.terms_sha256===input.terms_sha256 && offer.terms.currency===p.currency, 409, 'supply_offer_changed', '請重新確認供貨版本與幣別。');
    const prior = selectionId ? (await selections(q, p, false, selectionId))[0] : null;
    if (selectionId) { requireCondition(prior, 404, 'not_found', '找不到這項選品。'); checkVersion(prior.selection_version, expected); }
    const duplicate = (await q.query('SELECT selection_id FROM commerce_selections WHERE shop_id=$1 AND item_id=$2', [p.storefront_shop_id, offer.item_id])).rows[0];
    requireCondition(!duplicate || duplicate.selection_id===selectionId, 409, 'distribution_exists', '這項商品已經選用，請編輯原選品。');
    // A selection keeps its product identity; use a new selection for another item.
    requireCondition(!prior || prior.item_id===offer.item_id, 409, 'distribution_item_changed', '原選品不能改成另一項商品。');
    requireCondition(prior || await productCount(q, p)<200, 409, 'storefront_product_limit', '商品已達上限。');
    const seller = (await q.query('SELECT owner_id FROM commerce_shops WHERE shop_id=$1', [p.storefront_shop_id])).rows[0];
    const sku = prior?.hosted_sku ?? `P${String(p.product_seq+1).padStart(4, '0')}`;
    const snapshot = {...offer.terms, sku, offer_id: offer.offer_id, offer_sha256: offer.terms_sha256,
      seller_shop_id: p.storefront_shop_id, item_id: offer.item_id,
      retail_price_minor: input.retail_price_minor, arrangement: resellerArrangement(seller.owner_id, offer.supplier_user_id)};
    const hash = digest(snapshot), id = selectionId ?? randomUUID();
    if (prior) await q.query(`UPDATE commerce_selections SET hosted_offer_id=$2,retail_price_minor=$3,snapshot=$4,listing_sha256=$5,
      acceptance_state='awaiting_supply_acceptance',current_acceptance_id=NULL,aggregate_version=aggregate_version+1 WHERE selection_id=$1`,
    [id, offer.offer_id, input.retail_price_minor, snapshot, hash]);
    else {
      await q.query('UPDATE commerce_storefront_profiles SET product_seq=product_seq+1 WHERE instance_id=$1', [instanceId]);
      await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,hosted_offer_id,hosted_sku)
        VALUES($1,$2,$3,$4,'交易尚未啟用。',$5,$6,$7,$8)`, [id, p.storefront_shop_id, offer.item_id, input.retail_price_minor, snapshot, hash, offer.offer_id, sku]);
    }
    const saved = (await selections(q, p, false, id))[0];
    await storeFact(q, context, id, saved.selection_version, 'storefront.distribution.propose', 'hosted_distribution');
    return selectionView(saved);
  }, selectionId);
}
export async function decideDistribution(pool: Pool, actor: Actor, tenantId: string, instanceId: string, selectionId: string, raw: unknown, key: string, expected: string) {
  const input = DistributionDecisionSchema.parse(raw);
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.distribution.decide', input, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const row = (await selections(q, p, true, selectionId))[0];
    requireCondition(row, 404, 'not_found', '找不到這項供貨申請。'); checkVersion(row.selection_version, expected);
    requireCondition(row.listing_sha256===input.listing_sha256 && digest(row.snapshot)===input.listing_sha256,
      409, 'snapshot_changed', '售價或供貨條件已變更，請重新確認。');
    requireCondition(input.decision==='revoked' ? row.acceptance_state==='sellable' : row.acceptance_state==='awaiting_supply_acceptance' && row.state==='offered',
      409, 'invalid_state', '供貨狀態已改變，請重新確認。');
    const id = randomUUID(), state = input.decision==='accepted' ? 'sellable' : input.decision;
    await q.query(`INSERT INTO commerce_distribution_acceptances(acceptance_id,selection_id,community_id,supplier_user_id,seller_user_id,listing_sha256,decision,signer_user_id,signed_digest,arrangement)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9)`, [id, selectionId, context.community_id, row.supplier_user_id, row.seller_user_id, input.listing_sha256, input.decision, actor.user_id, row.snapshot.arrangement]);
    await q.query(`UPDATE commerce_selections SET acceptance_state=$2,current_acceptance_id=$3,aggregate_version=aggregate_version+1 WHERE selection_id=$1`, [selectionId, state, id]);
    const saved = (await selections(q, p, true, selectionId))[0];
    await storeFact(q, context, selectionId, saved.selection_version, 'storefront.distribution.decide', 'hosted_distribution');
    return selectionView(saved);
  }, selectionId);
}

/** Seller withdrawal is its own fact, never a forged supplier signature. */
export async function withdrawDistribution(pool: Pool, actor: Actor, tenantId: string, instanceId: string, selectionId: string, key: string, expected: string) {
  return storeCommand(pool, actor, tenantId, instanceId, 'store:write', 'storefront.distribution.withdraw', {}, key, expected, async (q, context) => {
    const p = await profile(q, tenantId, instanceId, true); ready(p);
    const row = (await selections(q, p, false, selectionId))[0];
    requireCondition(row, 404, 'not_found', '找不到這項選品。'); checkVersion(row.selection_version, expected);
    if (row.acceptance_state==='revoked') return selectionView(row);
    await q.query(`UPDATE commerce_selections SET acceptance_state='revoked',aggregate_version=aggregate_version+1 WHERE selection_id=$1`, [selectionId]);
    const saved = (await selections(q, p, false, selectionId))[0];
    await storeFact(q, context, selectionId, saved.selection_version, 'storefront.distribution.withdraw', 'hosted_distribution');
    return selectionView(saved);
  }, selectionId);
}

/** Publication receives only authorized text and the seller's price. No supplier
 * draft media, costs, tenant IDs or authority grants enter the public projection. */
export async function distributionProducts(q: PoolClient, p: Profile) {
  const rows = (await q.query(`SELECT l.item_id,l.hosted_sku,l.snapshot,l.retail_price_minor,l.aggregate_version::text AS version
    FROM commerce_selections l JOIN commerce_hosted_supply_offers o ON o.offer_id=l.hosted_offer_id AND o.item_id=l.item_id
    JOIN commerce_distribution_acceptances a ON a.acceptance_id=l.current_acceptance_id AND a.selection_id=l.selection_id
    WHERE l.shop_id=$1 AND o.state='offered' AND l.acceptance_state='sellable' AND a.decision='accepted'
      AND a.listing_sha256=l.listing_sha256 AND l.snapshot->>'offer_sha256'=o.terms_sha256
    ORDER BY l.hosted_sku LIMIT 201`, [p.storefront_shop_id])).rows;
  return rows.map(row => ({product: {product_id: row.item_id, sku: row.hosted_sku, title: row.snapshot.title,
    description: row.snapshot.description, price_minor: Number(row.retail_price_minor), currency: p.currency, version: row.version}, photo: null}));
}
