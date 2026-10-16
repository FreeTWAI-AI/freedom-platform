import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkoutHarness,ok,ports} from './hosted-checkout-harness.js';
import {publicPurchaseState,quotePublicCart,type HostedCheckoutOptions} from '../../modules/agent-commerce/checkout/public-commands.js';

test('store pages offer a cart only where the cart quote answers, and a product page sees one-unit availability',async()=>{
  const x=await checkoutHarness('fp_purchase_state');
  try{
    await x.reset();
    const s=await x.store(1),empty=await x.store(0);
    const open:HostedCheckoutOptions={origin:x.h.origin,settings:{checkoutEnabled:true,consoleEnabled:true,quarantine:false,providerProfiles:[]},...ports};
    const state=(slug:string,options:HostedCheckoutOptions=open,sku?:string)=>publicPurchaseState(x.runtime,slug,options,sku);
    const quote=(options:HostedCheckoutOptions)=>quotePublicCart(x.runtime,s.slug,{publication_revision:'1',lines:[{sku:s.product.sku,quantity:1}]},{network:'192.0.2.10'},options);
    const writes=async()=>(await x.h.pool.query(`SELECT (SELECT count(*) FROM auth_rate_limits)::int AS budgets,(SELECT count(*) FROM commerce_checkouts)::int AS checkouts,
      (SELECT count(*) FROM commerce_inventory_reservations)::int AS holds`)).rows[0];
    const before=await writes();
    assert.deepEqual(await state(s.slug),{open:true});
    assert.deepEqual(await state(s.slug.toUpperCase()),{open:true});
    assert.deepEqual(await state(s.slug,open,s.product.sku),{open:true,product:'available'});
    assert.deepEqual(await state(empty.slug,open,empty.product.sku),{open:true,product:'sold_out'});
    assert.deepEqual(await state(s.slug,open,'P9999'),{open:true,product:'sold_out'});
    const closed:[HostedCheckoutOptions,string][]=[
      [{...open,settings:undefined},'checkout_not_enabled'],[{...open,settings:{checkoutEnabled:false,quarantine:false,providerProfiles:[]}},'checkout_not_enabled'],
      [{...open,settings:{checkoutEnabled:true,consoleEnabled:true,quarantine:true,providerProfiles:[]}},'commerce_quarantined'],[{...open,admission:{allowed:()=>false}},'checkout_not_enabled'],
      [{origin:x.h.origin,settings:open.settings,shipping:ports.shipping},'checkout_not_enabled'],
    ];
    for(const [options] of closed)assert.deepEqual(await state(s.slug,options,s.product.sku),{open:false});
    assert.deepEqual(await state('missing-store'),{open:false});
    assert.deepEqual(await writes(),before,'page reads take no budget and write nothing');
    // The same gates decide the quote, so a page never offers a cart the quote refuses.
    assert.equal((await quote(open)).lines[0].state,'ok');
    for(const [options,code] of closed)await assert.rejects(quote(options),(e:{code?:string})=>e.code===code);
    await x.place(s,await x.frozen(s,1));
    assert.deepEqual(await state(s.slug,open,s.product.sku),{open:true,product:'sold_out'});
    assert.equal((await quote(open)).lines[0].state,'insufficient');
    const current=ok(await x.h.call('GET',s.root,s.owner,undefined,{},x.app));
    ok(await x.send(s,'/unpublish',{},current.version));
    assert.deepEqual(await state(s.slug),{open:false});
  } finally {await x.stop();}
});
