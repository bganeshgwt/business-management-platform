import {useEffect,useState} from 'react';
import api,{getErrorMessage} from '../../../../services/api';
import {ErrorMessage} from '../../../../components/Feedback';

export default function AddonGroupsEditor({productId,modifiers,canManage}) {
  const [groups,setGroups]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[saved,setSaved]=useState(false);
  useEffect(()=>{
    let active=true;
    api.get(`/menu/products/${productId}/addon-groups`).then(r=>{if(active){setGroups(r.data.data);setLoaded(true);}}).catch(e=>{if(active)setError(getErrorMessage(e));});
    return ()=>{active=false;};
  },[productId]);
  const change=(index,patch)=>{setSaved(false);setGroups(rows=>rows.map((row,i)=>i===index?{...row,...patch}:row));};
  const save=async()=>{
    setBusy(true);setError('');setSaved(false);
    try{await api.put(`/menu/products/${productId}/addon-groups`,{groups});setSaved(true);}
    catch(e){setError(getErrorMessage(e));}finally{setBusy(false);}
  };
  return <section className="stack">
    <h3>Add-on choice groups</h3>
    <p>Save the dish’s offered add-ons above first. Set minimum 1 for a required choice, or 0 for optional choices. Each add-on belongs to at most one group.</p>
    <ErrorMessage message={error}/>
    {groups.map((group,index)=><fieldset className="stack" key={index} disabled={!canManage||busy}>
      <legend>Group {index+1}</legend>
      <label className="field">Name<input maxLength={80} value={group.name} onChange={e=>change(index,{name:e.target.value})}/></label>
      <label className="field">Minimum choices<input type="number" min="0" max="100" value={group.min} onChange={e=>change(index,{min:Number(e.target.value)})}/></label>
      <label className="field">Maximum choices<input type="number" min="1" max="100" value={group.max} onChange={e=>change(index,{max:Number(e.target.value)})}/></label>
      {modifiers.filter(m=>m.status==='active'||group.modifierIds.includes(Number(m.id))).map(m=><label className="checkbox" key={m.id}>
        <input type="checkbox" checked={group.modifierIds.includes(Number(m.id))} onChange={e=>change(index,{modifierIds:e.target.checked?[...group.modifierIds,Number(m.id)]:group.modifierIds.filter(id=>id!==Number(m.id))})}/>{m.name}
      </label>)}
      <button type="button" className="button button-secondary" onClick={()=>{setSaved(false);setGroups(groups.filter((_,i)=>i!==index));}}>Remove group</button>
    </fieldset>)}
    {canManage&&<div className="form-actions">
      <button type="button" className="button button-secondary" disabled={!loaded||busy||groups.length>=20} onClick={()=>{setSaved(false);setGroups([...groups,{name:'',min:0,max:1,modifierIds:[]}]);}}>Add choice group</button>
      <button type="button" className="button" disabled={!loaded||busy} onClick={save}>{busy?'Saving…':'Save choice groups'}</button>
    </div>}
    {saved&&<p role="status">Choice groups saved.</p>}
  </section>;
}
