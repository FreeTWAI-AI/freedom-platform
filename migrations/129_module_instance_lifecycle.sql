-- Synchronous member suspension/resumption shares the durable registry operation log.
-- Existing launch rows keep their installation and capacity-policy pins.
DO $$ DECLARE constraint_name text; BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid = 'module_provision_operations'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%operation_kind =%';
  EXECUTE format('ALTER TABLE module_provision_operations DROP CONSTRAINT %I', constraint_name);
END $$;

ALTER TABLE module_provision_operations
  ALTER COLUMN installation_id DROP NOT NULL,
  ALTER COLUMN policy_revision DROP NOT NULL,
  ADD COLUMN instance_id uuid,
  ADD COLUMN reason text,
  ADD CONSTRAINT module_provision_operations_kind_check
    CHECK (operation_kind IN ('application.launch','module.instance.suspend','module.instance.resume')),
  ADD CONSTRAINT module_provision_operations_reason_check
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 1000),
  ADD CONSTRAINT module_provision_operations_instance_fkey
    FOREIGN KEY (tenant_id, instance_id) REFERENCES module_instances(tenant_id, instance_id),
  ADD CONSTRAINT module_provision_operations_launch_shape_check
    CHECK (operation_kind <> 'application.launch' OR
      (installation_id IS NOT NULL AND policy_revision IS NOT NULL AND instance_id IS NULL AND reason IS NULL)),
  ADD CONSTRAINT module_provision_operations_suspend_shape_check
    CHECK (operation_kind <> 'module.instance.suspend' OR
      (instance_id IS NOT NULL AND reason IS NOT NULL AND installation_id IS NULL AND plan_id IS NULL)),
  ADD CONSTRAINT module_provision_operations_resume_shape_check
    CHECK (operation_kind <> 'module.instance.resume' OR
      (instance_id IS NOT NULL AND policy_revision IS NOT NULL AND installation_id IS NULL AND plan_id IS NULL AND reason IS NULL)),
  ADD CONSTRAINT module_provision_operations_lifecycle_state_check
    CHECK (operation_kind = 'application.launch' OR state = 'succeeded');

ALTER TABLE module_instances
  ADD COLUMN suspension_operation_id uuid,
  ADD CONSTRAINT module_instances_suspension_operation_fkey
    FOREIGN KEY (tenant_id, suspension_operation_id) REFERENCES module_provision_operations(tenant_id, operation_id),
  ADD CONSTRAINT module_instances_suspension_status_check
    CHECK (status = 'suspended' OR suspension_operation_id IS NULL);

CREATE INDEX module_dependencies_provider ON module_dependencies (tenant_id, provider_instance_id);
