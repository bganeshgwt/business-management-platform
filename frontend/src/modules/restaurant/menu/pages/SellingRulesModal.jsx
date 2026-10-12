import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage } from "../../../../components/Feedback";
import api, { getErrorMessage } from "../../../../services/api";
import { money } from "../../../../services/format";

const EMPTY={outletId:"",channelId:"",orderType:"",price:"",packagingCharge:"",isAvailable:true};
export default function SellingRulesModal({product,currency="₹",onClose}) {
  const [rules,setRules]=useState([]),[options,setOptions]=useState({outlets:[],channels:[]});
  const [form,setForm]=useState(EMPTY),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const load=async()=>{
    const [r,o]=await Promise.all([api.get(`/menu/products/${product.id}/selling-rules`),api.get("/menu/selling-options")]);
    setRules(r.data.data);setOptions(o.data.data);
  };
  useEffect(()=>{
    let active=true;
    Promise.all([api.get(`/menu/products/${product.id}/selling-rules`),api.get("/menu/selling-options")])
      .then(([r,o])=>{if(active){setRules(r.data.data);setOptions(o.data.data);}})
      .catch(e=>{if(active)setError(getErrorMessage(e));});
    return ()=>{active=false;};
  },[product.id]);
  const save=async e=>{
    e.preventDefault();setBusy(true);setError("");
    try{await api.put(`/menu/products/${product.id}/selling-rules`,form);await load();setForm(EMPTY);}
    catch(e){setError(getErrorMessage(e));}finally{setBusy(false);}
  };
  const remove=async id=>{
    setBusy(true);setError("");
    try{await api.delete(`/menu/selling-rules/${id}`);await load();}
    catch(e){setError(getErrorMessage(e));}finally{setBusy(false);}
  };
  const change=key=>e=>setForm({...form,[key]:e.target.value});
  const name=(list,id)=>list.find(x=>Number(x.id)===Number(id))?.name|| (id?`#${id}`:"All");
  return <Modal title={`Prices & outlets — ${product.name}`} onClose={onClose}>
    <div className="stack">
      <p>Set a base price or hide this dish for a service, channel or outlet. Sizes keep their price differences. Existing order lines keep their saved prices.</p>
      <p className="muted small">The most specific rule wins: outlet first, then channel, then service type. Active happy-hour prices override these prices. A blank price uses the menu price.</p>
      <ErrorMessage message={error}/>
      <form onSubmit={save} className="stack">
        <label className="field">Outlet<select value={form.outletId} onChange={change("outletId")}><option value="">All outlets</option>{options.outlets.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="field">Channel<select value={form.channelId} onChange={change("channelId")}><option value="">All channels</option>{options.channels.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="field">Service<select value={form.orderType} onChange={change("orderType")}><option value="">All service types</option>{["dine_in","takeaway","delivery","qr","online"].map(x=><option key={x} value={x}>{x.replaceAll("_"," ")}</option>)}</select></label>
        <label className="field">Base price<input type="number" min="0" max="99999999" step="0.01" value={form.price} onChange={change("price")} placeholder={String(product.price)}/></label>
        <label className="field">Packaging per item<input type="number" min="0" max="99999" step="0.01" value={form.packagingCharge} onChange={change("packagingCharge")}/><small>Applies to takeaway, delivery and online orders. Included with this dish for tax, discounts and refunds. Dine-in and table QR orders have no packaging charge.</small></label>
        <label><input type="checkbox" checked={form.isAvailable} onChange={e=>setForm({...form,isAvailable:e.target.checked})}/> Available in this context</label>
        <button className="button" disabled={busy}>Save rule</button>
      </form>
      <DataGrid
        id="menu-selling-rules"
        variant="compact"
        caption={`Selling rules for ${product.name}`}
        rows={rules}
        rowKey={(r) => r.id}
        rowNoun={["rule", "rules"]}
        currency={currency}
        empty="No rules yet: the dish sells at its menu price everywhere."
        emptyIcon="store"
        columns={[
          { key: "outlet", header: "Outlet", value: (r) => name(options.outlets, r.outlet_id), mobile: "title" },
          { key: "channel", header: "Channel", value: (r) => name(options.channels, r.channel_id), mobile: "show" },
          { key: "service", header: "Service", value: (r) => r.order_type || "All", mobile: "show" },
          {
            key: "price",
            header: "Price",
            type: "money",
            value: (r) => (r.price === null || r.price === undefined ? null : Number(r.price)),
            mobile: "show",
            render: (r) =>
              r.price === null || r.price === undefined ? <span className="muted">Menu price</span> : money(r.price, currency),
          },
          { key: "packaging", header: "Packaging", type: "money", value: (r) => Number(r.packaging_charge || 0), mobile: "show" },
          { key: "available", header: "Available", value: (r) => (r.is_available ? "Yes" : "No"), mobile: "subtitle" },
          {
            key: "remove",
            header: "",
            label: "Remove",
            type: "actions",
            render: (r) => (
              <button className="button button-secondary" disabled={busy} onClick={() => remove(r.id)}>
                Remove
              </button>
            ),
          },
        ]}
      />
    </div>
  </Modal>;
}
