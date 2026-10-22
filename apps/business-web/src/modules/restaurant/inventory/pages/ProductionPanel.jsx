import {useCallback,useEffect,useRef,useState} from 'react';
import SectionCard from '../../../../components/SectionCard';
import Modal from '../../../../components/Modal';
import {EmptyState,ErrorMessage,Loading,SuccessMessage} from '../../../../components/Feedback';
import DataGrid from '../../../../components/DataGrid/DataGrid';
import {createProductionBatch,getInventoryRecipe,listProductionBatches,saveInventoryRecipe} from '../services/inventory.service';
import api,{getErrorMessage} from '../../../../services/api';
import {moneyExact} from '@bmp/shared/format';
import DateRangeFilter from '../../../../components/DateRangeFilter';
import {rememberedPageSize} from '../../../../components/DataGrid/useGridLayout';
import {today} from '@bmp/shared/dates';
import useQueryFilter from '../../../../hooks/useQueryFilter';

export default function ProductionPanel({items,currency,canManage,onAddPrepared}) {
  const prepared=items.filter(item=>item.itemType==='prepared'&&item.status==='active');
  const [itemId,setItemId]=useState(''),[recipe,setRecipe]=useState([]);
  // Batches made in the chosen days (today to begin with), a page at a time
  // from the server: a central kitchen makes hundreds a month.
  const [from,setFrom]=useQueryFilter('prodFrom',today()),[to,setTo]=useQueryFilter('prodTo',today());
  const [paging,setPaging]=useState(()=>({page:1,pageSize:rememberedPageSize('production-batches',25)}));
  const [batchPage,setBatchPage]=useState({items:[],total:0,totalCost:0});
  const [quantity,setQuantity]=useState(''),[batchNumber,setBatchNumber]=useState(''),[expiryDate,setExpiryDate]=useState(''),[notes,setNotes]=useState('');
  const [error,setError]=useState(''),[success,setSuccess]=useState(''),[loading,setLoading]=useState(true),[recipeLoading,setRecipeLoading]=useState(false);
  const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[voiding,setVoiding]=useState(null),[reason,setReason]=useState('');
  const posting=useRef(false),requestKey=useRef(null);
  const query=useCallback(()=>listProductionBatches({from:from||undefined,to:to||undefined,page:paging.page,pageSize:paging.pageSize}),[from,to,paging]);
  const load=useCallback(async()=>{try{setBatchPage(await query());}catch(e){setError(getErrorMessage(e));}finally{setLoading(false);}},[query]);
  useEffect(()=>{let active=true;query().then(data=>{if(active)setBatchPage(data);}).catch(e=>{if(active)setError(getErrorMessage(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[query]);
  useEffect(()=>{
    if(!itemId)return;
    let active=true;
    getInventoryRecipe(itemId).then(data=>{if(active){setRecipe(data.lines);setDirty(false);}})
      .catch(e=>{if(active)setError(getErrorMessage(e));}).finally(()=>{if(active)setRecipeLoading(false);});
    return()=>{active=false;};
  },[itemId]);
  const item=prepared.find(row=>String(row.id)===String(itemId));
  const changeRecipe=next=>{setRecipe(next);setDirty(true);setSuccess('');};
  const saveRecipe=async()=>{
    setBusy(true);setError('');
    try{const data=await saveInventoryRecipe(itemId,recipe.map(line=>({inventoryItemId:Number(line.inventoryItemId),quantity:Number(line.quantity)})));setRecipe(data.lines);setDirty(false);setSuccess('Prepared-item recipe saved');}
    catch(e){setError(getErrorMessage(e));}finally{setBusy(false);}
  };
  const produce=async event=>{
    event.preventDefault();if(posting.current)return;
    posting.current=true;setBusy(true);setError('');setSuccess('');
    requestKey.current ||= crypto.randomUUID();
    try{
      await createProductionBatch({outputItemId:Number(itemId),quantity:Number(quantity),batchNumber,expiryDate:expiryDate||null,notes,requestKey:requestKey.current});
      requestKey.current=null;setQuantity('');setBatchNumber('');setNotes('');setSuccess('Production posted. Ingredient stock and prepared stock are updated.');await load();
    }catch(e){setError(getErrorMessage(e));if(e.response?.status<500)requestKey.current=null;}
    finally{posting.current=false;setBusy(false);}
  };
  const reverse=async event=>{
    event.preventDefault();setBusy(true);setError('');
    try{await api.post(`/inventory/production/${voiding.id}/void`,{reason});setVoiding(null);setReason('');setSuccess('Production reversed and the original ingredients restored');await load();}
    catch(e){setError(getErrorMessage(e));}finally{setBusy(false);}
  };
  const unitCost=recipe.reduce((sum,line)=>{
    const ingredient=items.find(row=>Number(row.id)===Number(line.inventoryItemId));
    return sum+Number(line.quantity||0)*Number(ingredient?.averageCost??ingredient?.lastCost??0);
  },0);
  return <div className="stack"><ErrorMessage message={error}/><SuccessMessage message={success}/>
    <SectionCard icon="box" title="Prepared items and sub-recipes" description="Define the ingredients for one unit of gravy, dough or sauce, then record the quantity actually produced. Stock is taken from the selected outlet's store, or the main store when shared.">
      {prepared.length===0?<EmptyState message="No prepared items yet" hint="A gravy, dough or sauce the kitchen makes from other items. Give it a unit such as kg, litre or portion."
        action={canManage&&onAddPrepared?<button type="button" className="button" onClick={onAddPrepared}>Add a prepared item</button>:undefined}/>:<div className="stack">
        <label className="field">Prepared item<select value={itemId} disabled={busy} onChange={e=>{setRecipeLoading(Boolean(e.target.value));setError('');setItemId(e.target.value);setRecipe([]);setDirty(false);requestKey.current=null;}}><option value="">Choose prepared item</option>{prepared.map(row=><option key={row.id} value={row.id}>{row.name} ({row.unitShortName})</option>)}</select></label>
        {itemId&&(recipeLoading?<Loading/>:<>
          <p>Recipe for <strong>1 {item?.unitShortName}</strong> of {item?.name}. Prepared ingredients can be used after their own production has been posted.</p>
          {recipe.map((line,index)=><div className="service-option-row" key={index}>
            <label className="field">Ingredient<select disabled={!canManage||busy} value={line.inventoryItemId} onChange={e=>changeRecipe(recipe.map((row,at)=>at===index?{...row,inventoryItemId:e.target.value}:row))}><option value="">Choose ingredient</option>{items.filter(row=>String(row.id)!==String(itemId)&&row.status==='active').map(row=><option key={row.id} value={row.id}>{row.name} ({row.unitShortName})</option>)}</select></label>
            <label className="field">Quantity per unit<input type="number" min="0.0001" step="0.0001" disabled={!canManage||busy} value={line.quantity} onChange={e=>changeRecipe(recipe.map((row,at)=>at===index?{...row,quantity:e.target.value}:row))}/></label>
            {canManage&&<button type="button" className="button button-secondary" disabled={busy} onClick={()=>changeRecipe(recipe.filter((_,at)=>at!==index))}>Remove</button>}
          </div>)}
          {canManage&&<div className="form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>changeRecipe([...recipe,{inventoryItemId:'',quantity:1}])}>Add ingredient</button><button type="button" className="button" disabled={busy||!dirty} onClick={saveRecipe}>Save recipe</button></div>}
          <p className="muted">Estimated recipe cost: {moneyExact(unitCost,currency)} per {item?.unitShortName}. The posted batch uses the ingredient costs at the moment it is saved.</p>
          {canManage&&<form className="form-grid service-option-card" onSubmit={produce}>
            <label className="field">Actual output ({item?.unitShortName})<input type="number" min="0.001" max="9999999" step="0.001" value={quantity} disabled={busy} onChange={e=>{setQuantity(e.target.value);requestKey.current=null;}} required/></label>
            <label className="field">Batch number<input value={batchNumber} maxLength={60} disabled={busy} onChange={e=>{setBatchNumber(e.target.value);requestKey.current=null;}} required placeholder="GRAVY-20260930-AM"/></label>
            <label className="field">Expiry date<input type="date" value={expiryDate} disabled={busy} onChange={e=>{setExpiryDate(e.target.value);requestKey.current=null;}}/></label>
            <label className="field">Notes<input value={notes} maxLength={500} disabled={busy} onChange={e=>setNotes(e.target.value)} placeholder="Yield or preparation notes"/></label>
            <p>Estimated batch cost: <strong>{moneyExact(unitCost*Number(quantity||0),currency)}</strong>{dirty&&' · Save recipe changes before posting.'}</p>
            <button className="button" type="submit" disabled={busy||dirty||!recipe.length}>{busy?'Posting…':'Post production'}</button>
          </form>}
        </>)}
      </div>}
    </SectionCard>
    <SectionCard icon="history" title="Production made" description="Batches made in these dates. A mistaken batch can be voided while all of its output is still in the original store." flush>
      <DataGrid
        id="production-batches"
        caption="Production made"
        rows={batchPage.items}
        toolbar={<DateRangeFilter from={from} to={to} label="production dates" onChange={range=>{setLoading(true);setPaging(current=>({...current,page:1}));setFrom(range.from);setTo(range.to);}}/>}
        server={{
          total:batchPage.total,
          page:paging.page,
          pageSize:paging.pageSize,
          totals:{cost:batchPage.totalCost},
          onChange:({page,pageSize})=>{setLoading(true);setPaging({page:pageSize!==paging.pageSize?1:page,pageSize});},
        }}
        rowKey={row=>row.id}
        loading={loading}
        currency={currency}
        rowNoun={['batch','batches']}
        empty="Nothing made in these dates"
        emptyHint="Pick other dates above."
        emptyIcon="box"
        rowClassName={row=>row.status==='void'?'dg-tone-muted':''}
        exportName="production-batches"
        columns={[
          {key:'batch',header:'Batch',value:row=>row.batchNumber,mobile:'title',pin:true,filter:'text'},
          {key:'made',header:'Made',type:'datetime',value:row=>row.producedAt,mobile:'subtitle'},
          {key:'item',header:'Item / outlet',value:row=>row.itemName,filter:'text',mobile:'show',csv:row=>`${row.itemName} · ${row.outletName||'Main'}`,
            render:row=><>{row.itemName}<div className="muted small">{row.outletName||'Main'}</div></>},
          {key:'quantity',header:'Quantity',type:'number',value:row=>Number(row.quantity),mobile:'show',render:row=><span className="nowrap">{row.quantity} {row.unitShortName}</span>},
          {key:'cost',header:'Cost',type:'money',exact:true,value:row=>row.totalCost,total:'sum',mobile:'show'},
          {key:'expiry',header:'Expiry',type:'date',value:row=>row.expiryDate,render:row=>row.expiryDate||<span className="muted">Not recorded</span>},
          {key:'status',header:'Status',type:'status',value:row=>row.status,filter:'select',mobile:'show',csv:row=>row.status==='void'?'Voided':'Posted',
            filterOptions:[{value:'posted',label:'Posted'},{value:'void',label:'Voided'}],
            render:row=><>{row.status==='void'?'Voided':'Posted'}{row.voidReason&&<div className="muted small">{row.voidReason}</div>}</>},
          canManage&&{key:'action',header:'',label:'Action',type:'actions',
            render:row=>row.status!=='void'?<button type="button" className="button button-secondary button-sm" onClick={()=>{setVoiding(row);setReason('');}}>Void batch</button>:null},
        ]}
      />
    </SectionCard>
    {voiding&&<Modal title={`Void ${voiding.batchNumber}`} onClose={()=>!busy&&setVoiding(null)}><form className="stack" onSubmit={reverse}>
      <p>This reverses the prepared stock and restores the ingredients from the original production record. A batch already used or moved cannot be voided.</p><ErrorMessage message={error}/>
      <label className="field">Reason<textarea required maxLength={300} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <div className="form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={()=>setVoiding(null)}>Cancel</button><button className="button" disabled={busy||!reason.trim()}>Confirm void</button></div>
    </form></Modal>}
  </div>;
}
