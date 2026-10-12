const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");

// Most specific context wins: outlet, then channel, then service type.
// Size prices retain their existing difference from the base dish price.
function selectRule(rules, productId, context = {}) {
  return rules.filter(r => Number(r.product_id) === Number(productId)
    && (!r.outlet_id || Number(r.outlet_id) === Number(context.outletId))
    && (!r.channel_id || Number(r.channel_id) === Number(context.channelId))
    && (!r.order_type || r.order_type === context.orderType))
    .sort((a,b) => score(b)-score(a) || Number(b.id)-Number(a.id))[0] || null;
}
const score = r => (r.outlet_id ? 4 : 0) + (r.channel_id ? 2 : 0) + (r.order_type ? 1 : 0);
const list = async (restaurantId, db = pool) =>
  (await db.query("SELECT * FROM product_selling_rules WHERE restaurant_id=$1", [restaurantId])).rows;

async function channel(restaurantId, id, db = pool) {
  if (!id) return null;
  const row = (await db.query("SELECT id,commission_percent FROM sales_channels WHERE restaurant_id=$1 AND id=$2 AND status='active'", [restaurantId,id])).rows[0];
  if (!row) throw new AppError(400,"Choose an active sales channel belonging to this restaurant");
  return row;
}

async function save(restaurantId, productId, input, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const product = (await client.query("SELECT id,price FROM products WHERE restaurant_id=$1 AND id=$2 FOR UPDATE",[restaurantId,productId])).rows[0];
    if(!product) throw new AppError(404,"Product not found");
    if(input.channelId) await channel(restaurantId,input.channelId,client);
    if(input.outletId && !(await client.query("SELECT 1 FROM outlets WHERE restaurant_id=$1 AND id=$2",[restaurantId,input.outletId])).rowCount) {
      throw new AppError(400,"Choose an outlet belonging to this restaurant");
    }
    if(input.price !== null) {
      const invalid=await client.query("SELECT name FROM product_variants WHERE product_id=$1 AND status='active' AND price_delta+$2 < 0 LIMIT 1",[productId,input.price]);
      if(invalid.rowCount) throw new AppError(400,`This price makes ${invalid.rows[0].name} cost less than zero`);
    }
    const row=(await client.query(`INSERT INTO product_selling_rules(restaurant_id,product_id,outlet_id,channel_id,order_type,price,is_available,updated_by,packaging_charge)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (product_id,outlet_id,channel_id,order_type) DO UPDATE SET packaging_charge=EXCLUDED.packaging_charge,price=EXCLUDED.price,is_available=EXCLUDED.is_available,updated_by=EXCLUDED.updated_by,updated_at=NOW()
      RETURNING *`,[restaurantId,productId,input.outletId,input.channelId,input.orderType,input.price,input.isAvailable,userId,input.packagingCharge??0])).rows[0];
    await client.query("COMMIT");return row;
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}

module.exports={list,selectRule,channel,save};
