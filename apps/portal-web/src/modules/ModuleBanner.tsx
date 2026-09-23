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

/** A compact task header; the app shell already provides the page title and brand. */
export function ModuleBanner({ title, description, headingId, children }: ModuleBannerProps) {
  return <header className="section-heading expedition-banner">
    <div className="expedition-banner-copy">
      <h2 id={headingId}>{title}</h2>
      {description && <p className="expedition-banner-description">{description}</p>}
    </div>
    {children && <div className="expedition-banner-actions">{children}</div>}
  </header>;
}
