import {createRoot} from 'react-dom/client';
import {ApiError,PortalClient} from './api';
import {GitHubBookSocial,GitHubSocialProvider} from './modules/GitHubSocial';
import {skillBookStarUrl} from './modules/SkillBookCover';

// Public HTML stays readable and actionable without JavaScript. Private Star
// state is loaded only in this visitor's browser and never enters cached HTML.
async function enhance(node:HTMLElement){
  const bookId=node.dataset.skillSocial,repositoryUrl=skillBookStarUrl({repository_url:node.dataset.repository??''});
  if(!bookId||!/^[a-z0-9-]+$/.test(bookId)||!repositoryUrl)return;
  const client=new PortalClient();
  const widget=<GitHubBookSocial bookId={bookId} repositoryUrl={repositoryUrl} returnTo={'/development/skills/'+bookId}/>;
  try{
    const session=await client.getSession();client.csrfToken=session.csrf_token;
    createRoot(node).render(<GitHubSocialProvider client={client} session={session}>{widget}</GitHubSocialProvider>);
  }catch(error){
    if(error instanceof ApiError&&error.status===401)createRoot(node).render(widget);
    // Preserve the working GitHub links if session discovery is unavailable.
  }
}
for(const node of document.querySelectorAll<HTMLElement>('[data-skill-social]'))void enhance(node);
