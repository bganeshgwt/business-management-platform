import { useEffect, useState } from 'react';
import SectionCard from '../../../../components/SectionCard';
import { ErrorMessage } from '../../../../components/Feedback';
import { businessRead, businessWrite } from '../../../../services/business.service';
import { getErrorMessage } from '../../../../services/api';
import { toast } from '../../../../services/toast';
import FormDialog from './FormDialog';
import { Field } from './ui';
import { newKey } from './hooks';

export default function CashCheck({biz,data,date,locationId,onSaved}) {
  const [state,setState]=useState({key:'',checks:[],error:''});
  const [open,setOpen]=useState(false);
  const [version,setVersion]=useState(0);
  const selected=locationId||(biz.locations.length===1?String(biz.locations[0].id):'');
  const canRead=(!biz.has('expenses')||biz.can('expenses.view'))&&(biz.can('sales.view')||biz.can('reports.view'));
  const currentKey=`${biz.id}:${date}:${selected}:${version}`;
  const {checks,error}=state.key===currentKey?state:{checks:[],error:''};
  const loading=Boolean(selected&&date&&state.key!==currentKey);
  useEffect(()=>{
    if(!selected||!date||!canRead)return;
    const controller=new AbortController();
    businessRead(biz.id,'cash-checks',{date,locationId:selected},controller.signal).then(checks=>setState({key:currentKey,checks,error:''}))
      .catch(err=>{if(!controller.signal.aborted)setState({key:currentKey,checks:[],error:getErrorMessage(err)});});
    return()=>controller.abort();
  },[biz.id,date,selected,version,currentKey,canRead]);
  if(!date||!canRead)return null;
  const latest=checks[0];
  const canCheck=biz.can('reports.edit')&&(!biz.has('expenses')||biz.can('expenses.view'));
  return <SectionCard icon="cash" title="Cash check" description="Compare the drawer with opening cash plus recorded cash movements. This saves a snapshot; trading can continue."
    actions={canCheck&&<button type="button" className="button button-secondary" disabled={!data||!selected} onClick={()=>setOpen(true)}>Count cash</button>}>
    <ErrorMessage message={error}/>
    {!selected?<p className="muted">Select one location above to check its cash.</p>:loading?<p className="muted" role="status">Loading cash checks…</p>:latest?<>
      <div className="stat-grid">
        <div><span className="muted small">Expected when checked</span><p><strong>{biz.exact(latest.expected_cash)}</strong></p></div>
        <div><span className="muted small">Counted</span><p><strong>{biz.exact(latest.counted_cash)}</strong></p></div>
        <div><span className="muted small">Difference</span><p><strong>{biz.exact(latest.difference)}</strong></p></div>
      </div>
      <p className="small muted">Checked by {latest.created_by_name} at {new Date(latest.created_at).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'})}.{latest.reason?` Reason: ${latest.reason}`:''}</p>
      {data&&Number(latest.movement_cash)!==Number(data.cashInHand)&&<p className="small">Cash movements have changed since this check. Count again when ready.</p>}
      {checks.length>1&&<details><summary>Previous checks ({checks.length-1})</summary>{checks.slice(1).map(c=><p key={c.id} className="small">{new Date(c.created_at).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'})} · Counted {biz.exact(c.counted_cash)} · Difference {biz.exact(c.difference)}{c.reason?` · ${c.reason}`:''}</p>)}</details>}
    </>:<p className="muted">No cash check recorded for this day.</p>}
    {open&&<CashCheckDialog biz={biz} data={data} date={date} locationId={selected} opening={latest?.opening_cash||'0'}
      onClose={()=>setOpen(false)} onSaved={()=>{setOpen(false);setVersion(v=>v+1);onSaved?.();toast.success('Cash check recorded');}}/>}
  </SectionCard>;
}

function CashCheckDialog({biz,data,date,locationId,opening,onClose,onSaved}) {
  const [form,setForm]=useState({openingCash:opening,countedCash:'',reason:''});
  const [requestKey]=useState(newKey);
  const expected=Math.round((Number(form.openingCash)+Number(data.cashInHand))*100)/100;
  const difference=form.countedCash===''?0:Math.round((Number(form.countedCash)-expected)*100)/100;
  const set=key=>event=>setForm(old=>({...old,[key]:event.target.value}));
  return <FormDialog title="Count cash" icon="cash" onClose={onClose} onSaved={onSaved} submitLabel="Record cash check"
    description="Opening cash is the money already in the drawer at the start of this day. The server calculates the expected amount when you save."
    onSubmit={()=>businessWrite(biz.id,'cash-checks',{...form,date,locationId,requestKey})}>
    <Field label="Opening cash"><input required type="number" min="0" max="999999999" step="0.01" value={form.openingCash} onChange={set('openingCash')}/></Field>
    <Field label="Cash counted"><input required type="number" min="0" max="999999999" step="0.01" value={form.countedCash} onChange={set('countedCash')}/></Field>
    <p className="field-wide">Expected now: <strong>{biz.exact(expected)}</strong>{form.countedCash!==''&&<> · Difference: <strong>{biz.exact(difference)}</strong></>}</p>
    <Field label={difference?'Reason for the difference':'Notes (optional)'} wide><input required={difference!==0} maxLength={300} value={form.reason} onChange={set('reason')}/></Field>
  </FormDialog>;
}
