import type {z} from 'zod';
import type {ReservationSettingSchema} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order';

/** Render only after the owner-authorized setting read. Capabilities are not ownership. */
export function HostedReservationSetting({setting, writable, locked, supplierOnly = false, onToggle}: {
  setting: z.infer<typeof ReservationSettingSchema>; writable: boolean; locked: boolean;
  supplierOnly?: boolean; onToggle: () => void;
}) {
  return <section className="stack" aria-label="預留設定"><h3>{supplierOnly ? '供貨庫存預留' : '庫存預留'}</h3>
    {supplierOnly && <p>{!setting.admission_enabled ? '平台目前暫停接受新預留。' : setting.reservation_enabled ? '已開放 30 分鐘供貨預留。' : '尚未開放供貨預留。'}付款與出貨尚未啟用。</p>}
    <p>{setting.admission_enabled
      ? supplierOnly ? '開放後，經你同意的店主仍需發布選品並開放預留，買家才能預留這筆共用庫存。停止只影響新預留；既有預留仍可查看，由買家或店主取消，或到期後釋放庫存。'
        : '開放後，買家可預留你店裡的商品；其他店主經你同意的選品也會使用同一筆庫存。取消或到期會釋放庫存。'
      : supplierOnly ? '平台目前未開放新預留；仍可查看既有供貨預留。' : '平台目前未開放新預留；仍可查看與取消既有預留。'}</p>
    <div className="actions"><button type="button" className="btn btn-ghost"
      disabled={locked || !setting.reservation_enabled && (!writable || !setting.admission_enabled)} onClick={onToggle}>
      {setting.reservation_enabled ? '停止接受新預留' : '開放 30 分鐘預留'}</button></div>
  </section>;
}
