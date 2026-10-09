import { ProductMediaCommandSchema, type ProductMediaCommand } from '../../../../contracts/guild-launchpad/v1/hosted-store-media';
export interface PhotoAttempt {
  readonly tenantId:string;readonly instanceId:string;readonly productId:string;readonly expected:string;
  readonly key:string;readonly file:File|null;readonly action:'upload'|'remove';readonly hadUnknown:boolean;
}
/** Strict success may describe a newer current photo, but completion is this exact CAS. */
export function photoAcknowledgement(raw:unknown,attempt:PhotoAttempt):ProductMediaCommand|null {
  const parsed=ProductMediaCommandSchema.safeParse(raw);if(!parsed.success)return null;
  const value=parsed.data;
  const completed=String(BigInt(attempt.expected)+(value.changed?1n:0n));
  if(value.product_id!==attempt.productId||value.completed_version!==completed||(attempt.action==='upload'&&!value.changed))return null;
  const prefix=`/api/v1/tenants/${attempt.tenantId}/storefronts/${attempt.instanceId}/products/${attempt.productId}/photo/`;
  if(value.current.photo&&!value.current.photo.read_path.startsWith(prefix))return null;
  return value;
}
export function retainedPhotoFailure(attempt:PhotoAttempt,unknown:boolean){
  return Object.freeze({...attempt,hadUnknown:attempt.hadUnknown||unknown});
}
export function reviewPhotoAttempt(attempt:PhotoAttempt,version:string,key:string):PhotoAttempt {
  if(attempt.hadUnknown)throw new Error('photo_original_result_unknown');
  return Object.freeze({...attempt,expected:version,key,hadUnknown:false});
}
