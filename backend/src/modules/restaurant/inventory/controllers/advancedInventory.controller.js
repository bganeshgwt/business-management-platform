const service=require("../services/advancedInventory.service");
const v=require("../../../../utils/validate");
const AppError=require('../../../../utils/AppError');
const {readDate}=require('../../../../utils/calendarDate');
const {logAction}=require('../../../../utils/audit');

const linesOf=(body)=>{
  const lines=v.requiredArray(body?.lines,'Recipe lines'),seen=new Set();
  if(lines.length>100)throw new AppError(400,'Use at most 100 ingredients');
  return lines.map(line=>{
    const inventoryItemId=v.requiredId(line?.inventoryItemId,'Ingredient');
    if(seen.has(inventoryItemId))throw new AppError(400,'Each ingredient can appear only once');
    seen.add(inventoryItemId);
    return {inventoryItemId,quantity:v.requiredNumber(line.quantity,'Quantity',{min:0.0001,max:9999999})};
  });
};
const getModifier=async(req,res)=>res.json({success:true,data:await service.modifierRecipe(req.user.restaurantId,v.requiredId(req.params.id,"Add-on"))});
const saveModifier=async(req,res)=>{
  const id=v.requiredId(req.params.id,'Add-on'),lines=linesOf(req.body);
  const data=await service.saveModifierRecipe(req.user.restaurantId,id,lines,req.user.id);
  logAction(req,'update','modifier_recipe',{id,details:{lines}});
  res.json({success:true,message:'Add-on recipe saved',data});
};
const getItem=async(req,res)=>res.json({success:true,data:await service.itemRecipe(req.user.restaurantId,v.requiredId(req.params.id,"Item"))});
const saveItem=async(req,res)=>{
  const id=v.requiredId(req.params.id,'Item'),lines=linesOf(req.body);
  const data=await service.saveItemRecipe(req.user.restaurantId,id,lines,req.user.id);
  logAction(req,'update','inventory_recipe',{id,details:{lines}});
  res.json({success:true,message:'Prepared-item recipe saved',data});
};
const produce=async(req,res)=>{
  const body=req.body||{},requestKey=v.optionalString(body.requestKey,'Request key',36);
  if(requestKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey))throw new AppError(400,'Invalid production request key');
  const data=await service.produce(req.user.restaurantId,{outputItemId:v.requiredId(body.outputItemId,'Prepared item'),
    quantity:v.requiredNumber(body.quantity,'Output quantity',{min:0.001,max:9999999}),batchNumber:v.requiredString(body.batchNumber,'Batch number',60),
    expiryDate:readDate(body.expiryDate,'Expiry date'),notes:v.optionalString(body.notes,'Notes',500),requestKey,outletId:req.outletId||null},req.user.id);
  if(!data.replayed)logAction(req,'create','production_batch',{id:data.id,label:body.batchNumber});
  res.status(201).json({success:true,message:data.replayed?'This batch was already posted':'Production batch posted',data});
};
const listProduction=async(req,res)=>{
  const from=readDate(req.query.from,'From'),to=readDate(req.query.to,'To');
  if(from&&to&&from>to)throw new AppError(400,'The start date is after the end date');
  const whole=(value)=>(value===null?null:Math.floor(value));
  const filters={from,to,
    page:whole(v.optionalNumber(req.query.page,'Page',{min:1,max:1000000})),
    pageSize:whole(v.optionalNumber(req.query.pageSize,'Rows per page',{min:1,max:200}))};
  res.json({success:true,data:await service.listProduction(req.user.restaurantId,req.outletId,filters)});
};
const voidProduction=async(req,res)=>{
  const id=v.requiredId(req.params.id,'Production batch'),reason=v.requiredString(req.body?.reason,'Reason',300);
  await service.voidProduction(req.user.restaurantId,id,req.outletId,reason,req.user.id);
  logAction(req,'void','production_batch',{id,details:{reason}});
  res.json({success:true,message:'Production reversed; ingredients restored'});
};
module.exports={getModifier,saveModifier,getItem,saveItem,produce,listProduction,voidProduction};
