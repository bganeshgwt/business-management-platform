export default function AddonChoiceRules({groups=[],selectedIds=[],modifiers=[]}) {
  const selected=new Set(selectedIds.map(Number));
  return groups.length>0&&<div className="stack">{groups.map(group=>{
    const count=group.modifierIds.filter(id=>selected.has(Number(id))).length;
    return <p key={group.name}><strong>{group.name}</strong>: choose {group.min===group.max?group.min:`${group.min}–${group.max}`} · {count} selected<br/><span className="muted small">{group.modifierIds.map(id=>modifiers.find(m=>Number(m.id)===Number(id))?.name||"Unavailable choice").join(", ")}</span></p>;
  })}</div>;
}
