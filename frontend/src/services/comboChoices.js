export const comboKey = selections => (selections||[]).map(s=>`${s.groupId}:${s.productId}:${s.productVariantId||''}`).sort().join('|');
export const comboError = (groups=[],selections=[]) => groups.find(group=>selections.filter(s=>s.groupId===group.id).length!==Number(group.choose))
  ? 'Complete the required combo choices' : null;
export const comboParts = (groups=[],selections=[]) => selections.flatMap(s=>{
  const group=groups.find(g=>g.id===s.groupId);
  const option=group?.options.find(o=>Number(o.productId)===Number(s.productId)&&Number(o.productVariantId||0)===Number(s.productVariantId||0));
  return option?[{...option,groupId:group.id,groupName:group.name}]:[];
});
export const comboExtra = (groups,selections) => comboParts(groups,selections).reduce((sum,part)=>sum+Number(part.extraPrice||0),0);
