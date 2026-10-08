-- Member archive retires an instance without deleting its data or references.
ALTER TABLE module_provision_operations
  DROP CONSTRAINT module_provision_operations_kind_check,
  ADD CONSTRAINT module_provision_operations_kind_check
    CHECK (operation_kind IN ('application.launch','module.instance.suspend','module.instance.resume','module.instance.archive')),
  ADD CONSTRAINT module_provision_operations_archive_shape_check
    CHECK (operation_kind <> 'module.instance.archive' OR
      (instance_id IS NOT NULL AND reason IS NOT NULL AND installation_id IS NULL AND plan_id IS NULL AND policy_revision IS NULL));

ALTER TABLE module_instances
  ADD COLUMN archive_operation_id uuid,
  ADD CONSTRAINT module_instances_archive_operation_fkey
    FOREIGN KEY (tenant_id, archive_operation_id) REFERENCES module_provision_operations(tenant_id, operation_id),
  ADD CONSTRAINT module_instances_archive_status_check
    CHECK (status = 'archived' OR archive_operation_id IS NULL);

CREATE INDEX application_module_links_instance ON application_module_links (tenant_id, instance_id);
