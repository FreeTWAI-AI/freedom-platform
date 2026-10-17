import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {useDistributionPhotos,type DistributionPhotoSender} from './distribution-photos';
import type { PortalClient } from '../../../../../apps/portal-web/src/api';
import {
  PartnerMaterialsSchema,
  type PartnerMaterial,
  type PartnerMaterials as PartnerMaterialsData,
} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import {
  formatTaipeiTime,
  groupPartnerMaterials,
  materialAccessText,
  materialAppliesText,
  materialContentSummary,
  materialKindLabel,
  materialVersionText,
  partnerMaterialPath,
  partnerMaterialsFailureState,
} from './partner-materials';

export type PartnerMaterialsViewState =
  | { kind: 'loading' }
  | { kind: 'failed'; error?: string; staleData?: PartnerMaterialsData }
  | { kind: 'ready'; data: PartnerMaterialsData; refreshing?: boolean };

export interface PartnerMaterialsViewProps {
  state: PartnerMaterialsViewState;
  tenantId: string;
  instanceId: string;
  mediaEnabled?: boolean;
  onReload?: () => void;
  onRetry?: () => void;
  distributionContent?:ReactNode;
  renderDistribution?:(material:PartnerMaterial)=>ReactNode;
  /** Increments only after a successful read for this mounted scope. */
  mediaAttempt?: number;
}

export function PartnerMaterialsView({
  state,
  tenantId,
  instanceId,
  mediaEnabled = false,
  mediaAttempt = 0,
  onReload,
  onRetry,
  distributionContent,
  renderDistribution,
}: PartnerMaterialsViewProps) {
  const [copyStatus, setCopyStatus] = useState<Record<string, string>>({});
  const [failedMedia, setFailedMedia] = useState<Record<string, boolean>>({});
  const [seenAttempt, setSeenAttempt] = useState(mediaAttempt);
  const copyBodyRefs = useRef<Record<string, HTMLElement | null>>({});
  // One successful metadata read clears the previous media failure so the same URL can be requested again.
  if (seenAttempt !== mediaAttempt) {
    setSeenAttempt(mediaAttempt);
    setFailedMedia({});
  }

  const markFailed = (path: string) => {
    setFailedMedia(prev => (prev[path] ? prev : { ...prev, [path]: true }));
  };

  const handleCopyText = async (materialId: string, body: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(body);
      setCopyStatus(prev => ({ ...prev, [materialId]: '已複製。' }));
    } catch {
      const el = copyBodyRefs.current[materialId];
      if (el && window.getSelection) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopyStatus(prev => ({ ...prev, [materialId]: '請手動選取並複製。' }));
    }
  };

  const renderMaterialCard = (item: PartnerMaterial) => {
    const path = partnerMaterialPath(
      tenantId,
      instanceId,
      item.material_id,
      item.current.version_id,
    );
    const content = item.current.content;

    return (
      <article className="card stack" key={item.material_id}>
        <div className="partner-material-badge-row">
          <span className="badge">{materialKindLabel(item.kind)}</span>
        </div>
        <strong>{item.title}</strong>
        {item.description ? (
          <p style={{ whiteSpace: 'pre-wrap' }}>{item.description}</p>
        ) : null}
        <p className="field-hint">{materialAppliesText(item)}</p>
        <p className="field-hint">{materialVersionText(item)}</p>
        <p className="field-hint">{materialAccessText(item.access)}</p>

        {content.kind === 'copy' && (
          <>
            <div
              className="partner-material-copy"
              style={{ whiteSpace: 'pre-wrap' }}
              ref={el => {
                copyBodyRefs.current[item.material_id] = el;
              }}
            >
              {content.body}
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => void handleCopyText(item.material_id, content.body)}
              >
                複製文字
              </button>
              {copyStatus[item.material_id] ? (
                <span className="field-hint" role="status">
                  {copyStatus[item.material_id]}
                </span>
              ) : null}
            </div>
          </>
        )}

        {content.kind === 'image' && (
          <>
            {!mediaEnabled ? (
              <p className="field-hint">這個環境尚未開放素材檔案。</p>
            ) : failedMedia[path] ? (
              <p className="field-hint">素材暫時無法讀取。</p>
            ) : (
              <>
                <img
                  src={path}
                  alt={item.title}
                  width={content.width}
                  height={content.height}
                  loading="lazy"
                  style={{ maxWidth: '100%', height: 'auto' }}
                  onError={() => markFailed(path)}
                />
                <div className="actions">
                  <a className="btn btn-ghost btn-small" href={path} download>
                    下載
                  </a>
                </div>
              </>
            )}
          </>
        )}

        {content.kind === 'video' && (
          <>
            {!mediaEnabled ? (
              <p className="field-hint">這個環境尚未開放素材檔案。</p>
            ) : failedMedia[path] ? (
              <p className="field-hint">素材暫時無法讀取。</p>
            ) : (
              <>
                <video
                  controls
                  preload="metadata"
                  src={path}
                  style={{ maxWidth: '100%' }}
                  onError={() => markFailed(path)}
                />
                <p className="field-hint">{materialContentSummary(content)}</p>
                <div className="actions">
                  <a className="btn btn-ghost btn-small" href={path} download>
                    下載
                  </a>
                </div>
              </>
            )}
          </>
        )}
        {renderDistribution?.(item)}
      </article>
    );
  };

  const renderItemsList = (items: PartnerMaterial[], truncated: boolean) => {
    const groups = groupPartnerMaterials(items);

    return (
      <>
        {truncated && <p className="field-hint">只顯示前 200 筆素材。</p>}
        {groups.map((group, index) => (
          <div className="partner-materials-supplier stack" key={`${index}:${group.supplier}`}>
            <h4>{group.supplier}</h4>
            {group.brand.length > 0 && (
              <div className="partner-materials-brand-group stack">
                <h5>品牌素材</h5>
                <div className="stack">
                  {group.brand.map(item => renderMaterialCard(item))}
                </div>
              </div>
            )}
            {group.products.map(prod => (
              <div className="partner-materials-product-group stack" key={prod.productId}>
                <h5>{prod.title}</h5>
                <div className="stack">
                  {prod.items.map(item => renderMaterialCard(item))}
                </div>
              </div>
            ))}
          </div>
        ))}
        <p className="field-hint">
          素材的使用範圍以供應商的授權為準。已下載的檔案由你自行保管；供應商撤回或你停止合作後，這裡將不再提供。
        </p>
      </>
    );
  };

  return (
    <section className="partner-materials stack" aria-labelledby="partner-materials-title">
      <h3 id="partner-materials-title">合作素材</h3>
      <p>供應商授權給這間店的行銷素材。只會顯示你目前仍在販售或等待確認的合作。</p>

      {distributionContent}

      {state.kind === 'loading' && (
        <p role="status">正在讀取合作素材…</p>
      )}

      {state.kind === 'failed' && !state.staleData && (
        <>
          <p className="banner banner-error" role="alert">
            目前無法讀取合作素材。{state.error ? ` ${state.error}` : ''}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={onRetry}>
              重試
            </button>
          </div>
        </>
      )}

      {state.kind === 'failed' && state.staleData && (
        <>
          <p className="banner banner-error" role="alert">
            顯示的是 {formatTaipeiTime(state.staleData.as_of)} 的資料，最新讀取失敗。{state.error ? ` ${state.error}` : ''}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={onRetry}>
              重試
            </button>
          </div>
          {renderItemsList(state.staleData.items, state.staleData.truncated)}
        </>
      )}

      {state.kind === 'ready' && (
        <>
          <div className="actions">
            <span>資料時間 {formatTaipeiTime(state.data.as_of)}</span>
            {state.refreshing && (
              <span role="status" className="field-hint">
                正在更新…
              </span>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={onReload}
              disabled={state.refreshing}
            >
              重新整理
            </button>
          </div>
          {state.data.items.length === 0 ? (
            <p>目前沒有供應商授權給這間店的素材。供應商授權後會出現在這裡；你停止販售或對方撤回後，素材會從這裡移除。</p>
          ) : (
            renderItemsList(state.data.items, state.data.truncated)
          )}
        </>
      )}
    </section>
  );
}

export interface PartnerMaterialsProps {
  client: PortalClient;
  userId: string;
  tenantId: string;
  instanceId: string;
  active: boolean;
  refresh: number;
  mediaEnabled?: boolean;
  distributionPhotosEnabled?:boolean;
  writable?:boolean;
  busy?:boolean;
  onCommand?:DistributionPhotoSender;
}

export function PartnerMaterials({
  client,
  userId,
  tenantId,
  instanceId,
  active,
  refresh,
  mediaEnabled = false,
  distributionPhotosEnabled=false,writable=false,busy=false,onCommand,
}: PartnerMaterialsProps) {
  const distribution=useDistributionPhotos({client,userId,tenantId,instanceId,active,refresh,enabled:distributionPhotosEnabled,writable,busy,onCommand});
  const [state, setState] = useState<PartnerMaterialsViewState>({ kind: 'loading' });
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const dataRef = useRef<PartnerMaterialsData | null>(null);
  const ticketRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const userRef = useRef(userId);
  const tenantRef = useRef(tenantId);
  const instanceRef = useRef(instanceId);

  // Keep refs updated on every render to track current props
  userRef.current = userId;
  tenantRef.current = tenantId;
  instanceRef.current = instanceId;

  // Clear stale data if user, tenant, or instance changes
  const prevScopeRef = useRef({ userId, tenantId, instanceId });
  if (
    prevScopeRef.current.userId !== userId ||
    prevScopeRef.current.tenantId !== tenantId ||
    prevScopeRef.current.instanceId !== instanceId
  ) {
    prevScopeRef.current = { userId, tenantId, instanceId };
    dataRef.current = null;
    ticketRef.current += 1;
    abortRef.current?.abort();
    setMediaAttempt(0);
    if (state.kind !== 'loading') setState({ kind: 'loading' });
  }

  const load = useCallback(async () => {
    const currentTicket = ++ticketRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const startGeneration = client.sessionGeneration;
    const startUserId = userId;
    const startTenantId = tenantId;
    const startInstanceId = instanceId;

    const isStale = () =>
      !mountedRef.current ||
      ticketRef.current !== currentTicket ||
      controller.signal.aborted ||
      client.sessionGeneration !== startGeneration ||
      userRef.current !== startUserId ||
      tenantRef.current !== startTenantId ||
      instanceRef.current !== startInstanceId;

    if (dataRef.current) {
      setState({ kind: 'ready', data: dataRef.current, refreshing: true });
    } else {
      setState({ kind: 'loading' });
    }

    const path = `/tenants/${encodeURIComponent(tenantId)}/storefronts/${encodeURIComponent(instanceId)}/partner-materials`;
    try {
      const raw = await client.get(path, { signal: controller.signal });
      if (isStale()) return;
      const parsed = PartnerMaterialsSchema.parse(raw);
      dataRef.current = parsed;
      setMediaAttempt(attempt => attempt + 1);
      setState({ kind: 'ready', data: parsed });
    } catch (err) {
      if (isStale()) return;
      const settled = partnerMaterialsFailureState(dataRef.current, err);
      dataRef.current = settled.data;
      setState(settled.state);
    }
  }, [client, userId, tenantId, instanceId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (active) {
      void load();
    }
  }, [active, refresh, load]);

  return (
    <PartnerMaterialsView
      key={`${userId}:${tenantId}:${instanceId}`}
      state={state}
      tenantId={tenantId}
      instanceId={instanceId}
      mediaEnabled={mediaEnabled}
      distributionContent={distribution.above}
      renderDistribution={distribution.renderMaterial}
      onReload={() => {void load();void distribution.reload();}}
      onRetry={() => {void load();void distribution.reload();}}
      mediaAttempt={mediaAttempt}
    />
  );
}
