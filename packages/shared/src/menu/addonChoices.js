export function choiceError(groups=[],selectedIds=[]) {
  const selected=new Set(selectedIds.map(Number));
  const group=groups.find(g=>{const n=g.modifierIds.filter(id=>selected.has(Number(id))).length;return n<g.min||n>g.max;});
  return group?`Choose ${group.min===group.max?group.min:`${group.min}–${group.max}`} from ${group.name}`:null;
}
