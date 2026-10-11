-- Local durable holds, before any inventory handoff or remote adapter exists.
-- This migration enables no capability and retains the existing stock authority.
CREATE TABLE commerce_inventory_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES commerce_orders(order_id),
  item_id uuid NOT NULL,
  supplier_shop_id uuid NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0 AND quantity<=4950),
  state text NOT NULL CHECK(state IN ('held','released')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at=created_at+interval '30 minutes'),
  released_at timestamptz,
  UNIQUE(order_id,item_id),
  FOREIGN KEY(item_id,supplier_shop_id) REFERENCES commerce_items(item_id,shop_id),
  CHECK((state='held' AND released_at IS NULL) OR
    (state='released' AND released_at IS NOT NULL AND released_at>=created_at))
);
CREATE INDEX commerce_inventory_held_item ON commerce_inventory_reservations(item_id) WHERE state='held';

-- Preserve active and terminal history, including the original supplier for a
-- shared order. Never infer a new hold from a current offer or change a balance.
INSERT INTO commerce_inventory_reservations(order_id,item_id,supplier_shop_id,quantity,state,created_at,expires_at,released_at)
SELECT o.order_id,l.item_id,i.shop_id,sum(l.quantity)::integer,
  CASE WHEN o.reservation_state='reserved' THEN 'held' ELSE 'released' END,
  o.created_at,o.expires_at,o.closed_at
FROM commerce_orders o JOIN commerce_order_lines l ON l.order_id=o.order_id
JOIN commerce_items i ON i.item_id=l.item_id
WHERE o.order_profile IN ('hosted_direct_reservation','hosted_shared_reservation')
GROUP BY o.order_id,l.item_id,i.shop_id;

CREATE FUNCTION preserve_commerce_inventory_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'inventory reservation history is retained' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.reservation_id,NEW.order_id,NEW.item_id,NEW.supplier_shop_id,NEW.quantity,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.reservation_id,OLD.order_id,OLD.item_id,OLD.supplier_shop_id,OLD.quantity,OLD.created_at,OLD.expires_at)
    OR OLD.state<>'held' OR NEW.state<>'released' THEN
    RAISE EXCEPTION 'inventory reservation permits one release only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_commerce_inventory_reservation BEFORE UPDATE OR DELETE ON commerce_inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION preserve_commerce_inventory_reservation();

-- Deferred checks permit one atomic order/line/hold/balance transaction. They
-- also fence an older hosted writer: a binary without this ledger must fail
-- closed instead of leaving untracked stock or silently losing a release.
CREATE FUNCTION check_commerce_inventory_balance(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE balance integer; held bigint;
BEGIN
  SELECT i.reserved INTO balance FROM commerce_items i JOIN commerce_shops s USING(shop_id)
    WHERE i.item_id=target AND s.origin='hosted' FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(quantity),0) INTO held FROM commerce_inventory_reservations WHERE item_id=target AND state='held';
  IF balance<>held THEN RAISE EXCEPTION 'hosted balance must equal durable holds' USING ERRCODE='23514'; END IF;
END;
$$;
CREATE FUNCTION check_commerce_inventory_order(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE profile text;
BEGIN
  SELECT order_profile INTO profile FROM commerce_orders WHERE order_id=target;
  IF profile IS NULL OR profile='imported_reseller' THEN
    IF EXISTS(SELECT 1 FROM commerce_inventory_reservations WHERE order_id=target) THEN
      RAISE EXCEPTION 'inventory hold requires a hosted order' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM commerce_order_lines WHERE order_id=target)
    OR EXISTS(
      WITH expected AS (
        SELECT l.item_id,i.shop_id,sum(l.quantity)::integer AS quantity
        FROM commerce_order_lines l JOIN commerce_items i USING(item_id)
        WHERE l.order_id=target GROUP BY l.item_id,i.shop_id
      ), actual AS (SELECT * FROM commerce_inventory_reservations WHERE order_id=target)
      SELECT 1 FROM expected e FULL JOIN actual a USING(item_id)
      CROSS JOIN commerce_orders o
      WHERE o.order_id=target AND (e.item_id IS NULL OR a.item_id IS NULL
        OR a.supplier_shop_id IS DISTINCT FROM e.shop_id OR a.quantity IS DISTINCT FROM e.quantity
        OR a.created_at IS DISTINCT FROM o.created_at OR a.expires_at IS DISTINCT FROM o.expires_at
        OR (a.state='held') IS DISTINCT FROM (o.reservation_state='reserved'))
    ) THEN RAISE EXCEPTION 'hosted order must match durable holds' USING ERRCODE='23514'; END IF;
END;
$$;
CREATE FUNCTION check_commerce_inventory_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='commerce_items' THEN
    PERFORM check_commerce_inventory_balance(NEW.item_id);
  ELSIF TG_TABLE_NAME='commerce_inventory_reservations' THEN
    PERFORM check_commerce_inventory_balance(NEW.item_id);
    PERFORM check_commerce_inventory_order(NEW.order_id);
  ELSE
    PERFORM check_commerce_inventory_order(NEW.order_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_commerce_inventory_balance AFTER INSERT OR UPDATE ON commerce_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_inventory_change();
CREATE CONSTRAINT TRIGGER check_commerce_inventory_hold AFTER INSERT OR UPDATE ON commerce_inventory_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_inventory_change();
CREATE CONSTRAINT TRIGGER check_commerce_inventory_order AFTER INSERT OR UPDATE ON commerce_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_inventory_change();
CREATE CONSTRAINT TRIGGER check_commerce_inventory_line AFTER INSERT ON commerce_order_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_commerce_inventory_change();

-- Abort migration on inconsistent retained data; never manufacture inventory.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT i.item_id FROM commerce_items i JOIN commerce_shops s USING(shop_id) WHERE s.origin='hosted' ORDER BY i.item_id LOOP
    PERFORM check_commerce_inventory_balance(r.item_id);
  END LOOP;
  FOR r IN SELECT order_id FROM commerce_orders WHERE order_profile IN ('hosted_direct_reservation','hosted_shared_reservation') LOOP
    PERFORM check_commerce_inventory_order(r.order_id);
  END LOOP;
END;
$$;
