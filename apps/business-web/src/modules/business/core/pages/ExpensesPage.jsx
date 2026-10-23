import { useState } from 'react';
import DataGrid from '../../../../components/DataGrid/DataGrid';
import SectionCard from '../../../../components/SectionCard';
import StatTile from '../../../../components/StatTile';
import Icon from '@bmp/ui/Icon';
import { ErrorMessage } from '../../../../components/Feedback';
import { businessWrite } from '../../../../services/business.service';
import { toast } from '../../../../services/toast';
import FormDialog from './FormDialog';
import { Badge, BusinessHeader, Field, PeriodFilter } from './ui';
import { businessToday, newKey, useOpenBusiness, useServerList } from './hooks';
import { usePaymentMethods } from './paymentMethods';

const CATEGORIES = {rent:'Rent',utilities:'Electricity & water',wages:'Wages',transport:'Transport',supplies:'Shop supplies',cleaning:'Cleaning',maintenance:'Maintenance',other:'Other'};

export default function ExpensesPage() {
  const biz = useOpenBusiness();
  const list = useServerList('expenses',{gridId:'business-expenses',period:true});
  const [adding,setAdding] = useState(false);
  const [reversing,setReversing] = useState(null);
  const totals = list.data?.totals;
  const done = () => { setAdding(false);setReversing(null);list.reload(); };
  return <div className="stack">
    <BusinessHeader icon="expenses" title="Daily expenses" description="Money already paid for running the business. Supplier bills and stock purchases stay in Purchases."
      actions={biz.can('expenses.create') && <button type="button" className="button" onClick={()=>setAdding(true)}><Icon name="plus" size={16}/> Record expense</button>}/>
    <div className="stat-grid">
      <StatTile icon="wallet" label="Paid" value={totals?biz.exact(totals.paid):undefined} loading={!totals && !list.error}/>
      <StatTile icon="undo" label="Reversed" value={totals?biz.exact(totals.reversed):undefined} loading={!totals && !list.error}/>
      <StatTile icon="expenses" label="Net expenses" value={totals?biz.exact(Number(totals.paid)-Number(totals.reversed)):undefined} loading={!totals && !list.error}/>
    </div>
    <ErrorMessage message={list.error}/>
    <SectionCard flush icon="list" title="Expense history">
      <DataGrid {...list.gridProps} caption="Paid business expenses" currency={biz.symbol} rowNoun={['expense','expenses']} toolbar={<PeriodFilter list={list}/>}
        columns={[
          {key:'spent_on',header:'Date',type:'date',value:r=>r.spent_on,mobile:'subtitle'},
          {key:'description',header:'Paid for',value:r=>r.description,mobile:'title',pin:true},
          {key:'category',header:'Category',value:r=>CATEGORIES[r.category]},
          {key:'amount',header:'Amount',type:'money',exact:true,value:r=>Number(r.amount),mobile:'show'},
          {key:'method',header:'Paid by',value:r=>r.method_name || ({cash:'Cash',upi:'UPI',card:'Card',bank:'Bank transfer'})[r.method]},
          {key:'reference',header:'Reference',value:r=>r.reference || '',defaultHidden:true},
          {key:'location',header:'Location',value:r=>r.location_name,defaultHidden:biz.locations.length<2},
          {key:'status',header:'Status',value:r=>r.voided_at?'Reversed':'Paid',render:r=><Badge tone={r.voided_at?'neutral':'success'} label={r.voided_at?'Reversed':'Paid'}/>},
          {key:'reason',header:'Reversal reason',value:r=>r.void_reason || '',defaultHidden:true},
          {key:'actor',header:'Recorded by',value:r=>r.created_by_name,defaultHidden:true},
          {key:'actions',header:'',type:'actions',label:'Actions',render:r=>!r.voided_at&&biz.can('expenses.approve')&&<button type="button" className="chip-button" onClick={()=>setReversing(r)}>Reverse</button>},
        ]} empty="No expenses recorded for these dates" emptyHint="Record cash or digital expenses when they are paid."/>
    </SectionCard>
    {adding&&<ExpenseDialog biz={biz} onClose={()=>setAdding(false)} onSaved={()=>{done();toast.success('Expense recorded');}}/>}
    {reversing&&<ReverseExpense expense={reversing} biz={biz} onClose={()=>setReversing(null)} onSaved={()=>{done();toast.success('Expense reversed');}}/>}
  </div>;
}

function ExpenseDialog({biz,onClose,onSaved}) {
  const methods=usePaymentMethods();
  const today=businessToday(biz.business.timezone);
  const [requestKey]=useState(newKey);
  const [form,setForm]=useState({spentOn:today,description:'',category:'other',amount:'',method:'cash',reference:'',locationId:String(biz.currentLocationId||biz.locations[0]?.id||'')});
  const set=name=>event=>setForm(old=>({...old,[name]:event.target.value}));
  return <FormDialog title="Record paid expense" icon="expenses" onClose={onClose} onSaved={onSaved} submitLabel="Record expense"
    onSubmit={()=>businessWrite(biz.id,'expenses',{...form,...methods.body(form.method,['cash','upi','card','bank']),requestKey})}>
    <Field label="Paid for" wide><input required maxLength={200} placeholder="e.g. Electricity bill" value={form.description} onChange={set('description')}/></Field>
    <Field label="Amount"><input required type="number" inputMode="decimal" min="0.01" max="999999999" step="0.01" value={form.amount} onChange={set('amount')}/></Field>
    <Field label="Paid by"><select value={methods.resolve(form.method,['cash','upi','card','bank'])} onChange={set('method')}>{methods.options(['cash','upi','card','bank']).map(m=><option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
    <Field label="Date"><input required type="date" max={today} value={form.spentOn} onChange={set('spentOn')}/></Field>
    <Field label="Category"><select value={form.category} onChange={set('category')}>{Object.entries(CATEGORIES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field>
    {biz.locations.length>1&&<Field label="Location"><select required value={form.locationId} onChange={set('locationId')}>{biz.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
    <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set('reference')} placeholder="Receipt or transaction number"/></Field>
  </FormDialog>;
}

function ReverseExpense({expense,biz,onClose,onSaved}) {
  const [reason,setReason]=useState('');
  return <FormDialog title="Reverse expense" icon="undo" description={`Reverse ${biz.exact(expense.amount)} for ${expense.description}. The original record stays in history; the reversal appears in today's money summary. Use this for a mistaken entry or money actually returned.`}
    onClose={onClose} onSaved={onSaved} submitLabel="Reverse expense" onSubmit={()=>businessWrite(biz.id,`expenses/${expense.id}/reverse`,{reason})}>
    <Field label="Reason" wide><input required maxLength={300} value={reason} onChange={e=>setReason(e.target.value)}/></Field>
  </FormDialog>;
}
