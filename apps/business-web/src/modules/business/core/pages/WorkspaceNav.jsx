import { useLocation } from 'react-router-dom';
import useBusiness from '../../../../hooks/useBusiness';
import WorkspaceTabs from '../../../../components/WorkspaceTabs';
import { businessPath, businessSections, typeAllows } from '../../../../services/businessNav';
import { workspaceFor, workspaceLabel, workspaceSections } from '../../../../services/businessWorkspace';

export default function WorkspaceNav({ section }) {
  const { context, can, has } = useBusiness();
  const { pathname } = useLocation();
  const type = context.business.business_type;
  const key = workspaceFor(section, type);
  // Billing screens stay uncluttered; Tasks draws its own tabs (TasksNav).
  if (['counter','rx-sale','salon-bill','jewellery-bill','tasks'].includes(section)) return null;
  if (!key || section === 'patients' && pathname.endsWith('/patients') === false) return null;
  const wanted = workspaceSections(key, type);
  const rules = businessSections(type).flatMap((group) => group.links);
  const links = wanted.map((name) => rules.find((rule) => rule.section === name && typeAllows(rule, type)))
    .filter((rule) => rule && (!rule.need || can(rule.need)) && (!rule.module || has(rule.module)))
    .map((rule) => ({ ...rule, label: workspaceLabel(rule.section, type, rule.label) }));
  if (links.length < 2) return null;
  return <WorkspaceTabs items={links.map(link=>({...link,to:businessPath(context.business.id,link.section)}))}
    activeTo={businessPath(context.business.id,section)}/>;
}
