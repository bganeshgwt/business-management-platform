import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { forgetMolecules } from "./agri";
import "../styles/agri.css";

// Crops in groups: the crops a farmer's word is matched against at the
// counter. The platform keeps its crops and groups (vegetables, fruits,
// pulses, cereals and millets, oilseeds, fruits and vegetables eaten raw): a
// molecule barred on a group is barred on every crop in it, and a label that
// names a group approves its crops. The shop adds its own crops with their
// groups and other names, and other names and groups for the platform's.
// A crop keeps its name; one of the shop's is switched off, never deleted.

const names = (text) => text.split(",").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);

export default function CropsPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "agri/crops", undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const crops = data?.crops || [];
  const groups = crops.filter((c) => c.is_group);
  const groupName = (code) => groups.find((g) => g.code === code)?.name || code;
  const canEdit = biz.can("agri.edit");
  const saved = (message) => { forgetMolecules(biz.id); setEditing(null); setVersion((n) => n + 1); toast.success(message); };
  async function switchCrop(c) {
    try {
      await businessWrite(biz.id, `agri/crops/${c.shop_crop_id}`, { aliases: c.shop_aliases, groups: c.shop_groups, active: !c.active }, "put");
      saved(c.active ? `${c.name} switched off: it is no longer matched at the counter.` : `${c.name} switched on.`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }
  const columns = [
    { key: "name", header: "Crop", value: (c) => c.name, mobile: "title", pin: true,
      render: (c) => <span className="bz-inline">{c.name}{c.is_group && <Badge tone="info" label="Group" />}{c.own && <Badge tone="neutral" label="The shop's own" />}{c.own && !c.active && <Badge tone="warning" label="Off" />}</span> },
    { key: "groups", header: "In the groups", value: (c) => [...c.groups, ...c.shop_groups].map(groupName).join(", "),
      render: (c) => (c.is_group ? <span className="muted">—</span> : [...c.groups, ...c.shop_groups].length
        ? [...c.groups.map(groupName), ...c.shop_groups.map((g) => `${groupName(g)} (added)`)].join(", ") : <span className="muted">None</span>), mobile: "subtitle" },
    { key: "names", header: "Other names", value: (c) => [...c.aliases, ...c.shop_aliases].join(", "),
      render: (c) => [...c.aliases, ...c.shop_aliases].join(", ") || <span className="muted">—</span> },
    { key: "kind", header: "Kept by", value: (c) => (c.own ? "The shop" : "The platform"), filter: "select", defaultHidden: true },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => (c.is_group ? null : (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => setEditing(c)}>{c.own ? "Change" : "Add names or groups"}</button>
        {c.own && <button type="button" className="chip-button" onClick={() => switchCrop(c)}>{c.active ? "Switch off" : "Switch on"}</button>}
      </span>
    )) },
  ].filter(Boolean);
  return (
    <div className="stack">
      <BusinessHeader icon="leaf" title="Crops"
        description="The crops a farmer's word is matched against at the counter, in their groups: a molecule barred on a group is barred on every crop in it. Add the crops your farmers grow, with the other names they use."
        primary={canEdit && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a crop</button>} />
      <SectionCard flush icon="leaf" title={data ? `${crops.filter((c) => !c.is_group).length} crops in ${groups.length} groups` : "Crops"}>
        <DataGrid id="agri-crops" caption="Crops" columns={columns} rows={crops} rowKey={(c) => c.key} loading={!data && !error} error={data ? "" : error}
          onRetry={() => setVersion((n) => n + 1)} rowNoun={["crop", "crops"]} empty="No crops" emptyIcon="leaf" />
      </SectionCard>
      <p className="small muted">The platform keeps its own crops and groups, the same for every shop; what the shop adds is marked. A crop the counter does not find is kept on the bill as it was said.</p>
      {editing && <CropDialog crop={editing} groups={groups} onClose={() => setEditing(null)} onSaved={(r) => saved(`${r.name} saved.`)} />}
    </div>
  );
}

// A crop of the shop's own (new or changed), or what the shop adds to one of the platform's.
function CropDialog({ crop, groups, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const own = !crop.code;
  const isNew = !crop.key;
  const [form, setForm] = useState({ name: crop.name || "", aliases: (crop.shop_aliases || []).join(", "), groups: crop.shop_groups || [] });
  const toggle = (code) => setForm((f) => ({ ...f, groups: f.groups.includes(code) ? f.groups.filter((g) => g !== code) : [...f.groups, code] }));
  const submit = async () => {
    const body = { aliases: names(form.aliases), groups: form.groups };
    if (crop.shop_crop_id) await businessWrite(biz.id, `agri/crops/${crop.shop_crop_id}`, { ...body, active: crop.active }, "put");
    else await businessWrite(biz.id, "agri/crops", own ? { ...body, name: form.name.trim() } : { ...body, cropCode: crop.code });
    return { name: own ? form.name.trim() : crop.name };
  };
  return (
    <FormDialog title={isNew ? "Add a crop" : own ? `${crop.name}` : `${crop.name}: the shop's additions`} icon="leaf" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={own ? "A crop your farmers grow, with its groups and the other names they use for it." : `Other names your farmers use for ${crop.name}, and more groups it is in. Its own stay as the platform keeps them.`}>
      {isNew && <Field label="Name of the crop"><input required maxLength={80} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Tomato" /></Field>}
      <Field label="Other names (optional)" hint="Separated by commas, e.g. tamatar, tamata." wide>
        <input maxLength={400} value={form.aliases} onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))} />
      </Field>
      <fieldset className="field-wide agri-choices">
        <legend>In the groups</legend>
        {groups.map((g) => (
          <label key={g.code} className="checkbox bz-check">
            <input type="checkbox" checked={form.groups.includes(g.code) || (crop.groups || []).includes(g.code)} disabled={(crop.groups || []).includes(g.code)} onChange={() => toggle(g.code)} /> {g.name}
          </label>
        ))}
      </fieldset>
    </FormDialog>
  );
}
