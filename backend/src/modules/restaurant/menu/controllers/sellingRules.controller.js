const service = require("../services/sellingRules.service");
const pool = require("../../../../config/database");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { logAction } = require("../../../../utils/audit");
const optionalId=(x,name)=>x===null||x===undefined||x===""?null:v.requiredId(x,name);

const list = async (req,res)=> {
  const productId=v.requiredId(req.params.productId,"Product");
  const rules=(await service.list(req.user.restaurantId)).filter(r=>Number(r.product_id)===productId);
  res.json({success:true,data:rules});
};
const options=async(req,res)=>{
  const rid=req.user.restaurantId;
  const [outlets,channels]=await Promise.all([
    pool.query("SELECT id,name FROM outlets WHERE restaurant_id=$1 AND status='active' ORDER BY name",[rid]),
    pool.query("SELECT id,name FROM sales_channels WHERE restaurant_id=$1 AND status='active' ORDER BY name",[rid]),
  ]);
  res.json({success:true,data:{outlets:outlets.rows,channels:channels.rows}});
};
const save=async(req,res)=>{
  const b=req.body||{};
  const input={outletId:optionalId(b.outletId,"Outlet"),channelId:optionalId(b.channelId,"Channel"),
    orderType:v.optionalEnum(b.orderType,"Service type",['dine_in','takeaway','delivery','qr','online'],null),
    packagingCharge:v.optionalNumber(b.packagingCharge,"Packaging per item",{min:0,max:99999})??0,
    price:v.optionalNumber(b.price,"Price",{min:0,max:99999999}),isAvailable:v.requiredBoolean(b.isAvailable,"Available",true)};
  if(!input.outletId&&!input.channelId&&!input.orderType)throw new AppError(400,"Choose an outlet, channel or service type");
  const productId=v.requiredId(req.params.productId,"Product");
  const row=await service.save(req.user.restaurantId,productId,input,req.user.id);
  await logAction(req,"update","product_selling_rule",{id:row.id,details:{productId,...input}});
  res.json({success:true,data:row});
};
const remove=async(req,res)=>{
  const id=v.requiredId(req.params.id,"Rule");
  const deleted=await pool.query("DELETE FROM product_selling_rules WHERE restaurant_id=$1 AND id=$2 RETURNING product_id",[req.user.restaurantId,id]);
  if(!deleted.rowCount)throw new AppError(404,"Rule not found");
  await logAction(req,"delete","product_selling_rule",{id,details:{productId:deleted.rows[0].product_id}});
  res.json({success:true});
};
module.exports={list,options,save,remove};
