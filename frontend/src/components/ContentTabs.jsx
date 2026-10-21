import { useId, useLayoutEffect, useRef } from 'react';
import '../modules/business/core/styles/workspace.css';

// Tabs that switch content within a page, with one keyboard stop and a named panel.
export default function ContentTabs({label,value,options,onChange,children}) {
  const id=useId();
  const ref=useRef(null);
  useLayoutEffect(()=>{
    const node=ref.current;
    const selected=node.querySelector('[aria-selected="true"]');
    if(!selected)return;
    if(selected.offsetLeft<node.scrollLeft)node.scrollLeft=selected.offsetLeft;
    else if(selected.offsetLeft+selected.offsetWidth>node.scrollLeft+node.clientWidth)node.scrollLeft=selected.offsetLeft+selected.offsetWidth-node.clientWidth;
  },[value]);
  function move(event) {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=[...ref.current.querySelectorAll('[role="tab"]:not(:disabled)')];
    const index=buttons.indexOf(event.target);
    if(index<0)return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    buttons[next].click();
    buttons[next].focus({preventScroll:true});
    const node=ref.current;
    const target=buttons[next];
    if(target.offsetLeft<node.scrollLeft)node.scrollLeft=target.offsetLeft;
    else if(target.offsetLeft+target.offsetWidth>node.scrollLeft+node.clientWidth)node.scrollLeft=target.offsetLeft+target.offsetWidth-node.clientWidth;
  }
  return <div className="content-tabs-area">
    <div className="content-tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={move}>
      {options.map(option=><button key={option.value} type="button" role="tab" id={`${id}-${option.value}`}
        aria-selected={value===option.value} aria-controls={`${id}-panel`} tabIndex={value===option.value?0:-1}
        className={`content-tab ${value===option.value?'is-active':''}`} onClick={()=>onChange(option.value)}>{option.label}</button>)}
    </div>
    <div className="content-tab-panel stack" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}`} tabIndex={0}>{children}</div>
  </div>;
}
