-- Closed member-owned Run records only. No Attempt/Grant/runtime/lease,
-- dispatch, credentials or recovery authority exists in this increment.
CREATE TABLE execution_runs (
  run_id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL,
  work_mode text GENERATED ALWAYS AS ('personal_execution'::text) STORED,
  scope_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  input_work_version bigint NOT NULL CHECK(input_work_version>0),
  persistence_policy_revision text NOT NULL CHECK(
    persistence_policy_revision ~ '^private-work[.]v[1-9][0-9]{0,18}$'
    AND length(persistence_policy_revision)<=33),
  state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','paused','cancelled')),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK(aggregate_version>0),
  task_lease_epoch bigint NOT NULL DEFAULT 1 CHECK(task_lease_epoch>0),
  control_epoch bigint NOT NULL DEFAULT 1 CHECK(control_epoch>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(work_item_id,work_mode,scope_id,owner_principal_id,owner_user_id)
    REFERENCES work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref)
);
CREATE INDEX execution_runs_owner_work ON execution_runs(owner_principal_id,scope_id,work_item_id,run_id);

CREATE FUNCTION preserve_execution_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record; policy record;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Run history cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'created' OR NEW.aggregate_version<>1 OR NEW.task_lease_epoch<>1 OR NEW.control_epoch<>1 THEN
      RAISE EXCEPTION 'Run must start unexecuted' USING ERRCODE='23514';
    END IF;
    -- Invoker rights stay intact, but TEMP/search_path cannot substitute fake
    -- backing rows for the physical Work and operator policy of this Run table.
    EXECUTE format('SELECT * FROM %I.work_items WHERE work_item_id=$1 FOR SHARE',TG_TABLE_SCHEMA)
      INTO target USING NEW.work_item_id;
    IF target.work_item_id IS NULL OR target.work_mode<>'personal_execution' OR target.state<>'draft'
      OR target.aggregate_version<>NEW.input_work_version THEN
      RAISE EXCEPTION 'Run requires current draft Work input' USING ERRCODE='23514';
    END IF;
    EXECUTE format('SELECT * FROM %I.private_work_persistence_policy
      WHERE scope_id=$1 AND owner_principal_id=$2 AND purpose=''work.private-draft'' FOR SHARE',TG_TABLE_SCHEMA)
      INTO policy USING NEW.scope_id,NEW.owner_principal_id;
    IF policy.scope_id IS NULL OR NOT policy.persistence_allowed OR policy.retained_byte_limit IS NULL
      OR policy.retained_byte_limit<262144 OR NEW.persistence_policy_revision<>'private-work.v'||policy.revision::text THEN
      RAISE EXCEPTION 'Run requires current private metadata persistence policy' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.run_id,NEW.work_item_id,NEW.scope_id,NEW.owner_principal_id,NEW.owner_user_id,
      NEW.input_work_version,NEW.persistence_policy_revision,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.run_id,OLD.work_item_id,OLD.scope_id,OLD.owner_principal_id,OLD.owner_user_id,
      OLD.input_work_version,OLD.persistence_policy_revision,OLD.created_at) THEN
    RAISE EXCEPTION 'Run identity and input snapshot are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state='cancelled' OR NEW.state NOT IN ('paused','cancelled')
    OR NEW.aggregate_version::numeric<>OLD.aggregate_version::numeric+1
    OR NEW.task_lease_epoch::numeric<>OLD.task_lease_epoch::numeric+1
    OR NEW.control_epoch::numeric<>OLD.control_epoch::numeric+1 THEN
    RAISE EXCEPTION 'Run transition requires independent monotonic fences' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_execution_run BEFORE INSERT OR UPDATE OR DELETE ON execution_runs
  FOR EACH ROW EXECUTE FUNCTION preserve_execution_run();
