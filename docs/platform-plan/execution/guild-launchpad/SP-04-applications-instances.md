# SP-04 應用目錄、模組實例與持久化啟動

## 1. 文件 ID、版本、狀態、來源 commit、對應 D／R／T ID 與範圍

- ID：SP-04；版本：0.1.0；日期：2026-10-05；狀態：**target specification，未實作／未部署**。
- 2026-10-07 註：上一行是 2026-10-05 規格草案的狀態，保留不改。之後 P-C2（#181，merge `57b610ab`，migration 123）已實作本規格的一部分並合併到 main；部署、啟用與驗收的目前狀態只記在 [README「目前狀態」](README.md#目前狀態)。
- 計畫v1.0第2、4、7、9、10、11、18、19–24章；基線 `FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`。application/module/instance registry是新增領域，不將既有module descriptor或guild.module_key誤認為已可配置實例。
- 決策：D-07、D-08、D-09、D-10、D-12、D-13、D-14、D-15、D-16、D-20、D-22。主要需求R-008、R-017、R-018、R-019、R-020、R-052；共同R-003、R-009、R-016、R-031、R-032、R-034、R-036、R-053、R-055、R-059、R-062。
- 驗收T-003、T-008、T-009、T-016、T-017、T-018、T-019、T-020、T-027、T-031、T-032、T-034、T-036、T-041、T-051、T-058。
- 單一責任：definitions、提供關係、instance/dependency registry、provision operation、capacity reservation。SP-02管tenant/auth；SP-05管application ports/事件/receipt；SP-06管storage/data；SP-07/08管portable及authority移交；SP-09外部connection；SP-11 AI與計量。
- 共用：[contracts.md](contracts.md)、[data-responsibility.md](data-responsibility.md)、[repository-map.md](repository-map.md)、[decision-log.md](decision-log.md)、[traceability.json](traceability.json)。數值建議見OPEN-04/13/16，不等於已批准方案或售價。

## 2. 使用者流程、前後狀態、非目標與依賴；說明什麼不需要等

### 2.1 相互獨立的產品實體

Guild提供可用ApplicationDefinition；SkillBook提供來源與教學；Application組合一至多個ModuleDefinition；ModuleInstance是tenant真正啟用的一份資料/command責任；DeploymentBinding是位置／權威連線。五者不得1:1綁死。一本ERP技能書可以介紹一個多模組應用，多個guild可採同一inventory/CRM/work能力。SkillBook被領取、repo被fork或會長推薦都不是hosted launch批准。

第一個application是可驗的`manual-workspace`（建議key），module `work`（建議key），讓每guild提供SP-03真實Work/note/attachment/Result。它不依model、不建每會員Worker/DB、不seed假工作。深度application可獨立達成reviewed狀態；某ERP來源尚未審核不阻擋manual-workspace。

### 2.2 使用者可見流程

1. 點guild應用卡，讀公開definition/release/runtime/來源/狀態；符合active full guild資格的人可選管理的tenant/workspace，與主力無關。
2. 伺服器解析依賴，列出此tenant相容實例：只有一個合適provider可推薦`reuse`；有多個必須選明確instance；沒有才提`create`。UI清楚顯「共用既有庫存」或「另建独立空白庫存」。不得先複製資料再問。
3. 提交不可變launch plan，包含application release、tenant/workspace、選定相依instances、configuration及policy版本。普通使用無申請委員會；容量／安全／授權不足回具體原因。
4. 本人確認「啟動」後，server重新驗eligibility、tenant capability、plan revision、dependency狀態及quota；同交易持久化Operation、stable IDs、quota reservations、outbox，再由worker做有限步驟。
5. requested/running顯進度，只有必要模組/設定皆可用才succeeded。callback/ACK不見標needs_reconciliation，保留原operation與資源IDs；查已有結果而不再開一套。
6. 第二公會點同application：优先續用同tenant相容installation；同依賴重用原instance，不複製CRM/庫存。另開installation/instance必顯式`create_new`，仍受policy配額。
7. 重新登入/刷新可從operation、installation/instance lists繼續；業務owner是tenant，不是點擊guild或當時member。

非目標：一按啟動就fork/deploy、建立另一通用runtime/queue、任意第三方app直接執行、不經授權升級/外移、正式checkout/會計、保證免費無上限、把ERP SIM變正式資料。location模式不改resource identity。

依賴SP-02/05共同介面即可先做catalog/plan/合成provisioner；SP-03 shell並行。真實side effect需該hosted profile、tenant scope、DB/Asset policy與data responsibility具備；不必等所有application或外部自架。外部binding與migration需SP-08/09各自gate，default hosted-shared不可偷改external。

## 3. 現有程式對照與 KEEP／MODIFY／NEW／GENERATED，精確到實際檔案

| 動作 | 精確路徑 | 對照與目標 |
|---|---|---|
| KEEP | `modules/community/catalog.ts` | SkillBook/source/guild官方綁定仍為知識目錄；不能用它直接部署原作 |
| MODIFY | `modules/guild-workspace/service.ts`、`modules/positioning/onboarding.ts` | 應用卡的guild提供關係／資格projection；原skill grant保留 |
| KEEP | `packages/db/command-core.ts`、`packages/db/transaction.ts`、`packages/scoped-commands/index.ts` | 持久command/receipt與交易；tenant擴充依SP-02 |
| KEEP／對接 | `packages/execution-state/index.ts`、`modules/agent-execution/freedom.module.json` | 既有AI execution身份不挪作instance provision萬能runtime；工作authority依既有責任接入 |
| KEEP | `modules/opportunity-project-work/freedom.module.json`、`modules/autopilot-work/freedom.module.json` | manual Work/Result domain及實際implementation；application只是組合入口 |
| KEEP | `modules/catalog-commerce/service.ts`、`modules/agent-commerce/orders.ts` | 實體演進由SP-10指定owner；本registry不新建第三套order |
| NEW（建議） | `modules/module-registry/catalog.ts`、`modules/module-registry/service.ts`、`modules/module-registry/provisioning.ts`、`modules/module-registry/capacity.ts`、`modules/module-registry/freedom.module.json` | definitions/instances/dependencies/操作帳與quota；單一registry owner |
| NEW（建議） | `contracts/modules/v1/registry.ts`、`contracts/modules/v1/application.ts` | 嚴格canonical schemas、相容fixtures |
| NEW（建議） | `apps/platform-api/src/routes/module-registry.ts`、`apps/portal-web/src/modules/ApplicationLauncher.tsx`、`apps/portal-web/src/modules/ModuleInstances.tsx` | plan/start/status/reuse UI |
| MODIFY | `apps/platform-api/src/platform-app.ts` | member-boundary後明確mount；未核profile保持關閉 |
| NEW（建議） | `packages/sdk/module-registry.mjs` | 經版本化port SDK調registry，不直連別module表 |
| GENERATED（未建立） | `contracts/modules/v1/registry.schema.json`、`contracts/modules/v1/application.schema.json`、`packages/sdk/module-registry.d.mts` | 從canonical source生成；既有bundle流程需由負責PR擴充 |
| NEW（logical migration） | `migrations/<next>_module_registry.sql`、`migrations/<next>_module_provision_operations.sql` | 實作時依main分配檔名，不預占116–118或改舊migration |
| NEW（建議） | `tests/runtime/module-registry.test.ts`、`tests/runtime/module-provisioning.test.ts`、`tests/runtime/module-capacity.test.ts`、`tests/e2e/application-launcher.test.ts` | 下列T fixtures |
| MODIFY | `scripts/build-contract-bundle.mjs`、`tests/integration/consumer-libraries.test.ts` | 真正生成/pin/runtime消費新contract；不能只有README引用 |

新module descriptor需依現有governance註冊依賴；禁止registry反向import整個下游業務module形成cycle。`packages/client-connections/`既有read/shop clients不直接擴權；新外部consumer由SP-09 scope與新contract明確加入。

## 4. 資料模型、唯一性／關聯／tenant scope、owner／authority、版本與敏感欄位

### 4.1 Definition及四種版本

| 目標表／aggregate | 完整必要欄位與限制 |
|---|---|
| `application_definitions` | `(application_key,release_ref) PK`；display_name、source_commit/artifact_digest、skill_book_refs[]、module_requirements[]、entry_capability、runtime_profiles[]、launch_policy_ref、license_state unresolved\|reviewed\|blocked、release_status draft\|reviewed\|available\|retired、customization_schema_ref、version；release immutable，不把latest作pin |
| `module_definitions` | `(module_key,release_ref) PK`；capabilities[]、data_catalog_ref、contract_ref、data_schema_version、portable_profile_ref、runtime_profiles、config_schema_ref、supported_upgrade_paths[]、license_review_ref、version；責任邊界對應真正domain，不只是UI分頁 |
| `guild_application_offerings` | `(community_id,guild_key,application_key,release_ref) UNIQUE`；status、order、launch_policy_ref、version；同app可多guild、guild可多app；只推薦已核准release，guild配置不能變license/permission |
| `application_installations` | installation_id UUID PK、tenant_id、workspace_id、application_key、release_ref、configuration_revision、status requested\|provisioning\|active\|failed\|suspended\|archived、version、created_by_principal_id、origin_guild_key；origin只稽核，不給guild所有權 |
| `application_module_links` | `(installation_id,requirement_key) PK`、tenant_id、instance_id、binding_selection reuse\|create、version；所有refs同tenant，requirement一次只綁一provider |
| `workspace_module_bindings` | `(tenant_id,workspace_id,entry_capability) PK`、instance_id、version；同tenant workspace/instance複合FK。manual-work的`work:create`入口明確綁一work instance；這是UI入口選擇，不是把一tenant同module只能一份寫死 |
| `module_instances` | 共同`{instance_id,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,status,binding_id,authority_epoch,version}`，另created_at/configuration_revision/provision_operation_id；UNIQUE(tenant_id,instance_id)，ID/tenant/module身份不可重綁 |
| `deployment_bindings` | binding_id、tenant_id、instance_id、mode hosted\|external、environment、endpoint_ref?、service_principal_ref?、contract_ref、state pending\|active\|suspended\|retired、version；同instance/epoch至多一active，endpoint_ref為SP-09驗過registry，不收任意URL |
| `module_dependencies` | dependency_id、tenant_id、caller_instance_id、requirement_key、capability、provider_instance_id、sharing_policy_ref、version；caller/provider同tenant（初版），拒self/cycle；跨tenant另需明確双方協議與service scopes |

應用release版本、data schema版本、互通contract版本、customization schema/config revision是四種獨立欄位；App升版不默認遷DB、换scope、重綁provider或改customer欄位。`authority_epoch`是authority移交的單調值，不是app version或business aggregate version。location切換由SP-08唯一處理，不透過一般edit binding改URL。

### 4.2 持久operation與容量

- `module_provision_operations(operation_id UUID PK,tenant_id,installation_id,actor_principal_id,operation_kind,state,request_digest,plan_id,authorization_revision,policy_revision,version,accepted_at,updated_at,cancel_requested_at?,terminal_problem?)`；state共同六值：requested/running/succeeded/failed/needs_reconciliation/cancelled。
- `module_provision_steps(operation_id,step_key PK,instance_id,provider_effect_key,state pending|dispatched|confirmed|failed_known|unknown|compensating|compensated,attempt_count,next_attempt_at,lease_fence,lease_expires_at,evidence_ref,result_digest)`。provider_effect_key跨retry/restart不變；transport attempt可增加，effect不變。
- `module_launch_plans(plan_id UUID PK,tenant_id,actor_principal_id,application_key,release_ref,workspace_id,selection_digest,dependency_versions,policy_revision,expires_at,version)`；不可變，無配置side effects；含已验证config但不得含credential。
- `tenant_capacity_policies(policy_id,revision,tenant_id?,plan_ref,max_active_instances,max_instances_per_module,max_concurrent_provisions,max_work_items,max_retained_bytes,max_concurrent_jobs,max_model_budget?,status)`；明確數值、0表示禁止該能力；missing不是unlimited。public顯示的是本人plan，不洩平台成本secret。
- `capacity_reservations(reservation_id,tenant_id,operation_id,dimension,units,policy_revision,state reserved|consumed|released|unknown,expires_at,version)`；UNIQUE(operation_id,dimension)，使用bigint/decimal或整數最小貨幣單位，不浮點；unknown仍占額度，不因lease到期釋放。
- `capacity_ledger(entry_id,tenant_id,operation_id,dimension,delta,kind reserved|actual|released|unknown,source_ref,created_at)` append-only。跨app reuse同instance只計一次實例/bytes；capabilities/jobs/model另計，不能雙扣。

操作、registry、quota、receipt、outbox控制面同交易建立，外部I/O在交易外。資源ID先分配且FK掛到tenant/operation，外部ACK未知也能找到owner，不能生無主DB／object。prototype hosted-shared只建立邏輯rows和必要config，不為每instance建立物理DB/Worker。

instance配額data model允多開，不用`UNIQUE(tenant_id,module_key)`永久禁止；避免重複點擊由幂等receipt＋installation selection fingerprint約束，不靠砍掉多實例能力。明確`create_new`可在quota範圍建立第二份空白資料；舊資料不copy。

## 5. API／command／query／event 的完整輸入輸出、錯誤、身份、冪等及並行語意

### 5.1 共用型別／錯誤

API base `/api/v1`，tenant routes `/tenants/:tenant_id`。OpaqueId/StableKey/CapabilityKey/Version/Epoch/ContractRef/PolicyRef/Page/Operation/Problem沿共同contracts；mutation current session/CSRF/Origin、key8–128，變更If-Match。client的tenant/expected_epoch只是target／防stale，真正權限從server context決定。

```ts
type Requirement={requirement_key:StableKey;module_key:StableKey;capabilities:CapabilityKey[];
 required:boolean;compatible_contracts:ContractRef[];cardinality:'one';allow_reuse:boolean};
type DependencyChoice={requirement_key:StableKey;choice:'reuse';instance_id:UUID;expected_version:Version}
 |{requirement_key:StableKey;choice:'create';configuration:Record<string,unknown>};
type ApplicationView={application_key:StableKey;release_ref:string;display_name:string;
 module_requirements:Requirement[];runtime_profiles:('hosted-reviewed'|'external-supported')[];
 launch_policy_ref:PolicyRef;license_state:'unresolved'|'reviewed'|'blocked';
 release_status:'draft'|'reviewed'|'available'|'retired';version:Version};
type InstanceView={instance_id:UUID;tenant_id:UUID;module_key:StableKey;application_release_ref:string;
 data_schema_version:string;contract_ref:ContractRef;status:'requested'|'provisioning'|'active'|'failed'|'suspended'|'archived';
 binding_id:UUID;authority_epoch:Epoch;version:Version;configuration_revision:Version};
type InstallationView={installation_id:UUID;tenant_id:UUID;workspace_id:UUID;application_key:StableKey;
 release_ref:string;status:InstanceView['status'];version:Version;
 modules:{requirement_key:StableKey;instance_id:UUID}[]};
type LaunchPlan={plan_id:UUID;version:Version;tenant_id:UUID;workspace_id:UUID;
 application_key:StableKey;release_ref:string;expires_at:string;policy_revision:string;
 choices:DependencyChoice[];capacity_delta:{dimension:StableKey;units:string}[];
 warnings:{code:string;requirement_key?:StableKey}[];configuration_digest:Digest};
```

`CapabilityKey`採共同`^[a-z][a-z0-9_.:-]{0,159}$`，colon/dotted皆須在registry登記，禁止wildcard，與不含colon的StableKey不同；不把guild文字標籤當capability。

`configuration`不是任意執行JSON：必須對應該release的pinned config_schema，最大32KiB、深度≤8，無secret/endpoint/sql/js欄位，extension namespaced且明確版本；unknown欄位拒422或完整保存為核准extension，不靜默丟棄。供應key如CRM/service credentials只透過SP-09安全route。

共同錯誤：400 invalid_input/idempotency_required；401 session_expired；403 capability_denied/guild_full_member_required/policy_unconfigured；404 not_found；409 idempotency_conflict/plan_stale/dependency_selection_required/dependency_in_use/workspace_binding_conflict/authority_changed/application_not_available/license_unresolved/operation_not_cancellable；412 version_conflict；422 contract_incompatible/dependency_cycle/configuration_invalid；428 version_required；429 quota_exceeded；503 dependency_unavailable。外部已派送但結果未知不轉503+「失敗可再建」，回202 Operation(needs_reconciliation)。

Definition發布沒有任意runtime create/edit endpoint：先在受治理source PR核准immutable release、capability/config schema、license與artifact pin，再由已有發布責任的維運入口匯入registry；本spec不授權guild editor安裝軟體。該匯入工具與授權證據由SP-12 materialization／release gate追蹤，公開GET只呈現已核可profile。

### 5.2 Catalog、plan及provision端點

| endpoint／capability | 完整輸入 | 成功輸出 | 資格與效果 |
|---|---|---|---|
| GET `/applications` | `{guild_key?:GuildKey,cursor?:string,limit?:int1..100}` | `Page<ApplicationView>` | public只available公開資訊；member才附自己eligibility，不含tenant明細 |
| GET `/applications/:application_key/releases/:release_ref` | `{}` | ApplicationView＋`{source_commit,artifact_digest,skill_book_refs,license_review_ref}` | 公開已發布release；不能因查到definition取得execution |
| GET `/tenants/:tenant_id/module-instances` | `{module_key?:StableKey,status?:InstanceStatus,cursor?:string,limit?:int1..100}` | `Page<InstanceView>` | tenant/current instance read；limit默认20；只授權instances |
| GET `/tenants/:tenant_id/module-instances/:instance_id` | `{}` | InstanceView＋`dependencies:{requirement_key,provider_instance_id,version}[]` | 當前read；不回raw endpoint/credentials |
| GET `/tenants/:tenant_id/application-installations` | `{application_key?:StableKey,workspace_id?:UUID,cursor?:string,limit?:int1..100}` | `Page<InstallationView>` | current tenant membership+read |
| GET `/tenants/:tenant_id/application-installations/by-operation/:operation_id` | `{}` | `InstallationView`（含已受理但尚在provisioning／failed的status） | 只接受該tenant的application.launch操作並驗当前installation read；DB持久operation→installation映射，不由client猜instance；非此類或未授權一致404 |
| POST `/tenants/:tenant_id/application-launch-plans` `application.plan` | `{guild_key:GuildKey,workspace_id:UUID,application_key:StableKey,release_ref:string,installation_choice:'reuse_existing'\|'create_new',existing_installation_id?:UUID,dependencies:DependencyChoice[],configuration:object}` | 201 LaunchPlan；若缺依賴選擇409附授權可見candidate IDs/versions | owner/admin instance.manage+guild full；不reserve資源，不配置；persist plan供確認/restart |
| POST `/tenants/:tenant_id/application-installations` `application.launch` | `{plan_id:UUID,expected_plan_version:Version,configuration_digest:Digest}` | 202 Operation（若明確重用已可用installation可200 succeeded；不填resource_ref，以下by-operation讀回原installation） | 重新驗完整plan/current role/guild/quota；一交易operation+stable IDs+reservation+outbox |
| GET `/tenants/:tenant_id/operations/:operation_id` | `{}` | Operation（只含共同欄位；逐步內部日誌不混進strict DTO） | 同tenant operation.read，無內部endpoint/secret/private body；這是registry/provision生命週期操作，可能早於或跨多instance；SP-05業務effects仍用其instance-scoped route。兩者共用Operation DTO與command/outbox核心，但此route不假稱SP-05既有handler，也不另建工作引擎 |
| POST `/tenants/:tenant_id/operations/:operation_id/reconcile` `module.provision.reconcile` | `{}`＋If-Match | 202 Operation | owner/admin/受限維運worker；只查原effect，不派第二份；查詢provider仍走已驗adapter |
| POST `/tenants/:tenant_id/operations/:operation_id/cancel` `module.provision.cancel` | `{reason:'member_cancelled'}`＋If-Match | 202 Operation或200 cancelled | 管理權；cancel_requested持久化；unknown不假cancelled、不提前釋quota |
| POST `/tenants/:tenant_id/module-instances/:instance_id/suspend` `module.instance.suspend` | `{reason:string(3..1000)}`＋If-Match | Operation→suspended instance | owner/admin；檢查依賴consumer並顯示影響；不刪資料、不自動外移 |
| POST `/tenants/:tenant_id/module-instances/:instance_id/resume` `module.instance.resume` | `{}`＋If-Match | Operation→active instance | 當前資格/policy/版本與安全狀態合法；安全封鎖不能自行解除 |
| POST `/tenants/:tenant_id/module-instances/:instance_id/archive` `module.instance.archive` | `{reason:string(3..1000)}`＋If-Match | Operation→archived instance | owner；active consumer refs或未結operation409，先明確處理；archive不erase |
| POST `/tenants/:tenant_id/module-instances/:instance_id/upgrade-plans` `module.upgrade.plan` | `{target_release_ref:string}`＋If-Match | `{plan_id,version,from_release_ref,to_release_ref,data_schema_changes:{from_version:string,to_version:string,migration_ref:string}[],contract_changes:{from:ContractRef,to:ContractRef}[],configuration_changes:{path:string,kind:'add'\|'change'\|'remove',requires_member_input:boolean}[],requires_write_fence:boolean,expires_at}` | owner/admin；無副作用，只支持已註冊路徑 |
| POST `/tenants/:tenant_id/module-instances/:instance_id/upgrades` `module.upgrade.apply` | `{plan_id:UUID,expected_plan_version:Version}`＋instance If-Match | 202 Operation | owner及必要high-risk scope；有資料變換則SP-07/08 snapshot/fence前置；不得自改dependency binding |

字串release_ref與config/schema版本最大160，version refs不可含URL credential；最大required modules建議20。所有URI ID須匹配tenant FK，cannot simply `WHERE instance_id=$1`。list Page一定回`source_version`與`next_cursor:null`結尾，不截斷後冒稱完整目錄。

registry/provision Operation可能早於或跨多module，所有此類Operation一律省略可選`resource_ref`，不虛構instance_id，也不加installation_id等未定義欄位到共同strict DTO。UI在取得operation_id後用上述by-operation專用query讀InstallationView；即使ACK未知仍從同一持久映射讀目前status。module suspend/resume/archive/upgrade以原請求已知的instance_id讀InstanceView，不把控制面結果冒稱module業務ResourceRef。SP-05/10真正module業務操作則可回其合法ResourceRef。

manual-work成功啟用時，與application_module_links同交易建立workspace的`work:create` binding；SP-03/10 POST works從這個當前受控mapping解析instance。已綁同instance可重用；若新plan想在同workspace改綁另一work instance，首版回409 `workspace_binding_conflict`並讓本人選另一workspace，不能隱式移走既有Work。多work instances依不同workspace可並存；此spec不開任意rebind endpoint，將來另有明確權限/CAS/影響分析後才增加。

### 5.3 選擇與幂等細則

- 相同application已有active installation時`reuse_existing`要指定其ID；server驗release相容、workspace/ACL、必要requirements皆存在，回原ID。不存在回409 `installation_selection_required`，不能猜創新。
- dependency `reuse`必須同tenant、active、support所有必要capability、contract與data schema相容、sharing policy允許；不得因display_name相同就選。多candidate以UI顯示，只有明確選擇才綁。
- dependency `create`分配新ID及空schema；只有必要schema/config種子，沒有SIM商務records。選擇UI必說獨立空白資料和額外配額。共享庫存的兩application以同instance ID/accounting一次計數。
- race：不同keys同時啟動相同reuse plan，以tenant+installation fingerprint鎖取同installation；`create_new`以明示不同intent形成第二份，但同key不重建。兩個plan各自create依賴但語意都是預設單份時，第二者重新讀registry並回409 plan_stale/請選reuse，不能默默建立兩份。
- receipt hash綁tenant/workspace/app release/plan/dependency IDs/expected versions/config digest；same key changed config拒409；replay先驗當前權限再返回原receipt。
- worker lease只是誰可處理，不是操作授權；每步再驗policy、tenant state/role授權是否仍可執行、instance epoch。授權撤銷後已發生provider effect需reconcile/安全補償，不能以撤銷帳號刪除歷史。

### 5.4 Events與capability contracts

以下registry／provision生命周期屬控制面scoped journal/outbox事件，使用明確版本payload schema與現有profile，不強塞SP-05的module業務envelope：`freedom.application.launch.accepted.v1` `{operation_id,installation_id,application_key,release_ref}`；`freedom.module.instance.activated.v1` `{instance_id,module_key,binding_id,authority_epoch,version}`；`freedom.module.provision.reconciliation_required.v1` `{operation_id,instance_id,step_key,reason_code}`；`freedom.module.instance.status_changed.v1` `{instance_id,status,version}`。payload不含config正文、CRM/Work、憑證；tenant scoped，不進public guild feed。

本地provisioner只透過受控application port初始化domain，不跨module直接INSERT業務表。provider接受`provider_effect_key`需有outcome查詢與原子去重；若沒有可驗幂等/查結果能力，该外部profile不能標支援自動配置。registry事件有tenant但application.launch尚未有active source module；不得捏造source_instance_id。若向真正module發業務事件，由SP-05具名adapter在確認source/target instance、tenant、epoch及用途後產生合法module envelope。location binding/epoch變更事件只由SP-08授權移交產生。

## 6. 狀態機與成功、失敗、結果未知、重啟、撤權、版本不符及部分完成分支

| 層級 | 狀態與轉移 | 不變量／失敗處理 |
|---|---|---|
| Definition release | draft→reviewed→available→retired；blocked獨立license gate | retired停止新launch，既有usage/版本遷移依support policy，不刪業務 |
| Operation | requested→running→succeeded；known failure→failed；派送未知→needs_reconciliation；確認無未結效果後→cancelled | terminal operation不覆寫成新effects；unknown不可當failed重新建 |
| Module instance | requested→provisioning→active；known irrecoverable→failed；active→suspended→active；明確退場→archived | needs_reconciliation為operation狀態，instance留provisioning並展示原因；failed保留diagnostic/owner |
| Step | pending→dispatched→confirmed；known denial→failed_known；ACK不明→unknown；有確知需補償→compensating→compensated | 只有same effect key續查/重試；不以attempt ID改provider資源 |
| Capacity | reserved→consumed或released；派送不明→unknown→consumed/released | unknown持續占額、顯示對帳，不靠時間假釋放 |

處理順序：持久接單→預留quota→鎖定/確認reuse refs→每個new module依拓撲順序init→验证schema/config/binding→原子active installation。步驟crash前後都有fence和checkpoint，DB commit後才派送；queue僅喚醒，DB是事實來源。有限重試backoff（與OPEN-05一致的合成10秒request、≤12次/24h起點），超過進needs_reconciliation/人工可查，不能無限熱迴圈。

未知ACK必經provider查原effect：找到matching資源即驗tenant/digest接回原ID；確知不存在才可same effect重試；不可達仍unknown；找到不同owner/hash則quarantine並報，不claim他人資源。provider無lookup但支持真正幂等重送可same key詢原結果，須fixture證明。資源owner/operation資訊在配置前持久化。

部分成功：reuse實例不補償刪除；已新建但未用的空instance可在證明無資料、无下游refs/未結events下archive/釋放其capacity，實體清理另走SP-06。已有member資料或外部不可逆效果只能向前修復／明示保留，不刪列裝全回滾。installation可failed但清楚列出保留instances與可接續operation。

資格在執行中撤銷：停止後續新side effects；已接受的安全清理與結果核對由受控worker最小scope進行，不能用原撤銷人session。guild離會不撤tenant所有權，不將active instance delete；新launch或補助資格依SP-11。已存binding/contract不相容只停affected capability，其他instances與合理read/export保持。

升級：先plan兼容檢查→必要snapshot/fence→schema/config變換→behavior fixtures→切release ref。失敗未提交新資料可按已驗backup恢復；新版本已寫入後需向前修復或反向migration，不能盲降app binary。app UI回滾不等DB回滾。

## 7. UI、可見性、空狀態、載入／失敗、手機、無障礙與人工接手

應用卡分「可用人工工作」「審核中」「外部SIM／試用」「停用／版本需更新」，標原作者/source/release/授權狀態；不把github連結冠正式hosted。普通guild member可看目錄，私人實例只在acting tenant中出現。

選擇表明現有inventory/CRM/Work實例的名稱、stable ID尾碼、version、依赖方與資料獨立性，僅展示本人有權資訊。只有一個candidate也顯示將reuse哪個；多候選不預先替人默選。額外instance quota變化顯示在確認畫面，未核定價格不填免費或估價當承諾。

進度顯requested/配置中/核對中/已啟用；只有succeeded才能顯完成。unknown提供「查看進度」「核對原操作」「停止後續步驟」，不提供能生成新資源的「再開一份」捷徑。刷新Back/Forward不重送新key。version conflict保留config草稿並顯差異；quota不足列是哪dimension、used/reserved/limit及仍可用功能。

mobile360px、keyboard、44pxcontrols、status aria-live、dialog focus/Cancel，與SP-03一致。tenant switch先clear private data/cancel舊request；完成notification必帶tenant名稱與operation context，不在B頁顯A資料。支援接手只拿operation ID與安全code，不要求貼API secret或客戶DB。

## 8. 資料匯出／匯入／升級／清理／回復及 legacy 相容；不適用需寫理由

- registry從新增schema起步，現有guild.module_key/技能書只作可核對的導航映射，不能批次轉成已啟用ModuleInstances。現有商店/作品依SP-12 legacy resource mapping決定tenant，不一人全部資產硬合一tenant。
- app包帶pinned release/依賴/必要source/NOTICE/license、config及upgrade tooling；data包帶per-instance schema/資料/Asset；interop包帶邏輯依賴refs/cursors/dedup/epoch lineage，不含secrets。單instance可搬，application其他modules留hosted。
- import先staging驗release/contract/data schema/config/ids/ref/bytes/quota；migration保持instance ID與tenant關係，clone新ID映射。不能以匯入receipt憑空取得新owner或authority。
- binding改location由SP-08fencing及SP-09trusted endpoint完成，不從普通edit endpoint接受URL。module instance ID、customer/order/work IDs保持；application link仍指instance，由resolver找目前binding。
- 升版保留全部已核custom fields，未知extensions明確拒絕或經版本tool完整保留；不以`JSON.parse`後只取known keys靜默丟資料。允許module各自升版/外移，capability相容性逐邊檢查。
- 保留operation/step/receipt的最小effect ID/hash/tombstone跨retry/recovery窗口；payload保留另有policy，不永久複製私有config。未解unknown不能因TTL清除當「沒有操作」。
- 停用/archived與delete不同；最終release definition退場不得cascade刪tenant instances。清理資源須驗所有application/module references、未結quota/operations與備份期限，SP-06責任。
- 復原DB後先套revocations、authority/recovery floor、quota ledger與provider核對；外部effect已發生而snapshot沒有時只能reconcile，不能從requested重建。backup恢復不得讓舊active binding重新接寫。

## 9. 威脅模型、最小權限、秘密、外部入口、cost／capacity 與安全反例

| 威脅 | 控制／必測負例 |
|---|---|
| double click／timeout建立重複付費資源 | stable effect key、receipt、tenant intent鎖、先ledger再I/O、unknown查原結果；不同key亦有明示create語意 |
| 跨tenant重用 | 複合FK/instance ACL/tenant-awareport，篡改dependency instance或operation_id均404 |
| 會長上架惡意app／任意script | offering只能選platform reviewed release；guild config不是執行授權；immutable digest/source/license gate |
| 權限變更／舊receipt | current authority before replay、每步scope/policy/epoch重驗，不能因先前plan曾通過而繼續 |
| 導入SIM／未知原作 | formal seed只schema/config；SIM独立environment和身份，不採visitor cookie→tenant推導 |
| 依赖cycle／fanout／N+1 | typed graph先驗DAG、batch resolution、每plan模組上限、connection timeout/circuit break按instance隔離 |
| quota競態／成本失控 | 同tenant/維度鎖，used+reserved+unknown≤limit，currency/bytes整數、actual reconciliation；reuse不雙計 |
| orphan或誤清理 | resource先綁tenant/operation；補償只動本operation新建且證實可清的資源，不動reuse/有資料instance |
| SSRF與credential洩漏 | config不收raw endpoint/credential；外部接回SP-09專用；logs只safe IDs/status |

合成容量profile建議：每tenant10個active module instances、同module最多3份、同tenant2個provision並行、每plan20個requirements、configuration32KiB、plan15分鐘有效、request10秒、重試≤12次/24h、job queue有tenant公平性；均是**未批准的測試預設**，正式policy/config另定（OPEN-04/05/13/16），不代表免費額度、SLA或生產限制已生效。storage/Work/model額度由同policy明列，缺值阻止昂貴新side effect，保留既有讀與查未知結果。AI人工分帳，不偷用平台key；沒有模型不是manual-work launch錯誤。

## 10. 可重現 fixtures、測試環境、T-ID 驗收、發布條件、證據與未完成項目

fixture：tenant A/B、同人A admin/B viewer、guild G1/G2 full且G2非主力；application manual-workspace與commerce組合；inventory v1相容I1/I2、incompatible I3、B的I4；fake provisioner持久效果表與可注入ACK丟失/timeout/crash；production provider只於獨立授權staging驗證，不以fake宣稱已部署。

| T-ID | 步驟／注入 | 预期證據 |
|---|---|---|
| T-003/T-008 | 同tenant從非主力G2啟動G1相同app | 资格合法；同definition、installation/instance重用，不再建DB；count與IDs |
| T-009 | ERP SIM/source-unresolved release加入offering並launch | 不進formal seed、不標可用hosted；manual-work不受影響 |
| T-017 | 20個並發same key／重送／刷新；same key異payload；兩tab不同key相同plan | 1 operation/effect/instance/reservation；異內容409；有意create_new另單獨fixture |
| T-018 | quota剩1時兩provision競態，unknown配額保留，A/B交錯 | 不超額、不扣B；失敗無半成品；ledger可核對used/reserved/unknown |
| T-019 | provider配置成功後丟ACK→重啟worker→查同effect | 原instance被找回，同ID且tenant owner已存在；無第二份；unknown到succeeded trace |
| T-020 | 已有I1/I2，無choice、明選reuse I1、明選create新空白 | 無choice409；reuse保資料；新instance空白不覆I1；links和counts證據 |
| T-027/T-041 | I1換binding external，app仍hosted；clone另一份 | migration ID穩定、clone新ID；app依port仍引用I1；不直接改DB URL |
| T-031/T-032 | transaction各切點crash、outbox重送、lease過期重取 | 未commit不派送；已commit不丟；同effect不重建；receipt/revision一致 |
| T-034 | 第2module配置失敗，第1是reuse/新空白/已有資料三種 | reuse不動；可證新空白依policy補償；有資料保留并向前修復，不假rollback |
| T-016 | pending launch間離會、active使用時離會、安全suspend | 新资格按policy擋；資料不delete；安全動作與續用分開 |
| T-036 | provider contract不符、upgrade schema失敗、config未知欄位 | affected capability拒絕，其他module/read/export保持；不靜默丟欄位 |
| T-051 | manual-work launch無模型，AI另route無grant | 人工成功；AI拒絕；無平台key呼叫 |
| T-058 | 100合成tenants、每tenant10instances、100並發provision/status、單provider timeout | bounded concurrency/memory/response；其他tenant無隊頭阻塞；超profile有明确退避，不取消隔離 |

實作驗證：typecheck/build/runtime/contracts/repos、相關E2E；真PG受限role、durable fake provider進程重啟、staging真provider/R2另附Evidence。每個測試報source/head SHA、definition release/contract/data schema/policy refs、seed/資料量/並行/timeout、operation receipts與資源計數、unknown處理、quota reconciliation與成本觀測。不能只看HTTP202就宣稱啟動完成。

本spec PR無runtime/provision/測試／正式資料變更。發布門檻：SP-02tenant授權＋SP-05持久effects、manual-work app end-to-end、R2/資料scope（SP-06）、license/source review、quota非空policy、T-017/018/019/020真實DB證據；外部profile需SP-08/09另gate。未完成：registry/DTO生成、實際schema/migrations、可用release pin、正式數值、unknown查詢adapter、真UI/重啟/負向測試與部署驗收。
