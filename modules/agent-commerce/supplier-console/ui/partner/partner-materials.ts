import type {
  PartnerMaterial,
  PartnerMaterials,
  SupplyMaterialContent,
} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import { ApiError } from '../../../../../apps/portal-web/src/api';

export interface PartnerMaterialProductGroup {
  productId: string;
  title: string;
  items: PartnerMaterial[];
}

export interface PartnerMaterialSupplierGroup {
  supplier: string;
  brand: PartnerMaterial[];
  products: PartnerMaterialProductGroup[];
}

/**
 * Returns the API path for reading a partner material version content.
 */
export function partnerMaterialPath(
  tenantId: string,
  instanceId: string,
  materialId: string,
  versionId: string,
): string {
  return `/api/v1/tenants/${encodeURIComponent(tenantId)}/storefronts/${encodeURIComponent(instanceId)}/partner-materials/${encodeURIComponent(materialId)}/versions/${encodeURIComponent(versionId)}/content`;
}

/**
 * Groups consecutive items with the same supplier_name;
 * inside each group, brand items are placed first, then product items grouped by
 * subject.product_id in first-seen order. Never re-sorts or merges non-consecutive groups.
 */
export function groupPartnerMaterials(items: readonly PartnerMaterial[]): PartnerMaterialSupplierGroup[] {
  const groups: PartnerMaterialSupplierGroup[] = [];
  for (const item of items) {
    let current = groups[groups.length - 1];
    if (!current || current.supplier !== item.supplier_name) {
      current = {
        supplier: item.supplier_name,
        brand: [],
        products: [],
      };
      groups.push(current);
    }
    const subject = item.subject;
    if (subject.kind === 'brand') {
      current.brand.push(item);
    } else {
      let productGroup = current.products.find(p => p.productId === subject.product_id);
      if (!productGroup) {
        productGroup = {
          productId: subject.product_id,
          title: subject.title,
          items: [],
        };
        current.products.push(productGroup);
      }
      productGroup.items.push(item);
    }
  }
  return groups;
}

export function materialKindLabel(kind: 'image' | 'video' | 'copy'): string {
  switch (kind) {
    case 'image':
      return '圖片';
    case 'video':
      return '影片';
    case 'copy':
      return '文案';
  }
}

export function materialAccessText(access: 'public_use' | 'partners'): string {
  return access === 'public_use'
    ? '供應商同意你把這個素材用在自己的公開店面。'
    : '僅供合作參考，供應商未同意放上公開店面。';
}

export function materialAppliesText(item: PartnerMaterial): string {
  const subject = item.subject;
  if (subject.kind === 'brand') {
    return `品牌素材・適用你目前與這個供應商合作的 ${item.applies_to.length} 項商品`;
  }
  return `商品素材・${subject.title}`;
}

const taipeiDateParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTaipei(iso: string): string {
  const parts = taipeiDateParts.formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

const taipeiTimeParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatTaipeiTime(iso: string): string {
  const parts = taipeiTimeParts.formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

export function materialVersionText(item: PartnerMaterial): string {
  return `第 ${item.current.version_no} 版・更新於 ${formatTaipei(item.current.created_at)}`;
}

function formatMb(byteSize: number): string {
  const mb = Math.max(0.1, byteSize / 1048576);
  return mb.toFixed(1);
}

export function materialContentSummary(content: SupplyMaterialContent): string {
  if (content.kind === 'image') {
    return `${content.width} × ${content.height}・${formatMb(content.byte_size)} MB`;
  }
  if (content.kind === 'video') {
    const typeLabel = content.content_type === 'video/mp4' ? 'MP4' : 'WebM';
    return `${typeLabel}・${formatMb(content.byte_size)} MB`;
  }
  const chars = Array.from(content.body);
  if (chars.length <= 60) {
    return content.body;
  }
  return chars.slice(0, 60).join('') + '…';
}

/**
 * Returns trimmed detail or message for ApiError, or empty string for other errors.
 */
export function partnerMaterialsErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const raw = error.detail ?? error.message;
    return typeof raw === 'string' ? raw.trim() : '';
  }
  return '';
}

/**
 * A known refusal drops this read's private projection. Network loss, timeouts
 * and 5xx keep the previous read visibly stale. GET 5xx sets network to false,
 * so the HTTP status is what separates those from 403 and 404.
 */
export function partnerMaterialsFailureKeepsStale(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.accessExpired) return false;
  if (error.status === 401 || error.status === 403 || error.status === 404) return false;
  if (error.status === 408 || error.status === 429) return true;
  if (error.status >= 500 || error.network || error.timedOut || error.status === 0) return true;
  if (error.status >= 400 && error.status < 500) return false;
  return true;
}

export function partnerMaterialsFailureState(data: PartnerMaterials | null, error: unknown): {
  data: PartnerMaterials | null;
  state: { kind: 'failed'; error?: string; staleData?: PartnerMaterials };
} {
  const message = partnerMaterialsErrorText(error);
  const text = message ? { error: message } : {};
  if (!partnerMaterialsFailureKeepsStale(error)) return { data: null, state: { kind: 'failed', ...text } };
  return { data, state: { kind: 'failed', ...text, ...(data ? { staleData: data } : {}) } };
}
