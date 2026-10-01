const platforms=['facebook','instagram','line','linkedin','youtube','threads','tiktok','x','github','discord','email','website','other'] as const;
export type BrandPlatform=(typeof platforms)[number];
const known=new Set<string>(platforms);
const accent=new Set<BrandPlatform>(['email','website','other']);
const domains:[BrandPlatform,string[]][]=[
  ['facebook',['facebook.com','fb.com']],['instagram',['instagram.com']],['line',['line.me','lin.ee']],
  ['linkedin',['linkedin.com']],['youtube',['youtube.com','youtu.be']],['threads',['threads.net','threads.com']],
  ['tiktok',['tiktok.com']],['x',['x.com','twitter.com']],['github',['github.com']],['discord',['discord.gg','discord.com']],
];

export function brandPlatform(value:string):BrandPlatform{return known.has(value)?value as BrandPlatform:'other';}
export function brandForUrl(url:string):BrandPlatform{
  if(url.toLowerCase().startsWith('mailto:'))return 'email';
  try{
    const host=new URL(url).hostname.toLowerCase().replace(/\.$/,'').replace(/^www\./,'');
    for(const [platform,names] of domains)if(names.some(domain=>host===domain||host.endsWith('.'+domain)))return platform;
  }catch{/* not a url */}
  return 'website';
}

/** Official Simple Icons paths (CC0): facebook, github, youtube, linkedin, discord, x. The rest are simplified marks. */
const official:Partial<Record<BrandPlatform,string>>={
  facebook:'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  github:'M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z',
  youtube:'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  linkedin:'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  discord:'M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 0-1.872-.892.077.077 0 0 0-.08.014c-.396.298-.84.544-1.278.758a.075.075 0 0 0-.035.1c.096.17.197.337.302.496a.07.07 0 0 0 .062.031 16.66 16.66 0 0 0 7.088 1.556c2.54 0 5.04-.52 7.088-1.556a.07.07 0 0 0 .062-.03c.105-.16.206-.327.302-.497a.077.077 0 0 0-.035-.1 12.3 12.3 0 0 0-1.279-.758.075.075 0 0 0-.079-.014c-.58.348-1.202.64-1.872.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z',
  x:'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
};

function Mark({platform}:{platform:BrandPlatform}){
  if(platform==='instagram')return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
    <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8"/>
    <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8"/>
    <circle cx="17.15" cy="6.85" r="1.15" fill="currentColor"/>
  </svg>;
  if(official[platform])return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="currentColor" d={official[platform]}/></svg>;
  if(platform==='line')return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="currentColor" d="M12 3.2C6.9 3.2 2.8 6.6 2.8 10.8c0 3.8 3.4 7 7.9 7.6.4.1.9.3 1 .7.1.4 0 1-.1 1.4 0 .2.2.3.4.1 1-.5 3.8-2.3 5.2-3.8 1.5-1.5 2.2-3.2 2.2-5.9 0-4.2-4.1-7.7-7.4-7.7z"/></svg>;
  if(platform==='threads')return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8"/><circle cx="12" cy="12.2" r="3" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M15 12.2v1.7a2.2 2.2 0 0 0 2.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>;
  if(platform==='tiktok')return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="currentColor" d="M14.2 3.2c.3 2.3 1.8 4 4.1 4.4v2.5a6.4 6.4 0 0 1-3.7-1.2v6.2a5 5 0 1 1-5-5c.3 0 .6 0 .9.1v2.6a2.5 2.5 0 1 0 1.7 2.4V3.2h2z"/></svg>;
  if(platform==='email')return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="currentColor" fillRule="evenodd" d="M4 6.2h16c.7 0 1.3.6 1.3 1.3v9.4c0 .7-.6 1.3-1.3 1.3H4c-.7 0-1.3-.6-1.3-1.3V7.5c0-.7.6-1.3 1.3-1.3zm.6 1.7 7.4 5 7.4-5v1.3L12 14.2 4.6 9.2V7.9z"/></svg>;
  if(platform==='website')return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7"/><ellipse cx="12" cy="12" rx="3.3" ry="8" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M4 12h16M5.3 8.7h13.4M5.3 15.3h13.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
  return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M9.2 13.6 8 14.8a3 3 0 0 1-4.2-4.2l2.4-2.4a3 3 0 0 1 4.2 0"/><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M14.8 10.4 16 9.2a3 3 0 0 1 4.2 4.2l-2.4 2.4a3 3 0 0 1-4.2 0"/></svg>;
}

export function BrandIcon({platform}:{platform:string}){
  const name=brandPlatform(platform);
  return <div className="brand-badge" data-platform={name} data-tone={accent.has(name)?'accent':'brand'} aria-hidden="true"><Mark platform={name}/></div>;
}
