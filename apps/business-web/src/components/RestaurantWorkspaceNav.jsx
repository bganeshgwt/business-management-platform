import WorkspaceTabs from './WorkspaceTabs';
import { restaurantRelated } from '../services/restaurantWorkspace';

export default function RestaurantWorkspaceNav({sections,pathname}) {
  const related=restaurantRelated(sections,pathname);
  // Tasks pages carry their own tabs (TasksNav).
  if(related.length<2||['/pos','/kitchen','/collection','/my-work'].includes(pathname)||pathname==='/tasks'||pathname.startsWith('/tasks/'))return null;
  const current=related.filter(link=>pathname===link.to||pathname.startsWith(`${link.to}/`)).sort((a,b)=>b.to.length-a.to.length)[0];
  return <WorkspaceTabs items={related} activeTo={current?.to}/>;
}
