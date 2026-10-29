const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./garageCommon');
const jobs = require('./garageJobCards.service');
const consents = require('../../../personal-data/services/consents');

// Service due (module "garage", garages): every vehicle in use whose next
// service falls within a week, by its date or by the reading it will
// probably reach (the average a day since its meter was last changed), and
// every one whose insurance or PUC runs out within 30 days or has run out.
// Each row has the owner and their phone, when it is due, the last reminder of
// that kind (one in the last 30 days counts as recent) and the last job card.
// A reminder goes from the person's own WhatsApp (a prepared message) or by a
// call, and is kept. The months and kilometres to the next service after a job
// (6 and 5,000 until changed), the item that bills the owner's share of a
// claim, whether parts are issued to mechanics (or leave stock when the job is
// billed) and whether a road test comes before ready are the garage's settings.

const { fail, id } = c;
const SERVICE_DAYS = 7;
const EXPIRY_DAYS = 30;

repo.addLists({
  // One row per vehicle and reason (service, insurance, PUC), the soonest due first.
  'garage-service-due': {
    sql: `WITH z AS (SELECT timezone AS tz,(now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1),
      cars AS (
        SELECT v.id AS vehicle_id,v.registration_no,concat_ws(' ',v.make,v.model,v.variant) AS vehicle_name,v.contact_id,k.name AS owner_name,k.phone AS owner_phone,
          v.odometer_km,v.odometer_at,v.next_service_on,v.next_service_km,v.insurance_expires_on,v.puc_expires_on,z.today,
          ${c.AVERAGE_SQL} AS average_km_day,${c.PROJECTED_SQL('v', 'z.today')} AS projected_km,
          (SELECT j.job_no FROM garage_job_cards j WHERE j.business_id=v.business_id AND j.vehicle_id=v.id AND j.status='delivered' ORDER BY j.id DESC LIMIT 1) AS last_job_no,
          (SELECT max(j.delivered_at) FROM garage_job_cards j WHERE j.business_id=v.business_id AND j.vehicle_id=v.id AND j.status='delivered') AS last_job_at,
          EXISTS (SELECT 1 FROM garage_job_cards j WHERE j.business_id=v.business_id AND j.vehicle_id=v.id AND j.status NOT IN ('delivered','cancelled')) AS in_workshop
        FROM garage_vehicles v CROSS JOIN z JOIN business_contacts k ON k.business_id=v.business_id AND k.id=v.contact_id
        ${c.DRIVING_SQL('v')}
        WHERE v.business_id=$1 AND v.active),
      timed AS (
        SELECT cars.*,CASE WHEN next_service_km IS NULL THEN NULL
            WHEN average_km_day > 0 THEN today + ceil((next_service_km - projected_km) / average_km_day)::int
            WHEN odometer_km >= next_service_km THEN today END AS km_due_on
        FROM cars),
      due AS (
        SELECT timed.*,'service' AS kind,next_service_on AS due_on FROM timed
        WHERE next_service_on <= today + ${SERVICE_DAYS} OR km_due_on <= today + ${SERVICE_DAYS}
        UNION ALL SELECT timed.*,'insurance',insurance_expires_on FROM timed WHERE insurance_expires_on <= today + ${EXPIRY_DAYS}
        UNION ALL SELECT timed.*,'puc',puc_expires_on FROM timed WHERE puc_expires_on <= today + ${EXPIRY_DAYS})
      SELECT due.*,due.vehicle_id || ':' || due.kind AS id,
        CASE WHEN due.kind='service' THEN LEAST(due.due_on,due.km_due_on) ELSE due.due_on END AS due_by,
        (CASE WHEN due.kind='service' THEN LEAST(due.due_on,due.km_due_on) ELSE due.due_on END) - due.today AS days_left,
        (SELECT max(m.created_at) FROM garage_reminders m WHERE m.business_id=$1 AND m.vehicle_id=due.vehicle_id AND m.kind=due.kind) AS reminded_at,
        (SELECT count(*)::int FROM garage_reminders m WHERE m.business_id=$1 AND m.vehicle_id=due.vehicle_id AND m.kind=due.kind) AS reminders,
        COALESCE((SELECT max(m.created_at) > now() - interval '30 days' FROM garage_reminders m WHERE m.business_id=$1 AND m.vehicle_id=due.vehicle_id AND m.kind=due.kind),false)
          AS reminded_recently
      FROM due`,
    search: ['registration_no', 'vehicle_name', 'owner_name', 'owner_phone', 'last_job_no'],
    filters: { kind: 'kind', reminded: 'reminded_recently', owner: 'contact_id', in_workshop: 'in_workshop' },
    order: 'due_by NULLS LAST,registration_no,kind',
  },
});

// body: { kind: service | insurance | puc, channel: whatsapp | call | sms }
async function remind(business, user, vehicleId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  const kind = v.requiredEnum(body.kind ?? 'service', 'Reminder for', ['service', 'insurance', 'puc']);
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', ['whatsapp', 'call', 'sms']);
  return repo.transaction(async (db) => {
    const vehicle = await repo.one(db, 'SELECT v.id,v.registration_no,v.contact_id,k.name AS owner_name FROM garage_vehicles v JOIN business_contacts k ON k.business_id=v.business_id AND k.id=v.contact_id WHERE v.business_id=$1 AND v.id=$2',
      [business.id, id(vehicleId, 'Vehicle')]);
    if (!vehicle) fail('Vehicle not found', 404);
    // A reminder on WhatsApp, by SMS or by a call needs the owner's consent to reminders.
    await consents.requireReminder(db, business.id, vehicle.contact_id, channel, vehicle.owner_name);
    const row = await repo.one(db, 'INSERT INTO garage_reminders(business_id,vehicle_id,kind,channel,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [business.id, vehicle.id, kind, channel, user.id]);
    await repo.audit(db, business.id, user.id, 'service_reminder.sent', vehicle.id, { registrationNo: vehicle.registration_no, owner: vehicle.owner_name, kind, channel });
    return row;
  });
}

async function settings(business) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  const s = await jobs.settingsOf(repo.pool, business);
  return shown(s);
}
const shown = (s) => ({ service_months: s.service_months, service_km: s.service_km, claim_share_sku_id: s.claim_share_sku_id, claim_share: s.share, issue_parts: s.issue_parts,
  road_test_required: s.road_test_required, updated_at: s.updated_at, updated_by_name: s.updated_by_name });

// body: { serviceMonths, serviceKm, claimShareSkuId? (empty: none), issueParts?, roadTestRequired? } — whole months 1 to 36, kilometres
// 500 to 1,00,000; the two switches stay as they are when left out.
async function saveSettings(business, user, body) {
  c.requireGarage(business);
  await access.require(business, 'settings.edit');
  const months = String(body.serviceMonths ?? '').trim();
  if (!/^\d{1,2}$/.test(months) || Number(months) < 1 || Number(months) > 36) fail('The next service is due 1 to 36 whole months after a job');
  const distance = c.readKm(body.serviceKm, 'Kilometres to the next service');
  if (distance === null || distance < 500 || distance > 100000) fail('The next service is due 500 to 1,00,000 km after a job');
  const shareId = c.given(body.claimShareSkuId) ? id(body.claimShareSkuId, 'Claim-share item') : null;
  const issueAsked = body.issueParts === undefined ? undefined : v.requiredBoolean(body.issueParts, 'Issue parts to mechanics');
  const roadAsked = body.roadTestRequired === undefined ? undefined : v.requiredBoolean(body.roadTestRequired, 'A road test before ready');
  return repo.transaction(async (db) => {
    if (shareId) {
      const sku = await repo.one(db, `SELECT s.label,s.active,s.internal_use,p.kind,p.active AS product_active FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2`, [business.id, shareId]);
      if (!sku) fail('Item not found', 404);
      if (sku.kind !== 'service') fail(`${sku.label} is kept in stock: the owner's share of a claim is billed as a service item`);
      if (!sku.active || !sku.product_active || sku.internal_use) fail(`${sku.label} is not billed now: choose an item that is sold`);
    }
    const before = await jobs.settingsOf(db, business);
    const issueParts = issueAsked ?? before.issue_parts, roadTestRequired = roadAsked ?? before.road_test_required;
    // Switching issuing off while parts are held for open job cards would leave them out of stock unbilled.
    if (before.issue_parts && !issueParts) {
      const open = await repo.one(db, `SELECT j.job_no FROM garage_part_issues i JOIN garage_job_cards j ON j.business_id=i.business_id AND j.id=i.job_card_id
        WHERE i.business_id=$1 AND j.status NOT IN ('delivered','cancelled') GROUP BY j.id,j.job_no
        HAVING sum(CASE WHEN i.kind='issue' THEN i.quantity ELSE -i.quantity END) > 0 LIMIT 1`, [business.id]);
      if (open) fail(`Parts are held for job card ${open.job_no}: bill it, or bring them back, before switching issuing off`, 409);
    }
    await db.query(`INSERT INTO garage_settings(business_id,service_months,service_km,claim_share_sku_id,updated_by,issue_parts,road_test_required) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (business_id) DO UPDATE SET service_months=EXCLUDED.service_months,service_km=EXCLUDED.service_km,claim_share_sku_id=EXCLUDED.claim_share_sku_id,
        issue_parts=EXCLUDED.issue_parts,road_test_required=EXCLUDED.road_test_required,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, Number(months), distance, shareId, user.id, issueParts, roadTestRequired]);
    const was = { serviceMonths: before.service_months, serviceKm: before.service_km, claimShareSkuId: before.claim_share_sku_id ? Number(before.claim_share_sku_id) : null,
      issueParts: before.issue_parts, roadTestRequired: before.road_test_required };
    const now = { serviceMonths: Number(months), serviceKm: distance, claimShareSkuId: shareId, issueParts, roadTestRequired };
    const changed = Object.keys(now).filter((key) => was[key] !== now[key]);
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'garage_settings.updated', business.id, {
        from: Object.fromEntries(changed.map((key) => [key, was[key]])), to: Object.fromEntries(changed.map((key) => [key, now[key]])) });
    }
    return shown(await jobs.settingsOf(db, business));
  });
}

module.exports = { remind, settings, saveSettings };
