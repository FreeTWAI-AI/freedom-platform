// Authoring source for the implemented INTERNAL PREVIEW protocol only.
// Full production planning contracts remain in docs/platform-plan/contracts.
const str=(max=2000,min=1)=>({type:'string',minLength:min,maxLength:max});
const uuid={type:'string',format:'uuid'};
const integer=(min=0,max=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum:min,maximum:max});
const nullable=s=>({anyOf:[s,{type:'null'}]});
const array=(items,max)=>({type:'array',items,...(max===undefined?{}:{maxItems:max})});
const object=(properties,required=Object.keys(properties),extra=false)=>({type:'object',properties,required,additionalProperties:extra});
const ref=name=>({$ref:`#/components/schemas/${name}`});
const version=integer(1),money=integer(1,100000000000),moneyOut={anyOf:[money,{type:'string',pattern:'^[1-9][0-9]*$'}]};
const currency={enum:['TWD','USD']};
const supply={net_price_minor:money,currency,availability:{enum:['finite','manual_confirmation']},stock:nullable(integer(0,100000000)),shipping_terms:str(1500),return_terms:str(1500)};
const product={title:str(120),photo_url:nullable(str(2000)),specifications:str(2000),...supply};
const campaign={title:str(120),audience:str(1000),goal:str(1000),draft_text:str(6000)};
const textArray=max=>array(str(100),max);
export const schemas={
 Protocol:object({protocol:{const:'freedom.preview/v1'},revision:str(30),protocol_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},operations:array(str(100)),authentication:{const:'member_session_csrf'},external_job_execution:{const:false},public_checkout:{const:false}},undefined,true),
 Empty:object({}),
 Problem:object({type:str(),title:str(),status:integer(400,599),code:str(100),detail:str(20000,0)},undefined,true),
 Health:object({status:{const:'ok'},mode:{enum:['local','staging','public']},version:str(100),money_movement_enabled:{const:false},official:{const:false}},undefined,true),
 Login:object({email:str(200),password:str(200)}),
 Session:object({user:object({user_id:uuid,email:str(200),display_name:str(200)},undefined,true),csrf_token:str(200)},undefined,true),
 LoggedOut:object({logged_out:{const:true}}),
 SavePositioning:object({real_world_occupations:textArray(8),background:str(1200,0),strengths:textArray(12),goals:str(1000),weekly_minutes:integer(0,10080),desired_roles:array({enum:['supplier','seller','creator','promoter','helper']},5),selected_tracks:textArray(3),confirmed:{const:true}}),
 Profile:object({profile_id:uuid,user_id:uuid,aggregate_version:version,source:{const:'self_declared'},goals:str(1000)},undefined,true),
 Positioning:object({profile:nullable(ref('Profile')),tracks:array({type:'object'}),recommendations:array({type:'object'})}),
 Guild:object({guild_key:str(100),name:str(200),membership:nullable({type:'object'})},undefined,true),
 Membership:object({membership_id:uuid,state:{enum:['active','left']},rank:{const:'runner'},aggregate_version:version},undefined,true),
 ProductInput:object(product,Object.keys(product).filter(k=>k!=='photo_url')),
 OfferInput:object(supply),
 Offer:object({offer_version_id:uuid,net_price_minor:moneyOut,currency,revision:version,snapshot_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},undefined,true),
 Product:object({product_id:uuid,title:str(120),supplier_ref:uuid,current_offer:ref('Offer'),aggregate_version:version,checkout_enabled:{const:false}},undefined,true),
 StoreInput:object({name:str(120),description:str(1500),support_contact:str(250)}),
 Store:object({store_id:uuid,name:str(120),seller_ref:uuid,checkout_enabled:{const:false}},undefined,true),
 ListingInput:object({store_id:uuid,offer_version_id:uuid,retail_price_minor:money,sale_terms:str(1500)}),
 Listing:object({listing_id:uuid,store_id:uuid,snapshot_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},snapshot:{type:'object'},aggregate_version:version,state:{enum:['draft','requested','accepted','declined']}},undefined,true),
 SnapshotInput:object({snapshot_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}),
 DecisionInput:object({snapshot_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},decision:{enum:['accepted','declined']},note:str(1000),acknowledge_internal_preview:{const:true}}),
 Acceptance:object({acceptance_id:uuid,state:{enum:['requested','accepted','declined']},aggregate_version:version,snapshot_sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},undefined,true),
 ProjectInput:object({repository_url:str(300),title:str(120),description:str(2000),use_notes:str(3000),demo_url:nullable(str(2000)),relationship:{enum:['author','maintainer','contributor','curator']},consent_to_share:{const:true}},['repository_url','title','description','use_notes','relationship','consent_to_share']),
 ProjectMetadata:object({title:str(120),description:str(2000),use_notes:str(3000),demo_url:nullable(str(2000))},['title','description','use_notes']),
 Project:object({project_id:uuid,repository_id:str(30),repository_full_name:str(200),owner_ref:uuid,title:str(120),aggregate_version:version,current_version:object({commit_sha:{type:'string',pattern:'^[a-f0-9]{40}$'},license_spdx:str(100)},undefined,true)},undefined,true),
 CampaignInput:object({...campaign,source_project_id:nullable(uuid),source_supplier_product_id:nullable(uuid),source_brief:str(3000,0)},Object.keys(campaign)),
 CampaignMetadata:object(campaign),
 Campaign:object({campaign_id:uuid,title:str(120),aggregate_version:version,source_snapshot:{type:'object'},draft_text:str(6000)},undefined,true),
 ShareInput:object({channel:str(80),share_url:str(2000),note:str(1000,0)},['channel','share_url']),
 Share:object({share_id:uuid,verification_status:{const:'self_reported'}},undefined,true),
 Work:object({work_item_id:uuid,title:str(200),aggregate_version:version},undefined,true),
 Dashboard:{type:'object'},
};
const items=name=>object({items:array(ref(name))});
for(const name of ['Guild','Product','Store','Listing','Acceptance','Project','Campaign','Work'])schemas[name+'List']=items(name);
schemas.TrackList=object({items:array({type:'object'})});
// Params are always identifiers, never arbitrary paths or full URLs.
export const operations={};
function op(id,method,path,response,body=null,concurrency='none',status=200,auth=true){
 operations[id]={method,path,response,body,concurrency,status,auth,idempotent:method==='POST'&&!['login','logout'].includes(id)};
}
op('getProtocol','GET','/protocol','Protocol',null,'none',200,false);
op('getHealth','GET','/health','Health',null,'none',200,false);
op('login','POST','/auth/login','Session','Login','none',200,false);op('logout','POST','/auth/logout','LoggedOut','Empty');
op('getSession','GET','/session','Session');
op('getPositioning','GET','/me/positioning','Positioning');op('savePositioning','POST','/me/positioning','Profile','SavePositioning','optional',201);
op('listCareerTracks','GET','/career-tracks','TrackList');op('listGuilds','GET','/guilds','GuildList');
op('joinGuild','POST','/guilds/{key}/join','Membership','Empty','optional');op('leaveGuild','POST','/guilds/{key}/leave','Membership','Empty','required');
op('listSupplierProducts','GET','/supplier/products','ProductList');op('createSupplierProduct','POST','/supplier/products','Product','ProductInput','none',201);
op('createSupplierOffer','POST','/supplier/products/{id}/offer-versions','Product','OfferInput','required',201);
op('listCatalog','GET','/retail/catalog','ProductList');op('listStores','GET','/retail/stores','StoreList');op('createStore','POST','/retail/stores','Store','StoreInput','none',201);
op('listListings','GET','/retail/listings','ListingList');op('createListing','POST','/retail/listings','Listing','ListingInput','none',201);
op('requestSupply','POST','/retail/listings/{id}:request-supply','Listing','SnapshotInput','required');
op('listSupplyRequests','GET','/supplier/requests','AcceptanceList');op('decideSupplyRequest','POST','/supplier/requests/{id}:decide','Acceptance','DecisionInput','required');
op('listProjects','GET','/opensource/projects','ProjectList');op('importProject','POST','/opensource/projects','Project','ProjectInput','none',201);
op('refreshProject','POST','/opensource/projects/{id}:refresh','Project','Empty','required');op('reviseProject','POST','/opensource/projects/{id}:revise','Project','ProjectMetadata','required');
op('listCampaigns','GET','/marketing/campaigns','CampaignList');op('createCampaign','POST','/marketing/campaigns','Campaign','CampaignInput','none',201);
op('reviseCampaign','POST','/marketing/campaigns/{id}:revise','Campaign','CampaignMetadata','required');op('recordShare','POST','/marketing/campaigns/{id}/shares','Campaign','ShareInput','required',201);
op('listWorks','GET','/work-items','WorkList');op('getDashboard','GET','/dashboard','Dashboard');
export const protocol={version:'freedom.preview/v1',revision:'0.3.0',api_prefix:'/api/v1',operations,schemas,auth:'member_session_csrf',external_job_execution:false,public_checkout:false};
