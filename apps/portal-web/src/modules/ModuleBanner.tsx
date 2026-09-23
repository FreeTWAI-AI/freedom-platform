import type { ReactNode } from 'react';
import './ExpeditionDesign.css';

type ModuleBannerProps = {
  eyebrow: string;
  title: string;
  description: ReactNode;
  art?: string;
  headingId?: string;
  children?: ReactNode;
};

/** A decorative workshop cover; module names and actions remain accessible HTML. */
export function ModuleBanner({ eyebrow, title, description, art, headingId, children }: ModuleBannerProps) {
  return <header className={`section-heading expedition-banner${art ? ' expedition-banner-illustrated' : ''}`}>
    <div className="expedition-banner-copy">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={headingId}>{title}</h2>
      <p className="expedition-banner-description">{description}</p>
      {children}
    </div>
    {art && <div className="expedition-banner-art" aria-hidden="true"><img src={art} alt="" decoding="async"/></div>}
  </header>;
}
