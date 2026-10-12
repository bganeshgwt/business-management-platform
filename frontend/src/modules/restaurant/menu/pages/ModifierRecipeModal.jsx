import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getModifierRecipe, saveModifierRecipe } from "../services/menu.service";
import { listInventoryItems } from "../../inventory/services/inventory.service";
import { getErrorMessage } from "../../../../services/api";

export default function ModifierRecipeModal({ modifier, onClose }) {
  const [lines,setLines]=useState(null); const [items,setItems]=useState([]); const [error,setError]=useState(""); const [saving,setSaving]=useState(false);
  useEffect(()=>{Promise.all([getModifierRecipe(modifier.id),listInventoryItems()]).then(([data,rows])=>{setLines(data.lines);setItems(rows.filter(row=>row.status==="active"));}).catch(err=>setError(getErrorMessage(err)));},[modifier.id]);
  const save=async()=>{setSaving(true);try{const data=await saveModifierRecipe(modifier.id,lines.map(line=>({inventoryItemId:Number(line.inventoryItemId),quantity:Number(line.quantity)})));setLines(data.lines);onClose();}catch(err){setError(getErrorMessage(err));}finally{setSaving(false);}};
  return <Modal title={`${modifier.name} — ingredient recipe`} description="Stock used each time this add-on is sold." icon="book" onClose={onClose} footer={<><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button type="button" className="button" onClick={save} disabled={saving}>Save recipe</button></>}>
    <ErrorMessage message={error}/>{lines===null?<Loading/>:<div className="stack">{lines.map((line,index)=><div className="inline-form" key={index}><select value={line.inventoryItemId} onChange={e=>setLines(lines.map((row,at)=>at===index?{...row,inventoryItemId:e.target.value}:row))}>{items.map(item=><option key={item.id} value={item.id}>{item.name} ({item.unitShortName})</option>)}</select><input type="number" min="0.0001" step="0.0001" value={line.quantity} onChange={e=>setLines(lines.map((row,at)=>at===index?{...row,quantity:e.target.value}:row))}/><button type="button" className="chip-button" onClick={()=>setLines(lines.filter((_,at)=>at!==index))}>Remove</button></div>)}<button type="button" className="button button-secondary" disabled={!items.length} onClick={()=>setLines([...lines,{inventoryItemId:items[0].id,quantity:1}])}>Add ingredient</button></div>}
  </Modal>;
}
