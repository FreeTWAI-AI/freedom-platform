import {useId} from 'react';
import {formatMinor,parseMajorToMinor} from '../../../apps/portal-web/src/format';

export function productMatches(product:{title:string;sku:string;description:string},query:string){
  const words=query.trim().normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack=[product.title,product.sku,product.description].join(' ').normalize('NFKC').toLocaleLowerCase();
  return words.every(word=>haystack.includes(word));
}
export function ProductSearch({value,onChange,count,total,disabled}:{value:string;onChange:(query:string)=>void;count:number;total:number;disabled:boolean}){
  const id=useId();
  return <div className="hosted-product-search"><label className="field" htmlFor={id}>搜尋商品<input id={id} type="search" value={value} disabled={disabled} placeholder="商品名稱、SKU 或介紹" onChange={event=>onChange(event.target.value)}/></label>
    <p className="field-hint" aria-live="polite">{value.trim()?`找到 ${count}／${total} 件已載入的商品`:`已載入 ${total} 件商品`}</p>
    {value&&<button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>onChange('')}>清除搜尋</button>}
    {disabled&&value&&<p className="field-hint">先儲存或取消編輯，再變更搜尋。</p>}
  </div>;
}
function amount(text:string){try{return /^0+(?:\.0{1,2})?$/.test(text.trim())?0:parseMajorToMinor(text);}catch{return null;}}
export function PriceDifference({retail,cost,shipping,currency}:{retail:string;cost:number;shipping:number;currency:string}){
  const price=amount(retail);if(price===null||price<1||price>100000000)return null;
  const difference=price-cost-shipping;
  return <div className="hosted-price-summary" aria-live="polite"><dl><div><dt>我的售價</dt><dd>{formatMinor(price,currency)}</dd></div><div><dt>供貨價＋每件運費</dt><dd>{formatMinor(cost+shipping,currency)}</dd></div><div><dt>每件價格差</dt><dd>{formatMinor(difference,currency)}</dd></div></dl>
    <p className="field-hint">價格差還沒扣稅、金流、行銷、退貨及其他成本，並非實際利潤。</p>{difference<0&&<p className="field-hint">目前售價低於供貨價加運費，送出前請確認。</p>}
  </div>;
}
