// Called with the inventory item locked, in the stock movement's transaction.
// Allocation is an accounting assumption: staff must physically pick the same
// batch. Missing expiry dates remain unknown, including pre-migration stock.
//
// Stock going out is taken first-expiry-first. Hand-entered kitchen issues,
// production and transfers still refuse a batch past its expiry date — the
// fix there is to write it off and use fresh stock. A sale is different: a
// bill must never fail because of stock (inventory.repository recordMovement
// lets billing go below zero for the same reason). When a bill needs more than
// the unexpired batches hold, it takes the rest from the expired batches,
// marks each of those allocations "after expiry" and the ledger row with how
// much that was, so the batch view and the bell can say "expired paneer was
// used on INV-0042" and the manager can act. Only then, if even that is not
// enough, does the shortfall go below zero.
async function allocate(client, restaurantId, movement, store, transactionId) {
  const AppError=require('../../../../utils/AppError');
  const quantity=Number(movement.quantity), allocations=[];
  let expiredTaken=0;
  const createBatch=async()=> (await client.query(`INSERT INTO inventory_batches
    (restaurant_id,inventory_item_id,batch_number,expiry_date,received_at)
    VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,NOW())) RETURNING id`,
    [restaurantId,movement.inventoryItemId,movement.batchNumber||null,movement.expiryDate||null,movement.effectiveAt||null])).rows[0].id;
  const add=async(batchId,amount,afterExpiry=false)=>{
    if(Math.abs(amount)<0.0000001)return;
    await client.query(`INSERT INTO inventory_batch_balances(batch_id,outlet_id,quantity) VALUES($1,$2,$3)
      ON CONFLICT(batch_id,outlet_id) DO UPDATE SET quantity=inventory_batch_balances.quantity+EXCLUDED.quantity`,[batchId,store,amount]);
    await client.query(`INSERT INTO inventory_batch_movements(stock_transaction_id,batch_id,quantity,after_expiry) VALUES($1,$2,$3,$4)
      ON CONFLICT(stock_transaction_id,batch_id) DO UPDATE SET quantity=inventory_batch_movements.quantity+EXCLUDED.quantity,
        after_expiry=inventory_batch_movements.after_expiry OR EXCLUDED.after_expiry`,[transactionId,batchId,amount,afterExpiry]);
    allocations.push({batchId,quantity:amount});
  };
  let remaining=Math.abs(quantity);
  if (quantity < 0 && movement.batchId) {
    const picked=(await client.query(`SELECT bb.quantity FROM inventory_batch_balances bb
      JOIN inventory_batches b ON b.id=bb.batch_id WHERE b.restaurant_id=$1 AND b.inventory_item_id=$2
      AND b.id=$3 AND bb.outlet_id IS NOT DISTINCT FROM $4`,[restaurantId,movement.inventoryItemId,movement.batchId,store])).rows[0];
    if(movement.transactionType!=='wastage') throw new AppError(400,'Specific batches can be selected when recording wastage');
    if(!picked || Number(picked.quantity)<remaining) throw new AppError(409,'That batch no longer has enough stock in this store');
    await add(movement.batchId,-remaining);
    return;
  }
  // Transfers carry exactly the batches selected at the source store.
  if(movement.batchAllocations){
    for(const entry of movement.batchAllocations){await add(entry.batchId,Math.abs(entry.quantity));remaining-=Math.abs(entry.quantity);}
  } else {
    const original=movement.referenceType==='production_void'?'production':
      movement.referenceType==='goods_receipt_void'?'goods_receipt':
      movement.referenceType==='purchase_return_void'?'purchase_return':
      movement.referenceType==='bill'&&quantity>0?'bill':null;
    if(original){
      const rows=(await client.query(`SELECT bm.batch_id, SUM(bm.quantity) AS quantity
        FROM inventory_batch_movements bm JOIN stock_transactions st ON st.id=bm.stock_transaction_id
        WHERE st.restaurant_id=$1 AND st.inventory_item_id=$2 AND st.reference_type=$3 AND st.reference_id=$4
          AND st.quantity*$5 < 0
        GROUP BY bm.batch_id ORDER BY bm.batch_id`,[restaurantId,movement.inventoryItemId,original,movement.referenceId,quantity])).rows;
      for(const row of rows){const amount=Math.min(remaining,Math.abs(Number(row.quantity)));await add(row.batch_id,Math.sign(quantity)*amount);remaining-=amount;if(remaining<0.0000001)break;}
    }
    if(quantity<0 && remaining>0.0000001){
      const rows=(await client.query(`SELECT b.id,bb.quantity,
        b.expiry_date < (NOW() AT TIME ZONE COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id=$1),'Asia/Kolkata'))::date AS expired
        FROM inventory_batches b
        JOIN inventory_batch_balances bb ON bb.batch_id=b.id
        WHERE b.restaurant_id=$1 AND b.inventory_item_id=$2 AND bb.outlet_id IS NOT DISTINCT FROM $3
          AND bb.quantity>0
          AND (NOT $4::boolean OR (b.batch_number IS NULL AND b.expiry_date IS NULL))
        ORDER BY b.expiry_date ASC NULLS LAST,b.received_at,b.id`,[restaurantId,movement.inventoryItemId,store,Boolean(original)])).rows;
      // A sale (billing's own consumption) is never refused for stock.
      const sale=movement.referenceType==='bill';
      const protect=['consumption','transfer'].includes(movement.transactionType)||sale;
      for(const row of rows){if(protect && row.expired)continue;const amount=Math.min(remaining,Number(row.quantity));await add(row.id,-amount);remaining-=amount;if(remaining<0.0000001)break;}
      if(sale && remaining>0.0000001){
        // Fresh stock ran out: the rest comes from the expired batches, the
        // oldest first, each allocation marked as taken after expiry.
        for(const row of rows){
          if(!row.expired)continue;
          const amount=Math.min(remaining,Number(row.quantity));
          if(amount<0.0000001)continue;
          await add(row.id,-amount,true);remaining-=amount;expiredTaken+=amount;
          if(remaining<0.0000001)break;
        }
      } else if(protect && remaining>0.0000001 && rows.some(row=>row.expired)) {
        const item=(await client.query('SELECT name FROM inventory_items WHERE id=$1',[movement.inventoryItemId])).rows[0];
        throw new AppError(409,`${item.name}: not enough unexpired stock. Record expired batches as wastage and receive fresh stock before continuing.`);
      }
    }
  }
  if(remaining>0.0000001)await add(await createBatch(),Math.sign(quantity)*remaining);
  // Kept to the ledger's three places; the row is this movement's own.
  const expired=Math.round(expiredTaken*1000)/1000;
  if(expired>0){
    await client.query('UPDATE stock_transactions SET expired_quantity=$2 WHERE id=$1',[transactionId,expired]);
  }
  if(movement.batchResult){movement.batchResult.allocations=allocations;movement.batchResult.expiredTaken=expired;}
}

// The batch view: every batch still holding stock at a store, first to
// expire first, with how many days it has left on the restaurant's own clock.
// A batch a sale had to use after it expired is listed too (for a week, even
// once it is used up), with how much and on which bill, so the manager sees
// exactly what the bell warned about.
//
// filters: { storeOnly: boolean, storeId (null = main store),
//            show: all | expiring | soon | expired | unknown | used_after_expiry,
//            within (days, for "expiring"), hiddenItemIds }
const SHOWS = {
  all: "TRUE",
  // Already past its date, or reaching it within `within` days.
  expiring: "(b.expiry_date IS NOT NULL AND x.days_left <= x.within AND bb.quantity > 0)",
  // The bell's "expiring within 2 days" (today, tomorrow, the day after).
  soon: "(b.expiry_date IS NOT NULL AND x.days_left BETWEEN 0 AND 2 AND bb.quantity > 0)",
  expired: "(b.expiry_date IS NOT NULL AND x.days_left < 0 AND bb.quantity > 0)",
  unknown: "(b.expiry_date IS NULL AND bb.quantity <> 0)",
  used_after_expiry: "(used.quantity > 0)",
};

async function findBatches(restaurantId, filters = {}) {
  const pool = require('../../../../config/database');
  const show = SHOWS[filters.show] ? filters.show : 'all';
  const result = await pool.query(
    `SELECT b.id, b.inventory_item_id, i.name, u.short_name AS unit,
            b.batch_number, to_char(b.expiry_date,'YYYY-MM-DD') AS expiry_date,
            x.days_left, bb.outlet_id, COALESCE(o.name,'Main store') AS store, bb.quantity,
            COALESCE(i.average_cost, i.last_cost) AS unit_cost,
            to_char(b.received_at AT TIME ZONE x.zone,'YYYY-MM-DD') AS received_on,
            COALESCE(used.quantity, 0) AS used_after_expiry,
            used.bills AS used_on_bills, used.last_at AS used_last_at
     FROM inventory_batches b
     JOIN inventory_batch_balances bb ON bb.batch_id = b.id
     JOIN inventory_items i ON i.id = b.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN outlets o ON o.id = bb.outlet_id
     CROSS JOIN LATERAL (
       SELECT COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1), 'Asia/Kolkata') AS zone
     ) z
     CROSS JOIN LATERAL (
       SELECT z.zone, b.expiry_date - (NOW() AT TIME ZONE z.zone)::date AS days_left, $5::int AS within
     ) x
     -- Taken by sales after the batch had expired, in the last week, on bills
     -- that still stand (a voided bill gave its stock back).
     LEFT JOIN LATERAL (
       SELECT SUM(-bm.quantity) AS quantity, MAX(st.created_at) AS last_at,
              ARRAY_AGG(DISTINCT st.notes ORDER BY st.notes) FILTER (WHERE st.notes IS NOT NULL) AS bills
       FROM inventory_batch_movements bm
       JOIN stock_transactions st ON st.id = bm.stock_transaction_id
       JOIN bills bl ON bl.id = st.reference_id AND bl.restaurant_id = st.restaurant_id AND bl.bill_status <> 'void'
       WHERE bm.batch_id = b.id AND bm.after_expiry AND st.reference_type = 'bill'
         AND st.outlet_id IS NOT DISTINCT FROM bb.outlet_id
         AND st.created_at >= NOW() - INTERVAL '7 days'
     ) used ON TRUE
     WHERE b.restaurant_id = $1
       AND (bb.quantity <> 0 OR COALESCE(used.quantity, 0) > 0)
       AND (NOT $3::boolean OR bb.outlet_id IS NOT DISTINCT FROM $2::bigint)
       AND NOT (b.inventory_item_id = ANY($4::bigint[]))
       AND ${SHOWS[show]}
     ORDER BY b.expiry_date ASC NULLS LAST, i.name, b.id`,
    [restaurantId, filters.storeId ?? null, Boolean(filters.storeOnly), filters.hiddenItemIds || [],
      Number.isInteger(filters.within) ? filters.within : 7]
  );
  return result.rows;
}

module.exports={allocate,findBatches,SHOWS};
