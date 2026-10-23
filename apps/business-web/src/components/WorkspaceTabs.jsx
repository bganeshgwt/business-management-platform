import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ActionMenu from './ActionMenu';
import Icon from '@bmp/ui/Icon';
import NavIcon from './NavIcon';
import '../modules/business/core/styles/workspace.css';

// These tabs navigate to pages: keep native links and aria-current so opening
// another tab, browser history and screen-reader navigation all keep working.
export default function WorkspaceTabs({items,activeTo,label='Related pages'}) {
  const navigate=useNavigate();
  const scrollRef=useRef(null);
  const [edges,setEdges]=useState({left:false,right:false});
  const visible=items.filter((item,index)=>index<4||item.to===activeTo);
  const more=items.filter(item=>!visible.includes(item));
  const visibleKey=visible.map(item=>item.to).join('|');
  const updateEdges=useCallback(()=>{
    const node=scrollRef.current;
    if(!node)return;
    const next={left:node.scrollLeft>2,right:node.scrollLeft+node.clientWidth<node.scrollWidth-2};
    setEdges(old=>old.left===next.left&&old.right===next.right?old:next);
  },[]);
  const showLink=useCallback(link=>{
    const node=scrollRef.current;
    if(!node||!link)return;
    const left=link.offsetLeft;
    const right=left+link.offsetWidth;
    if(left<node.scrollLeft)node.scrollLeft=left;
    else if(right>node.scrollLeft+node.clientWidth)node.scrollLeft=right-node.clientWidth;
    updateEdges();
  },[updateEdges]);
  useLayoutEffect(()=>{
    const node=scrollRef.current;
    if(!node)return;
    const fit=()=>{
      showLink(node.querySelector('[aria-current="page"]'));
      updateEdges();
    };
    fit();
    const observer=new ResizeObserver(fit);
    observer.observe(node);
    return()=>observer.disconnect();
  },[activeTo,visibleKey,showLink,updateEdges]);
  function onKeyDown(event) {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const links=[...scrollRef.current.querySelectorAll('a')];
    const index=links.indexOf(event.target.closest('a'));
    if(index<0)return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?links.length-1:(index+(event.key==='ArrowRight'?1:-1)+links.length)%links.length;
    links[next].focus({preventScroll:true});
    showLink(links[next]);
  }
  function scroll(direction) {
    const node=scrollRef.current;
    node.scrollBy({left:direction*Math.max(160,node.clientWidth*0.7),behavior:'auto'});
  }
  if(items.length<2)return null;
  const overflow=edges.left||edges.right;
  return <nav className="bz-workspace-nav" aria-label={label}>
    <div className="bz-workspace-track">
      {overflow&&<button type="button" className="bz-workspace-scroll" aria-label="Scroll related pages left" disabled={!edges.left} onClick={()=>scroll(-1)}><Icon name="chevron-left" size={16}/></button>}
      <div className="bz-workspace-tabs" ref={scrollRef} onScroll={updateEdges} onKeyDown={onKeyDown}>
        {visible.map(item=><Link key={item.to} to={item.to} className={`bz-workspace-tab ${item.to===activeTo?'is-active':''}`}
          aria-current={item.to===activeTo?'page':undefined}>{item.icon&&<NavIcon name={item.icon}/>}<span>{item.label}</span></Link>)}
      </div>
      {overflow&&<button type="button" className="bz-workspace-scroll" aria-label="Scroll related pages right" disabled={!edges.right} onClick={()=>scroll(1)}><Icon name="chevron-right" size={16}/></button>}
    </div>
    {more.length>0&&<div className="bz-workspace-more"><ActionMenu text="More tools" label="More related tools" items={more.map(item=>({label:item.label,icon:item.icon,onClick:()=>navigate(item.to)}))}/></div>}
  </nav>;
}
