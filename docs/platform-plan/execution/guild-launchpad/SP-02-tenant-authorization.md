# SP-02 Tenant、角色與授權邊界

## 1. 文件 ID、版本、狀態、來源 commit、對應 D／R／T ID 與範圍

- ID：SP-02；版本：0.1.0；日期：2026-10-05；狀態：**目標設計提案，尚未實作／啟用**。
- 來源：計畫 v1.0 第 2、4、5.4、7、8、15、19、20、23、24 章；基線 `FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`，正式部署與帳號資料未操作。
- 決策：D-03、D-06、D-07、D-11、D-12、D-19、D-20、D-21。主要需求：R-003、R-007、R-011、R-013、R-014、R-015；共同 R-016、R-022、R-039、R-049、R-054、R-057。
- 驗收：T-003、T-007、T-011、T-013、T-014、T-015、T-016、T-022、T-039、T-049、T-054。
- 本文 accountable：tenant／membership／workspace／角色映射、建立與移交、授權判斷。SP-06 負責實際隔離／備份；SP-09 負責 service binding；SP-11 負責成本／離會方案。不得各自再造 role engine。
- 共用：[contracts.md](contracts.md)、[data-responsibility.md](data-responsibility.md)、[repository-map.md](repository-map.md)、[decision-log.md](decision-log.md)、[traceability.json](traceability.json)。所有新增 API／schema 是規格，不是目前可呼叫能力。

## 2. 使用者流程、前後狀態、非目標與依賴；說明什麼不需要等

### 2.1 身分與资格的四道独立检查

1. **平台身份**：server 依现有 session 查 `users.active`、session未撤销／未过期、principal active，满足现行 onboarding 条件；这叫已认证操作者，不等同法律身份／KYC。
2. **公会关系**：新启动公会提供应用时检查该 guild 的 membership `state='active' AND member_tier='full'`。是否主力、是否持有技能书、会长／专家头衔都不替代此条件。
3. **tenant权限**：操作者在明确选定 tenant 中具有当前 active role 与必要 capability；某人在A是owner，在B是viewer，不许借A权限写B。
4. **能力状态**：应用已核准、instance/binding/authority版本、方案与额度、操作自己的风险范围；AI另有本人模型与ExecutionGrant。

`registerMember()` 目前未给 `email_verified_at` 赋值，`accountView()` 会呈现该字段；不能把现有帐号登录当成邮箱已验证。建议初版普通人工公版以有效登入＋完成既有 onboarding 为平台资格，**不额外要求邮箱验证或KYC**；是否特定付费／外部能力要求已验证email需在policy明确列出并先提供真实验证流程。这是推荐可实现默认，不冒称原计划已批准具体认证参数。email字段不能由浏览器提交为verified。

### 2.2 流程

- 首次启动：选择现有有权管理的业务，或输入新业务名称（不必组织图／公司证号），POST建立tenant及一个默认workspace；此动作不配置机器、不复制repo。完整应用启动依SP-04。建立tenant不自动迁移旧店铺。
- 续用：UI始终显示acting tenant/workspace；重进公会默认显示已绑定的应用与Work。换主力不改role，退出公会只影响后续公会资格／补助，不移转资料。
- 邀请：owner/admin从可辨识的现有会员选择principal，指明role与module范围；受邀者本人接受才active。无自动email外发／自动建立平台帐号；任意第三方地址不是已确认principal。
- 移交：当前owner指定现有active person principal、本人移交后角色与确切scope；受让人登入重新认证并明确接受。接受交易原子新增／确认新owner并调整旧owner，保留tenant/instance/资源稳定ID。
- 最后owner：自愿移除／降级／离开一律409；可以取消移交或先完成移交。平台因安全停用其帐号可以立即停止危险操作，但tenant进入`recovery_required`，不自动归会长／平台管理员。

非目标：不做公司法律所有权判定、资金受益权转让、跨社群自动合并、用户email匹配冒充principal、万能service key、代替仓库写权限、会长读会员CRM。tenant移交是平台经营/管理权限变更，不能假定外部商家合同、银行账户或许可证也转让。

依赖既有session/command/core及SP-00；scope扩展单一owner。SP-01分类和SP-03静态/合成UI可并行；SP-04对接contract后并行。无需等ERP、每公会客制、外部自架、模型连线；正式tenant私有写入须等真实DB约束、ACL与资产scope验收。

## 3. 現有程式對照與 KEEP／MODIFY／NEW／GENERATED，精確到實際檔案

| 动作 | 精确路径 | 真实基础及未来职责 |
|---|---|---|
| KEEP | `modules/identity-membership/service.ts`、`modules/identity-membership/members.ts`、`packages/db/member-session.ts` | 当前Actor/session/users；新增tenant不是新增登录系统 |
| KEEP | `packages/db/command-core.ts`、`packages/db/member-command.ts`、`packages/db/transaction.ts` | 中立交易／旧receipt不可静默变更 |
| KEEP | `migrations/076_principal_resource_scopes.sql`、`migrations/077_work_scope_privacy.sql`、`migrations/078_scoped_member_commands.sql` | 历史约束与旧receipt，禁止改写旧migration |
| MODIFY | `packages/resource-scopes/index.ts` | 加具真实tenant backing及membership锁的tenant resolver；现状明确只接受personal/community |
| MODIFY | `packages/scoped-commands/index.ts` | 当前person session adapter opt-in tenant context、当前权限再验证；不把service凭证塞入actor |
| KEEP | `contracts/common/v1/identity.ts`、`contracts/common/v1/resource-scope-ref.schema.json` | v1 wire保持；schema的site分支也不是实际授权能力 |
| NEW（建议） | `contracts/common/v2/identity.ts`、`contracts/guild-launchpad/v1/tenant.ts` | tenant-aware类型与strict DTO；旧consumer不被强塞新enum |
| MODIFY | `scripts/build-common-contracts.ts` | 明确产v1及v2，不能手改generated schema |
| GENERATED（未建立） | `contracts/common/v2/principal-ref.schema.json`、`contracts/common/v2/resource-scope-ref.schema.json`、`contracts/guild-launchpad/v1/tenant.schema.json` | canonical Zod生成；合约bundle及SDK须以实际生成流程更新 |
| NEW（建议） | `modules/tenant-workspaces/service.ts`、`modules/tenant-workspaces/authorization.ts`、`modules/tenant-workspaces/ownership.ts`、`modules/tenant-workspaces/freedom.module.json` | 复用现有core的tenant领域边界，不是第二套通用auth引擎 |
| NEW（建议） | `apps/platform-api/src/routes/tenant-workspaces.ts` | shared member boundary下注册tenant routes |
| MODIFY | `apps/platform-api/src/platform-app.ts`、`apps/platform-api/src/member-boundary.ts` | 明确挂载、Origin/CSRF、安全headers；不绕过private-ai开关 |
| NEW（建议） | `apps/portal-web/src/modules/TenantSelector.tsx`、`apps/portal-web/src/modules/TenantSettings.tsx` | role、invite、transfer、recovery UI |
| MODIFY | `modules/opportunity-project-work/private-commands.ts`、`modules/opportunity-project-work/private-work.ts`、`modules/autopilot-work/results.ts` | SP-03/10共用的tenant_execution分支，personal逻辑保留 |
| NEW（建议） | `migrations/<next>_tenant_workspaces.sql`、`tests/runtime/tenant-authorization.test.ts`、`tests/runtime/tenant-ownership.test.ts` | expand及真实PG负向测试；migration为待分配logical名称，依最新main/相依PR分配，不预占数字 |
| MODIFY | `tests/runtime/resource-scopes.test.ts`、`tests/runtime/scoped-member-command.test.ts`、`tests/runtime/scoped-member-domain-revalidation.test.ts` | person／personal／community回归与tenant撤权重播 |

跨模组互通scope的service adapter由SP-09负责；本spec不宣称现有`PrincipalRef.kind='service'`已提供可用机器身份。旧`fw_read_`、自填GitHub slug、guild职务都维持原用途。

## 4. 資料模型、唯一性／關聯／tenant scope、owner／authority、版本與敏感欄位

### 4.1 提案表与不变量

- `tenants(tenant_id UUID PK, community_id UUID FK, display_name text, public_slug text nullable, status active|suspended|recovery_required|archived, version bigint>0, authorization_revision bigint>0, created_by_principal_id FK, created_at, updated_at)`。tenant与user/community/guild各自ID；community仅表示平台归属上下文，不是业务owner。
- `tenant_memberships(tenant_id,principal_id,role owner|admin|operator|viewer,status active|revoked,version bigint>0,accepted_at,revoked_at)`；PK `(tenant_id,principal_id)`，FK到真实active person backing；无owner_user_id列替代多人membership。`created_by`不是终身owner。
- `tenant_module_permissions(permission_id UUID PK,tenant_id,principal_id,instance_id,capabilities text[],purpose nullable,expires_at nullable,status active|revoked,version)`，复合FK验证instance同tenant；高风险能力必有purpose/expiry，普通role范围不能夹带export/migrate/binding能力。owner/admin默认从角色模板获得列明能力；operator/viewer必须显式范围，不能`*`隐式涵盖将来所有module。
- `workspaces(workspace_id UUID PK,tenant_id FK,name,status active|archived,version)`，UNIQUE `(tenant_id,workspace_id)`，每tenant一default由partial unique约束；workspace是容器，授权最低边界仍tenant+instance+资源ACL。
- `resource_scopes`增加新kind `tenant`、`tenant_ref UUID UNIQUE FK tenants`，shape CHECK保证tenant分支只tenant_ref有值；personal/community原约束保留、mapping immutable。`scope_id`不是tenant_id的同义词，server映射；FK(scope_id,kind,tenant_ref)用于资源约束。
- `tenant_invitations(invitation_id UUID PK,tenant_id,invitee_principal_id,role,instance_capabilities JSON,expires_at,state pending|accepted|declined|revoked|expired,version,created_by)`；同tenant/人仅一pending，邀请不能选owner，owner需transfer或明确owner-add流程（初版只transfer）。
- `tenant_ownership_transfers(transfer_id UUID PK,tenant_id,from_principal_id,to_principal_id,from_role_after admin|operator|viewer|revoked,state pending|accepted|declined|cancelled|expired|invalidated,expires_at,tenant_authorization_revision,version,accepted_at)`；同tenant仅一pending；锁tenant后处理，接收者须不同于发起者。
- `tenant_recovery_cases(case_id,tenant_id,state opened|evidence_required|approved|executed|denied|cancelled,proposed_owner_principal_id,approved_scope,expires_at,version,audit_ref)`；批准与执行不同actor；无内容读权限，仅受限identity/membership metadata。
- `tenant_authority_audit(event_id,tenant_id,actor_principal_id,action,target_principal_id?,old_revision,new_revision,reason_code,proof_ref?,timestamp)`；不保存密码／cookie／重验原文／客户数据。

tenant至少一位**有效可登入owner**是正常active经营不变量；帐号停用可能外部触发例外，进入recovery_required并记录原因，不能强制阻止平台安全停权。禁止DELETE最后owner以及先删旧owner后异步加新owner。历史revoked membership保留，不因邀请复用而重置version。

普通guild内容为community数据；tenant config、Work、CRM等是tenant业务资料。tenant identity/membership/binding registry由平台控制面负责；某module外移后业务authority改变，但tenant ID与经营role引用不因location改变。其外部离线授权快照有有效期和能力边界，详SP-09；不能把中央不可用误报为所有本地资料消失。

### 4.2 能力矩阵（目标默认，业务领域可进一步缩小）

| 动作 | owner | admin | operator | viewer | 仅guild leader／expert |
|---|---|---|---|---|---|
| 读获准module资料 | 是 | 是 | 显式module read | 显式module read | 否 |
| 人工Work／领域写入 | 是 | 是 | 显式module write | 否 | 否 |
| 启动／停用instance | 是 | 是，需entitlement | 否 | 否 | 否 |
| 邀请admin/operator/viewer | 是 | 仅operator/viewer | 否 | 否 | 否 |
| 撤销成员／修改role | 是，不能破坏last-owner | 仅operator/viewer且不能操作owner/admin | 否 | 否 | 否 |
| tenant所有权移交 | `tenant.ownership.transfer`＋新验证 | 否 | 否 | 否 | 否 |
| 批量export | `module.data.export`＋新验证＋明确module scope | 默认否，可单独授予此capability | 默认否，可单独授予 | 否 | 否 |
| migrate／external binding | `module.authority.transfer`／`module.binding.manage`＋新验证 | 默认否 | 否 | 否 | 否 |
| 编辑公会公告／推荐 | 仅另有guild权限 | 同左 | 同左 | 同左 | 依guild职务，不能延伸至tenant |

高风险capability授予仅owner可做，初版仅允许把`module.data.export`另授给admin/operator，迁移/binding仍owner-only；必须限定instance、purpose、expiry且scope不得超本人权限；UI把「管理人员」与「整批带走客户资料」分开。未来member service／machine读取需真实adapter与grant；任何输入`role:'owner'`均只是邀请目标，不是caller权限证明。

### 4.3 锁与当前权限

使用现有user/session→principal→scope→tenant/membership→target的统一锁顺序；receipt namespace含principal、authn_kind、scope_id、operation、key，digest含target、expected/body。读receipt前、写receipt后重验当前membership、tenant state、authorization_revision及DB clock。跨人transfer涉及锁两人的活跃状态，按稳定UUID排序，不能发起/接受反向锁导致死锁。scope resolver只从已认证actor和server查得的membership建立context，不接受JSON scope/principal/grant。

创建与待接受例外必须是封闭adapter：tenant.create在caller既有personal scope中以本人collection为receipt target，交易内才生成tenant/scope/owner；invite.accept/decline、transfer.accept/decline、recovery.accept在本人personal scope以指定邀请/移交/case ID作receipt target，server锁定目标记录并验证invitee/recipient等于当前principal后才进入限定的tenant变更。它们不要求预先已有tenant membership，也不给通用tenant query或业务读权限；不能把这条例外用作任意tenant resolver。receipt namespace在接受前后保持同一personal profile；终态重播只回最小确认且重新验证帐号/指定接收者/必要的当前membership，已撤权限不通过旧邀请恢复。正常tenant业务仍一律current tenant membership。

## 5. API／command／query／event 的完整輸入輸出、錯誤、身份、冪等及並行語意

### 5.1 型别与headers

全新路径 `/api/v1/tenants`；UUID与Version沿contracts（positive decimal string）、UTC时间、strict JSON无未知字段。mutation需session＋CSRF/Origin＋现行8–128 Idempotency-Key；变更需If-Match，missing428、stale412。个人/tenant响应no-store、Vary Cookie。query不得接受`actor/role/grant/scope_id/owner_user_id`来决定权限。

```ts
type TenantRole='owner'|'admin'|'operator'|'viewer';
type ExportPermissionView={permission_id:UUID;tenant_id:UUID;principal_id:UUID;instance_id:UUID;
 capability:'module.data.export';purpose:string;expires_at:string;status:'active'|'revoked';version:Version};
type RecoveryCaseView={case_id:UUID;tenant_id:UUID;proposed_owner_principal_id:UUID;
 state:'opened'|'evidence_required'|'approved'|'executed'|'denied'|'cancelled';
 approved_scope:('tenant.owner.restore')[];expires_at:string|null;recipient_accepted:boolean;version:Version};
type TenantStatus='active'|'suspended'|'recovery_required'|'archived';
type TenantView={tenant_id:UUID;community_id:UUID;display_name:string;public_slug:string|null;
  status:TenantStatus;version:Version;authorization_revision:Version;
  my_membership:{role:TenantRole;version:Version};
  capabilities:{instance_id:UUID|null;keys:string[]}[];default_workspace_id:UUID};
type WorkspaceView={workspace_id:UUID;tenant_id:UUID;name:string;status:'active'|'archived';version:Version};
type MemberView={principal_id:UUID;display_name:string;role:TenantRole;status:'active'|'revoked';
  instance_capabilities:{instance_id:UUID;capabilities:string[]}[];version:Version};
type InvitationView={invitation_id:UUID;tenant_id:UUID;invitee_principal_id:UUID;role:Exclude<TenantRole,'owner'>;
  instance_capabilities:{instance_id:UUID;capabilities:string[]}[];
  state:'pending'|'accepted'|'declined'|'revoked'|'expired';expires_at:string;version:Version};
type TransferView={transfer_id:UUID;tenant_id:UUID;from_principal_id:UUID;to_principal_id:UUID;
  from_role_after:'admin'|'operator'|'viewer'|'revoked';
  state:'pending'|'accepted'|'declined'|'cancelled'|'expired'|'invalidated';expires_at:string;version:Version};
```

所有capability採共同CapabilityKey grammar且必在registry登記；無wildcard。invite/member.change中的instance_capabilities只允普通read/write，明拒export/migrate/binding/ownership等高風險keys。

所有列表使用共同cursor，`limit`默认20、最大100（推荐待policy核定），`next_cursor:string|null,source_version:Version`；cursor绑定caller、tenant、过滤条件，不能跨tenant重放。空列表不是404；不可访问具体tenant/instance统一404，避免枚举。

### 5.2 Endpoint完整契约

| endpoint／operation | 输入 | 成功输出 | 授权／副作用 |
|---|---|---|---|
| GET `/tenants` | `{cursor?:string,limit?:int}` | `{items:TenantView[],next_cursor:string\|null,source_version:Version}` | 只列本人active membership |
| POST `/tenants` `tenant.create` | `{display_name:string(1..120),workspace_name?:string(1..120)}` | 201 `{tenant:TenantView,workspace:WorkspaceView}` | 有效平台person、tenant创建policy/quota；原子建立scope、owner、workspace；不需guild主力 |
| GET `/tenants/:tenant_id` | `{}` | `TenantView` | active tenant membership；suspended/recovery只回自身可见metadata |
| POST `/tenants/:tenant_id/edit` `tenant.edit` | `{display_name:string(1..120),public_slug:string\|null}` | `TenantView` | owner/admin；slug小写ASCII 3..64、保留字检查、唯一冲突409；不改stable ID |
| GET `/tenants/:tenant_id/members` | `{cursor?,limit?}` | `{items:MemberView[],next_cursor,source_version:Version}` | owner/admin；普通人只看本人my_membership |
| POST `/tenants/:tenant_id/invitations` `tenant.invite` | `{invitee_principal_id:UUID,role:'admin'\|'operator'\|'viewer',instance_capabilities:{instance_id:UUID,capabilities:string[]}[],expires_at:string}` | 201 `InvitationView` | owner/admin且受矩阵限制；不自动加人；目标为真实平台person，无隐藏email匹配 |
| GET `/me/tenant-invitations` | `{cursor?,limit?}` | `{items:InvitationView[],next_cursor,source_version:Version}` | 当前受邀principal，仅最小tenant名称及邀请scope |
| POST `/tenants/:tenant_id/invitations/:id/accept` `tenant.invite.accept` | `{}`＋invite If-Match | `{invitation:InvitationView,membership:MemberView}` | 仅指定invitee；重验邀请方现权及有效期、capabilities当前仍可授予，原子active |
| POST `/tenants/:tenant_id/invitations/:id/decline` `tenant.invite.decline` | `{}` | `InvitationView` | 指定invitee；不建membership |
| POST `/tenants/:tenant_id/invitations/:id/revoke` `tenant.invite.revoke` | `{reason:string(3..1000)}` | `InvitationView` | 创建者仍有邀请权限或owner |
| POST `/tenants/:tenant_id/members/:principal_id/change` `tenant.member.change` | `{role:'admin'\|'operator'\|'viewer',status:'active'\|'revoked',instance_capabilities:{instance_id:UUID,capabilities:string[]}[],reason:string(3..1000)}` | `MemberView` | owner或受限admin；不能用此接口加owner、复活未接受invite、移除最后owner；若target为owner须owner-transfer路径 |
| POST `/tenants/:tenant_id/export-permissions` `tenant.export-permission.create` | `{principal_id:UUID,instance_id:UUID,purpose:string(3..500),expires_at:string}` | 201 `ExportPermissionView` | owner＋新验证；target须active admin/operator，instance同tenant；只授module.data.export，expiry不得超过已核policy |
| GET `/tenants/:tenant_id/export-permissions` | `{cursor?:string,limit?:int}` | `Page<ExportPermissionView>` | owner看全部，非owner仅看本人授权 |
| POST `/tenants/:tenant_id/export-permissions/:id/revoke` `tenant.export-permission.revoke` | `{reason:string(3..1000)}`＋If-Match | `ExportPermissionView` | owner；立刻升authorization_revision，正在export/download必须重验 |
| POST `/tenants/:tenant_id/leave` `tenant.member.leave` | `{}`＋本人membership If-Match | `{status:'revoked',version:Version}` | 本人；最后owner409；撤销后不回其他tenant内容 |
| POST `/tenants/:tenant_id/ownership-transfers` `tenant.ownership.propose` | `{to_principal_id:UUID,from_role_after:'admin'\|'operator'\|'viewer'\|'revoked',expires_at:string,reason:string(3..1000)}` | 201 `TransferView` | owner＋新验证；不立即授权接收者 |
| GET `/tenants/:tenant_id/ownership-transfers/:id` | `{}` | `TransferView`及最小tenant名称 | 发起owner或指定接收者；接收者不因此读业务 |
| POST `/tenants/:tenant_id/ownership-transfers/:id/accept` `tenant.ownership.accept` | `{accept_scope:true}`＋transfer If-Match | `{transfer:TransferView,tenant_id:UUID,authorization_revision:Version,my_role:'owner'}` | 仅接收person、新验证；发起者仍owner、policy及authrevision未变；原子角色变更，invalidate旧grants |
| POST `/tenants/:tenant_id/ownership-transfers/:id/cancel` `tenant.ownership.cancel` | `{reason:string(3..1000)}` | `TransferView` | 发起者仍owner；接收者拒绝使用下项 |
| POST `/tenants/:tenant_id/ownership-transfers/:id/decline` `tenant.ownership.decline` | `{}` | `TransferView` | 仅指定接收者 |
| POST `/tenants/:tenant_id/workspaces` `tenant.workspace.create` | `{name:string(1..120)}` | 201 `WorkspaceView` | owner/admin；quota |
| GET `/tenants/:tenant_id/workspaces` | `{cursor?,limit?}` | `{items:WorkspaceView[],next_cursor,source_version:Version}` | active membership；只列可见workspace，不暗示全部业务读权 |

新验证采用现有登录/密码验证服务的受控扩展：server记录`authenticated_at`与短期高风险验证上下文，绑定person+tenant+purpose+expiry；不是caller时间戳／JSON `reauthenticated=true`。基线尚无可直接套用的tenant fresh-auth机制，必须新增并测试；建议有效窗10分钟（待批准），不存在可信timestamp时要求重新登入，不推测created_at就是最近验证。密码仅经既有HTTPS登入处理，不进command body/receipt/audit。

### 5.3 最后owner的受控恢复

安全管理面与会员API分离。建议受限existing admin boundary下新增：

- POST `/admin/tenant-recovery-cases` 输入 `{tenant_id:UUID,proposed_owner_principal_id:UUID,reason:string(3..1000),evidence_ref:UUID}`；输出`RecoveryCaseView`，state为evidence_required。需要独立`tenant.recovery.open`权限，不是普通guild leader；evidence_ref指受限证据而非上传身份证原文。
- POST `/admin/tenant-recovery-cases/:id/approve` 输入 `{approved_scope:['tenant.owner.restore'],expires_at:string,reason:string(3..1000)}`＋If-Match；输出`RecoveryCaseView`。独立授权reviewer、不能是发起者或目标；记录可验证责任人与范围。
- POST `/admin/tenant-recovery-cases/:id/execute` 输入 `{}`＋If-Match；输出 `{case:RecoveryCaseView,authorization_revision:Version}`，case.state='executed'。再次确认没有恢复的合法owner、审批未过期、目标仍active，且目标本人已通过受限acceptance；执行者不能扩大scope。只能恢复管理角色，不读取/导出业务内容。
- 目标通过 `/me/tenant-recovery-cases/:id/accept` POST `{accept_scope:true}` 与新验证表达接受，返回`RecoveryCaseView`，recipient_accepted=true；该行为未完成审批前不授owner。

读取/撤回配套：GET `/me/tenant-recovery-cases` 返回`Page<RecoveryCaseView>`仅列本人受让case，不含evidence；GET `/admin/tenant-recovery-cases/:id`返回`RecoveryCaseView`加`evidence_ref:UUID`，仅具recovery.read的授权人员。POST `/admin/tenant-recovery-cases/:id/close`输入`{decision:'denied'|'cancelled',reason:string(3..1000)}`＋If-Match，回RecoveryCaseView，仅受控reviewer；已executed不可用close回退。所有case变更沿当前权限、幂等、版本和事件规则。

case错误、批准撤回或没有足够可信证据：保持`recovery_required`，允许原有其他角色在安全policy允许范围读资料／申请受控交接，禁止自动派会长接管。建议review窗口7日、审批24小时有效、每tenant最多一open case均为待批准操作policy；到期只升级人工处理状态，不自动取得owner或删除数据。此流程不是新增日常启动委员会，正常create/invite完全自助。

### 5.4 错误／并行／事件

Problem wire `{type,title,status,code,detail}`。400 malformed UUID/header/body；401 `session_expired`；403 `tenant_capability_denied|guild_full_member_required|fresh_auth_required|recovery_authority_required|policy_unconfigured`；404 `tenant_not_found|invitation_not_found|transfer_not_found`；409 `last_owner_required|invitation_expired|transfer_expired|transfer_authority_changed|tenant_recovery_required|tenant_suspended|slug_conflict|idempotency_conflict`；412 version conflict；428 version_required；429 quota/rate；503 foundation_mapping_unavailable。只在caller已经有metadata读权时给细分state，否则404。

每次mutation同时锁tenant与相关membership，变更authorization_revision、audit/outbox、receipt一个交易。收到相同key及hash仍须重验当前authority；撤权后旧receipt不泄漏数据。高风险「接受后本人不再有旧role」由server限定receipt回`tenant_id/state/revision`最小结果，不能借一般replay恢复原权限；若当前被彻底撤权，则返回拒绝，客户端由状态通知得知完成。

以下為平台控制面scoped journal/outbox事件，使用明確版本的control-plane payload schema；不套SP-05要求source_instance_id的module資料envelope，tenant.create尚無module亦不捏造ID：`freedom.tenant.created.v1` payload `{tenant_id,version}`；`freedom.tenant.membership.changed.v1` `{tenant_id,principal_id,role,status,authorization_revision}`；`freedom.tenant.ownership.transferred.v1` `{tenant_id,transfer_id,from_principal_id,to_principal_id,authorization_revision}`；`freedom.tenant.recovery.required.v1` `{tenant_id,case_id?,reason_code,authorization_revision}`。仅授权的control-plane consumer可收，guild公共feed不接收；以event_id去重及revision防旧权限复活。

## 6. 狀態機與成功、失敗、結果未知、重啟、撤權、版本不符及部分完成分支

- Tenant `active → suspended`（风险停权）／`recovery_required`（无可用owner）／`archived`（明确退场）。恢复active仅经合格owner/受控recovery，archive不等于erasure。guild leave不转tenant state；方案停写由SP-11独立记录。
- Invite `pending→accepted|declined|revoked|expired`。接受与撤销竞态在同row锁下只能一个结果；inviter在等待期间被撤权，accept失败而非继承旧权限。
- Transfer `pending→accepted|declined|cancelled|expired|invalidated`。tenant授权版本变化令pending invalidated，需重新提案；不在后台重新解释收受范围。接受同时完成双方role，不存在无owner间隙。
- 交易提交但ACK丢失：同key+digest retry读receipt／当前state；不再建tenant或转给另一个人。DB rollback保持原owner；通知失败由outbox续送，不回滚已完成权力事实。
- revoke即增加authorization_revision，清cache、吊销匹配capability/grant/connection。正在进行的IO需在commit／Asset publish前重验（SP-06/09）；replay当前权力先于receipt。
- 服务重启从DB memberships／pending transfer／outbox恢复，不能用browser localStorage的role。过期状态用DB clock；扫尾job只是显示优化，安全检查不等cron。
- 不相容scope版本：tenant能力503/明确upgrade_required；旧personal/community行为保持。部分owner恢复流程未完成时绝不显示「已移交」。

## 7. UI、可見性、空狀態、載入／失敗、手機、無障礙與人工接手

持续显示业务名称＋本人role，避免只写「我的公会」。第一次为空提供「建立业务空间」与已受邀列表；不强迫建公司、绑定模型或选满主力。切A→B立即清A数据、取消请求、缓存key包含session/tenant/workspace/revision；迟到A响应丢弃，B加载失败也不回显A内容。

guild管理员区与tenant设置区分开；owner不能凭角色编辑公会公告，会长不能看他人instance清单。邀请和移交用可验证principal名称/识别上下文、roles、module范围、原owner后续role、有效期的明确review；不以公会昵称猜收受者。受让人必须有独立接受按钮，未接受显示待确认，不宣称完成。

高风险授权提供导出/迁移专属开关及有限期限，不能藏在「编辑」复选框。最后owner拒绝时给「先完成移交」及恢复支持路径，不能以关账号让资料自动删除。安全停权可显示可申诉/资料交接方法，但不泄露管理员证据。手机44px控制、label/fieldset、keyboard/focus与aria-live，沿DESIGN tokens；Back/Cancel撤销UI草稿不取消已提交transfer，需显式cancel command。

## 8. 資料匯出／匯入／升級／清理／回復及 legacy 相容；不適用需寫理由

- Expand：新表与tenant scope，不触碰076不可变person/personal mappings，不把community_id重命名成tenant_id。先为合成数据启用tenant branches，旧personal Work仍owner-only。
- Backfill：由经核实resource owner建立`legacy_resource_tenant_map(resource_kind,legacy_id,tenant_id,instance_id,evidence_ref,state)`；多个品牌／共同业务／seller_ref歧义进入quarantine/待核实，不能放global tenant或当前登录者名下。只从所有者证据映射，不按创作者字符串合并。
- Switch：每资源模块独立读写adapter、复合FK与ACL对帐，old IDs保持；缺tenant语义的旧写入拒升级，不暗推默认tenant。新业务开在明确tenant，不顺便迁移旧数据。
- Export：业务包可带tenant稳定ID、workspace、必要role映射占位和actor来源，但不带平台users全表、邮箱、密码hash、session、grants秘密。目标系统principal映射由tenant owner重新确认，导入不能冒充平台owner或恢复已撤权限。
- Import/clone：迁移保留tenant/module资源身份并做受控binding；clone新tenant/instance IDs和引用映射，原role不自动授予克隆目标。
- Recovery：恢复备份后先应用membership revocation、authorization revision floor、scope disabled与迁移epoch；验证last-owner case仍有效后才开放服务。旧备份不得复活撤销邀请、过期transfer或旧keys。
- Cleanup：archive保留可恢复metadata；最终erasure须SP-06/07与有权人另行流程，不由leave/revoke触发。本spec不批准正式DB转移或删除。

## 9. 威脅模型、最小權限、秘密、外部入口、cost／capacity 與安全反例

IDOR、混淆代理、跨tenant复合FK缺漏、缓存context复用、transfer竞态、last-owner竞态、stale receipt、DB pool状态串租户是必须负向测试。UI隐藏按钮、public_slug、guild full或headers `X-Tenant-Role`均不是权限。新的tenant scope没有有效backing/membership时fail closed，不lazy创建任意tenant。

新验证只用trusted server记录；session秘密不进URL、audit或可携包。平台admin recovery不内建CRM read；support证据最小化、权限与访问留痕。外部endpoint/SSRF/key设置走SP-09，不允许tenant.edit顺便填任意webhook并自动请求。

建议待定capacity：每person 5 active tenants、每tenant 100 active members、10 workspaces、20 pending invites；invite有效期7日、transfer24小时、fresh-auth10分钟、recover审批24小时；均为技术测试起点与可配置policy，不是已承诺产品额度／价格。policy缺失时阻止新的容量／高风险操作并保留已有资料读与受控恢复；不能解释成无限或立即删除。

不新增无限量role grants：capability数组有最大100、instance范围明列且≤100、字符串为registry键；不允许glob/任意JSON policy。jobs含tenant_id/instance_id且server重验，不能继承上一个request的context。

## 10. 可重現 fixtures、測試環境、T-ID 驗收、發布條件、證據與未完成項目

隔离真实PostgreSQL：person A在tenant A owner、B viewer；person B在B owner；guild master M不属A；intern I和非主力full F；disabled person D；two owners X/Y；停权唯一owner Z。各tenant两个workspace/module、相同公开slug候选、同样title的私有Work。service fixture只有SP-09明确建立后可用，不能自己插入假万能principal。

| T-ID | 可重现步骤 | 预期／证据 |
|---|---|---|
| T-003 | F非主力full有tenant-admin，I主力intern做launch | F通过资格，I403；换主力前后membership与ACL digest相同 |
| T-007 | M改本guild公告，再读A Work/CRM/export/instance | 公告成功，其余404/403；日志无tenant业务内容 |
| T-011 | 改slug、transfer、增加第二tenant后比对所有IDs；猜他人URL | stable IDs不变；跨tenant404；public route只投影 |
| T-013 | A/B交错请求/并行tab/DB pool reuse、viewer写入、伪造role字段 | 按当次tenant role；viewer写403；role/scope字段严格拒绝 |
| T-014 | transfer无接受、错误recipient、过期、from被撤权；双last-owner离开并行 | 无接受不移交；只有指定人接受成功；不能零owner；一成功另一409 |
| T-014 | 唯一owner安全停用，重复/自批recovery、无目标acceptance | 保留数据recovery_required；禁止自批/过期/无接受执行；会长无接管权限 |
| T-015 | operator业务写成功，尝试export/migrate与读旧owner receipt | 专属scope缺失拒绝；receipt不越权；领域记录不删除 |
| T-016 | leave、降tier、停止补助、安全停权分别触发 | 不destroy；plan状态与安全state区分；低风险读/交接依明确policy |
| T-022 | 修改workspace/module/asset tenant FK、批次混A/B、search/cache/jobs | API与真实DB role均拒绝，所有路径有不串租户证据 |
| T-049 | receipt SELECT/INSERT等待期间revocation/session expiry | commit或replay前再验拒绝；业务/receipt/outbox一起rollback |
| T-039 | tenant包解包检查 | 不含users/session/secret；新principal mapping不能导入授权 |
| T-054 | 有主/无主/多品牌legacy dry-run，restore过期transfer | 歧义不默认归户；旧private权限不变；备份不复活撤销 |

未来验证 `npm run typecheck`、`npm run build`、`npm test`、`npm run test:contracts`、`npm run test:e2e`，具真实受限DB role、交错pool/异常/rollback，复用现有scoped-member命令测试。证据须列source/head SHA、schema revision、角色权限SQL、每T输入/实际输出/DB行数/audit、授权撤销时间点、合成fixture与失败堆栈去秘密版本。

本轮文档未运行这些能力／测试，未创建tenant／invite／transfer。发布前必须完成tenant scope端到端、role矩阵与否认测试、fresh-auth可信时间、last-owner恢复责任/时限批准、外部能力关闭默认、legacy对帐、SP-06隔离恢复前置。尚待定值：OPEN-02认证email政策、OPEN-03 high-risk验证窗口及recovery操作人员、OPEN-04/13 quota、OPEN-07保留期。普通公版设计/fixture不必等待这些运营定值，真实高风险mutation在policy缺失时关闭。
