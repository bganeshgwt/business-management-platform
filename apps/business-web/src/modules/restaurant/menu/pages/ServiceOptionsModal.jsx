import { useEffect, useState } from 'react';
import Modal from '../../../../components/Modal';
import { ErrorMessage, Loading, SuccessMessage } from '../../../../components/Feedback';
import api, {getErrorMessage} from '../../../../services/api';

const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export default function ServiceOptionsModal({product,onClose,onSaved,canManage}) {
  const [products,setProducts]=useState([]);
  const [schedule,setSchedule]=useState([]),[groups,setGroups]=useState([]),[variants,setVariants]=useState({});
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
  const url=`/menu/products/${product.id}/service-options`;
  useEffect(()=>{
    let active=true;
    Promise.all([api.get(url),api.get('/menu/products')]).then(([r,p])=>{if(active){setSchedule(r.data.data.schedule);setGroups(r.data.data.groups);setProducts(p.data.data);}})
      .catch(e=>{if(active)setError(getErrorMessage(e));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[url]);
  const choiceIds=JSON.stringify([...new Set(groups.flatMap(group=>group.options.map(option=>option.productId)).filter(Boolean))].sort());
  useEffect(()=>{
    const ids=JSON.parse(choiceIds);
    let active=true;
    Promise.all(ids.map(async id=>[id,(await api.get(`/menu/products/${id}/variants`)).data.data]))
      .then(rows=>{if(active)setVariants(Object.fromEntries(rows));}).catch(e=>{if(active)setError(getErrorMessage(e));});
    return()=>{active=false;};
  },[choiceIds]);
  const changeGroup=(index,patch)=>{setSuccess('');setGroups(rows=>rows.map((row,i)=>i===index?{...row,...patch}:row));};
  const changeOption=(index,at,patch)=>changeGroup(index,{options:groups[index].options.map((option,i)=>i===at?{...option,...patch}:option)});
  const save=async event=>{
    event.preventDefault();setBusy(true);setError('');setSuccess('');
    try {const r=await api.put(url,{schedule,groups});setSchedule(r.data.data.schedule);setGroups(r.data.data.groups);setSuccess('Serving times and combo choices saved');onSaved?.();}
    catch(e){setError(getErrorMessage(e));}finally{setBusy(false);}
  };
  const choices=products.filter(p=>String(p.id)!==String(product.id)&&!p.isCombo&&p.status==='active');
  return <Modal title={`Serving times & combo choices — ${product.name}`} onClose={onClose} width={880}>
    <ErrorMessage message={error}/><SuccessMessage message={success}/>
    {loading?<Loading/>:<form className="stack" onSubmit={save}>
      <fieldset disabled={!canManage||busy} className="stack service-options-fieldset">
        <legend>When this dish is served</legend>
        <p className="muted">No periods means available all day. Times use the restaurant timezone. A closing time before opening runs into the next morning.</p>
        {schedule.map((period,index)=><div className="service-option-card stack" key={index}>
          <div className="service-weekdays">{DAYS.map((day,i)=><label key={day}><input type="checkbox" checked={period.days.includes(i)} onChange={()=>setSchedule(rows=>rows.map((row,at)=>at===index?{...row,days:row.days.includes(i)?row.days.filter(d=>d!==i):[...row.days,i]}:row))}/>{day}</label>)}</div>
          <div className="form-grid"><label className="field">From<input type="time" required value={period.opensAt} onChange={e=>setSchedule(rows=>rows.map((row,i)=>i===index?{...row,opensAt:e.target.value}:row))}/></label>
            <label className="field">Until<input type="time" required value={period.closesAt} onChange={e=>setSchedule(rows=>rows.map((row,i)=>i===index?{...row,closesAt:e.target.value}:row))}/></label>
            <button type="button" className="button button-secondary" onClick={()=>setSchedule(rows=>rows.filter((_,i)=>i!==index))}>Remove period</button></div>
        </div>)}
        <button type="button" className="button button-secondary" disabled={schedule.length>=21} onClick={()=>setSchedule([...schedule,{days:[0,1,2,3,4,5,6],opensAt:'11:00',closesAt:'15:00'}])}>Add serving period</button>
      </fieldset>
      <fieldset disabled={!canManage||busy} className="stack service-options-fieldset">
        <legend>Customer choices in this combo</legend>
        <p className="muted">For example, choose one main and one drink. Fixed dishes from the Combo editor are included too. Each selected option consumes its dish recipe. Extra prices are added once per combo.</p>
        {groups.map((group,index)=><div className="service-option-card stack" key={index}>
          <div className="form-grid"><label className="field">Group name<input required maxLength={60} value={group.name} placeholder="Choose a drink" onChange={e=>changeGroup(index,{name:e.target.value})}/></label>
            <label className="field">Choose how many<input type="number" min="1" max="10" step="1" required value={group.choose} onChange={e=>changeGroup(index,{choose:Number(e.target.value)})}/></label></div>
          {group.options.map((option,at)=><div className="service-option-row" key={at}>
            <label className="field">Dish<select required value={option.productId} onChange={e=>changeOption(index,at,{productId:Number(e.target.value),productVariantId:null})}><option value="">Choose dish</option>{choices.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
            <label className="field">Size<select value={option.productVariantId||''} onChange={e=>changeOption(index,at,{productVariantId:e.target.value?Number(e.target.value):null})}><option value="">Standard recipe</option>{(variants[option.productId]||[]).filter(v=>v.status==='active').map(v=><option value={v.id} key={v.id}>{v.name}</option>)}</select></label>
            <label className="field">Portions<input type="number" min="0.01" max="100" step="0.01" required value={option.quantity} onChange={e=>changeOption(index,at,{quantity:Number(e.target.value)})}/></label>
            <label className="field">Extra price<input type="number" min="0" max="99999" step="0.01" required value={option.extraPrice} onChange={e=>changeOption(index,at,{extraPrice:Number(e.target.value)})}/></label>
            <button type="button" className="chip-button" aria-label={`Remove option ${at+1} from ${group.name||'group'}`} onClick={()=>changeGroup(index,{options:group.options.filter((_,i)=>i!==at)})}>Remove</button>
          </div>)}
          <div className="form-actions"><button type="button" className="button button-secondary" onClick={()=>changeGroup(index,{options:[...group.options,{productId:'',productVariantId:null,quantity:1,extraPrice:0}]})}>Add choice</button>
            <button type="button" className="button button-secondary" onClick={()=>setGroups(rows=>rows.filter((_,i)=>i!==index))}>Remove group</button></div>
        </div>)}
        <button type="button" className="button button-secondary" disabled={groups.length>=10} onClick={()=>setGroups([...groups,{name:'',choose:1,options:[]}])}>Add combo group</button>
      </fieldset>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Close</button>{canManage&&<button className="button" disabled={busy}>{busy?'Saving…':'Save serving options'}</button>}</div>
    </form>}
  </Modal>;
}
