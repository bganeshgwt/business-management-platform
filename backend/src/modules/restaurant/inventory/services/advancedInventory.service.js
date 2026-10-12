const pool = require("../../../../config/database");
const inventoryRepository = require("../repositories/inventory.repository");
const AppError = require("../../../../utils/AppError");

const ownItem = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT i.id, i.name, i.status, i.item_type, i.current_stock, i.average_cost, i.last_cost,
            u.short_name AS unit_short_name
     FROM inventory_items i JOIN units u ON u.id = i.unit_id
     WHERE i.restaurant_id = $1 AND i.id = $2`, [restaurantId, id]
  );
  return result.rows[0] || null;
};

const modifierRecipe = async (restaurantId, modifierId) => {
  const modifier = await pool.query("SELECT id, name FROM modifiers WHERE restaurant_id=$1 AND id=$2", [restaurantId, modifierId]);
  if (!modifier.rows[0]) throw new AppError(404, "Add-on not found");
  const lines = await pool.query(
    `SELECT r.id, r.inventory_item_id, r.quantity, i.name, i.average_cost, i.last_cost, u.short_name
     FROM modifier_recipes r JOIN inventory_items i ON i.id=r.inventory_item_id JOIN units u ON u.id=i.unit_id
     WHERE r.restaurant_id=$1 AND r.modifier_id=$2 ORDER BY i.name`, [restaurantId, modifierId]
  );
  return { modifier: modifier.rows[0], lines: lines.rows.map(row => ({ id: row.id, inventoryItemId: row.inventory_item_id, itemName: row.name, quantity: Number(row.quantity), unitShortName: row.short_name, lineCost: Number(row.quantity) * Number(row.average_cost ?? row.last_cost ?? 0) })) };
};

const saveModifierRecipe = async (restaurantId, modifierId, lines, userId) => {
  await modifierRecipe(restaurantId, modifierId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('SELECT id FROM modifiers WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[restaurantId,modifierId]);
    await client.query("DELETE FROM modifier_recipes WHERE restaurant_id=$1 AND modifier_id=$2", [restaurantId, modifierId]);
    for (const line of lines) {
      if (!(await ownItem(restaurantId, line.inventoryItemId, client))) throw new AppError(400, "One ingredient does not belong to this restaurant");
      await client.query(`INSERT INTO modifier_recipes (restaurant_id,modifier_id,inventory_item_id,quantity,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5)`, [restaurantId, modifierId, line.inventoryItemId, line.quantity, userId]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return modifierRecipe(restaurantId, modifierId);
};

const itemRecipe = async (restaurantId, itemId) => {
  const item = await ownItem(restaurantId, itemId);
  if (!item) throw new AppError(404, "Inventory item not found");
  const lines = await pool.query(
    `SELECT r.id,r.ingredient_item_id,r.quantity,i.name,i.item_type,i.average_cost,i.last_cost,u.short_name
     FROM inventory_recipes r JOIN inventory_items i ON i.id=r.ingredient_item_id JOIN units u ON u.id=i.unit_id
     WHERE r.restaurant_id=$1 AND r.output_item_id=$2 ORDER BY i.name`, [restaurantId, itemId]
  );
  return { item: { id:item.id,name:item.name,itemType:item.item_type,unitShortName:item.unit_short_name }, lines: lines.rows.map(row => ({ id:row.id,inventoryItemId:row.ingredient_item_id,itemName:row.name,itemType:row.item_type,quantity:Number(row.quantity),unitShortName:row.short_name,lineCost:Number(row.quantity)*Number(row.average_cost??row.last_cost??0) })) };
};

const saveItemRecipe = async (restaurantId, itemId, lines, userId) => {
  const output = await ownItem(restaurantId, itemId);
  if (!output) throw new AppError(404, "Inventory item not found");
  if (output.item_type !== "prepared") throw new AppError(400, "Mark this item as Prepared before giving it a recipe");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('SELECT pg_advisory_xact_lock(915003,$1::int)',[restaurantId]);
    await client.query("DELETE FROM inventory_recipes WHERE restaurant_id=$1 AND output_item_id=$2", [restaurantId,itemId]);
    for (const line of lines) {
      if (Number(line.inventoryItemId) === Number(itemId)) throw new AppError(400, "A prepared item cannot contain itself");
      if (!(await ownItem(restaurantId,line.inventoryItemId,client))) throw new AppError(400,"One ingredient does not belong to this restaurant");
      const cycle = await client.query(`WITH RECURSIVE parts(id) AS (SELECT ingredient_item_id FROM inventory_recipes WHERE output_item_id=$1 UNION SELECT r.ingredient_item_id FROM inventory_recipes r JOIN parts p ON p.id=r.output_item_id) SELECT 1 FROM parts WHERE id=$2 LIMIT 1`, [line.inventoryItemId,itemId]);
      if (cycle.rowCount) throw new AppError(400,"That recipe would create a circular sub-recipe");
      await client.query(`INSERT INTO inventory_recipes (restaurant_id,output_item_id,ingredient_item_id,quantity,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5)`,[restaurantId,itemId,line.inventoryItemId,line.quantity,userId]);
    }
    await client.query("COMMIT");
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
  return itemRecipe(restaurantId,itemId);
};

const produce = async (restaurantId, data, userId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('SELECT pg_advisory_xact_lock(915003,$1::int)',[restaurantId]);
    if(data.requestKey) {
      const previous=(await client.query("SELECT *,to_char(expiry_date,'YYYY-MM-DD') AS expiry_text FROM production_batches WHERE restaurant_id=$1 AND request_key=$2",[restaurantId,data.requestKey])).rows[0];
      if(previous) {
        if(Number(previous.output_item_id)!==Number(data.outputItemId) || Number(previous.outlet_id||0)!==Number(data.outletId||0)
          || Number(previous.produced_quantity)!==data.quantity || previous.batch_number!==data.batchNumber
          || (previous.expiry_text||null)!==(data.expiryDate||null) || (previous.notes||null)!==(data.notes||null)) {
          throw new AppError(409,'This request was already used for a different production batch. Refresh before posting.');
        }
        if(previous.batch_status==='void') throw new AppError(409,'This production request was already posted and voided');
        await client.query('COMMIT'); return {id:previous.id,replayed:true,totalCost:Number(previous.total_cost),unitCost:Number(previous.unit_cost)};
      }
    }
    const output = await ownItem(restaurantId,data.outputItemId,client);
    if (!output || output.item_type !== "prepared" || output.status !== 'active') throw new AppError(400,"Choose an active prepared inventory item");
    const ingredientIds=(await client.query('SELECT ingredient_item_id FROM inventory_recipes WHERE restaurant_id=$1 AND output_item_id=$2',[restaurantId,data.outputItemId])).rows.map(row=>row.ingredient_item_id);
    await client.query('SELECT id FROM inventory_items WHERE restaurant_id=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE',[restaurantId,[data.outputItemId,...ingredientIds]]);
    const today=(await client.query("SELECT (NOW() AT TIME ZONE COALESCE(timezone,'Asia/Kolkata'))::date::text AS date FROM restaurant_settings WHERE restaurant_id=$1",[restaurantId])).rows[0].date;
    if(data.expiryDate && data.expiryDate<today) throw new AppError(400,'A new production batch cannot already be expired');
    const recipe = await client.query(`SELECT r.ingredient_item_id,r.quantity,i.name,i.average_cost,i.last_cost FROM inventory_recipes r JOIN inventory_items i ON i.id=r.ingredient_item_id WHERE r.restaurant_id=$1 AND r.output_item_id=$2`,[restaurantId,data.outputItemId]);
    if (!recipe.rowCount) throw new AppError(400,"Add the prepared item's recipe first");
    const totalCost = recipe.rows.reduce((sum,row)=>sum+Number(row.quantity)*data.quantity*Number(row.average_cost??row.last_cost??0),0);
    if(!Number.isFinite(totalCost) || totalCost>99999999) throw new AppError(400,'This production value is too large; check the quantity and recipe');
    if(recipe.rows.some(row=>row.average_cost==null && row.last_cost==null)) throw new AppError(400,'Set ingredient purchase costs before posting production');
    const batch = await client.query(`INSERT INTO production_batches (restaurant_id,outlet_id,output_item_id,batch_number,produced_quantity,total_cost,unit_cost,expiry_date,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[restaurantId,data.outletId||null,data.outputItemId,data.batchNumber,data.quantity,totalCost,totalCost/data.quantity,data.expiryDate||null,data.notes||null,userId]);
    if(data.requestKey) await client.query('UPDATE production_batches SET request_key=$2 WHERE id=$1',[batch.rows[0].id,data.requestKey]);
    for(const line of recipe.rows) await inventoryRepository.recordMovement(client,restaurantId,{inventoryItemId:line.ingredient_item_id,outletId:data.outletId||null,transactionType:"consumption",quantity:-(Number(line.quantity)*data.quantity),reason:`Production: ${output.name}`,referenceType:"production",referenceId:batch.rows[0].id},userId);
    await inventoryRepository.recordMovement(client,restaurantId,{inventoryItemId:data.outputItemId,outletId:data.outletId||null,transactionType:"adjustment",quantity:data.quantity,unitCost:totalCost/data.quantity,batchNumber:data.batchNumber,expiryDate:data.expiryDate||null,reason:"Production output",referenceType:"production",referenceId:batch.rows[0].id},userId);
    await client.query("COMMIT");
    return { id:batch.rows[0].id,batchNumber:data.batchNumber,itemName:output.name,quantity:data.quantity,totalCost,unitCost:totalCost/data.quantity };
  } catch(error){await client.query("ROLLBACK"); if(error.code==="NEGATIVE_STOCK") throw new AppError(409,"Not enough ingredient stock for this production batch"); if(error.code==='23505') throw new AppError(409,'This batch number has already been posted for this item'); throw error;} finally{client.release();}
};

const toBatch=row=>({id:row.id,batchNumber:row.batch_number,status:row.batch_status,voidReason:row.void_reason,itemName:row.item_name,quantity:Number(row.produced_quantity),unitShortName:row.unit_short_name,totalCost:Number(row.total_cost),unitCost:Number(row.unit_cost),producedAt:row.produced_at,expiryDate:row.expiry_date,notes:row.notes,outletName:row.outlet_name});

// Production batches, newest first. Without `page` it is the latest 200 as a
// plain list (what older screens read). With `page` (and usually from/to, the
// days in the restaurant's own time zone) it is one page of the batches in
// those days: { items, total, page, pageSize, totalCost }.
const listProduction = async (restaurantId, outletId, filters = {}) => {
  const paged = Boolean(filters.page);
  const pageSize = paged ? filters.pageSize || 25 : 200;
  const offset = paged ? (filters.page - 1) * pageSize : 0;
  const zone = `COALESCE((SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1), 'Asia/Kolkata')`;
  const rows = (await pool.query(`SELECT b.id,b.batch_number,b.batch_status,b.void_reason,b.produced_quantity,b.total_cost,b.unit_cost,b.produced_at,
      to_char(b.expiry_date,'YYYY-MM-DD') AS expiry_date,b.notes,i.name AS item_name,u.short_name AS unit_short_name,o.name AS outlet_name,
      COUNT(*) OVER ()::int AS total_count,
      COALESCE(SUM(b.total_cost) FILTER (WHERE b.batch_status <> 'void') OVER (), 0) AS all_cost
    FROM production_batches b JOIN inventory_items i ON i.id=b.output_item_id JOIN units u ON u.id=i.unit_id LEFT JOIN outlets o ON o.id=b.outlet_id
    WHERE b.restaurant_id=$1 AND ($2::bigint IS NULL OR b.outlet_id=$2)
      AND ($3::date IS NULL OR b.produced_at >= ($3::date::timestamp AT TIME ZONE ${zone}))
      AND ($4::date IS NULL OR b.produced_at < (($4::date + 1)::timestamp AT TIME ZONE ${zone}))
    ORDER BY b.produced_at DESC, b.id DESC LIMIT $5 OFFSET $6`,
    [restaurantId,outletId || null,filters.from || null,filters.to || null,pageSize,offset])).rows;
  if(!paged) return rows.map(toBatch);
  let total=rows[0]?.total_count ?? 0,totalCost=rows[0] ? Number(rows[0].all_cost) : 0;
  if(!rows.length && offset>0){
    const first=await listProduction(restaurantId,outletId,{...filters,page:1,pageSize:1});
    total=first.total;totalCost=first.totalCost;
  }
  return {items:rows.map(toBatch),total,page:filters.page,pageSize,totalCost:Math.round(totalCost*100)/100};
};

const voidProduction = async (restaurantId,id,outletId,reason,userId) => {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(915003,$1::int)',[restaurantId]);
    const batch=(await db.query(`SELECT * FROM production_batches WHERE restaurant_id=$1 AND id=$2
      AND ($3::bigint IS NULL OR outlet_id=$3) FOR UPDATE`,[restaurantId,id,outletId || null])).rows[0];
    if(!batch) throw new AppError(404,'Production batch not found');
    if(batch.batch_status==='void') throw new AppError(409,'This production batch is already void');
    const movements=(await db.query(`SELECT * FROM stock_transactions WHERE restaurant_id=$1
      AND reference_type='production' AND reference_id=$2 ORDER BY inventory_item_id`,[restaurantId,id])).rows;
    await db.query('SELECT id FROM inventory_items WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[movements.map(m=>m.inventory_item_id)]);
    const output=movements.find(m=>Number(m.quantity)>0);
    const allocated=(await db.query(`SELECT bm.batch_id,bm.quantity,bb.quantity AS remaining FROM inventory_batch_movements bm
      JOIN inventory_batch_balances bb ON bb.batch_id=bm.batch_id AND bb.outlet_id IS NOT DISTINCT FROM $2
      WHERE bm.stock_transaction_id=$1`,[output.id,output.outlet_id])).rows;
    if(!allocated.length || allocated.some(row=>Number(row.remaining)<Number(row.quantity))) {
      throw new AppError(409,'This prepared batch has already been used or moved. Record an explained stock adjustment instead.');
    }
    for(const movement of movements) await inventoryRepository.recordMovement(db,restaurantId,{
      inventoryItemId:movement.inventory_item_id,outletId:movement.outlet_id,
      transactionType:'adjustment',quantity:-Number(movement.quantity),
      unitCost:movement.unit_cost,keepLastCost:true,revalue:true,reason:`Production void: ${reason}`,
      referenceType:'production_void',referenceId:id,notes:batch.batch_number,
    },userId);
    await db.query(`UPDATE production_batches SET batch_status='void',void_reason=$3,voided_at=NOW(),voided_by=$4
      WHERE restaurant_id=$1 AND id=$2`,[restaurantId,id,reason,userId]);
    await db.query('COMMIT');
  } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
};

module.exports={modifierRecipe,saveModifierRecipe,itemRecipe,saveItemRecipe,produce,listProduction,voidProduction};
