import type {
  PartnerMaterial,
  SupplyMaterialContent,
} from '../../../../../contracts/guild-launchpad/v1/supplier-console';

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
