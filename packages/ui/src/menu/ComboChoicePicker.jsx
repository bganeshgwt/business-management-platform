import { moneyExact } from '@bmp/shared/format';
export default function ComboChoicePicker({groups=[],value=[],onChange,currency}) {
  if (!groups.length) return null;
  return <div className="stack field-wide">{groups.map(group=><fieldset key={group.id} className="service-option-card stack">
    <legend>{group.name} · choose {group.choose}</legend>
    {group.options.map(option=>{
      const same=s=>s.groupId===group.id&&Number(s.productId)===Number(option.productId)&&Number(s.productVariantId||0)===Number(option.productVariantId||0);
      const selected=value.some(same),count=value.filter(s=>s.groupId===group.id).length;
      return <label key={`${option.productId}:${option.productVariantId||''}`} className="service-choice">
        <input type={Number(group.choose)===1?'radio':'checkbox'} name={`combo-${group.id}`} checked={selected}
          disabled={option.isAvailable===false||(!selected&&count>=Number(group.choose)&&Number(group.choose)>1)}
          onChange={()=>onChange(selected?value.filter(s=>!same(s)):[...(Number(group.choose)===1?value.filter(s=>s.groupId!==group.id):value),{groupId:group.id,productId:option.productId,productVariantId:option.productVariantId}])}/>
        <span>{option.name}{option.variantName?` (${option.variantName})`:''}{Number(option.quantity)!==1?` × ${option.quantity}`:''}{option.isAvailable===false?' · Unavailable':''}</span>
        <span className="muted">{Number(option.extraPrice)>0?`+ ${moneyExact(option.extraPrice,currency)}`:'Included'}</span>
      </label>;
    })}
  </fieldset>)}</div>;
}
