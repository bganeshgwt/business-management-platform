const service=require('../services/addonGroups.service');
const v=require('../../../../utils/validate');
const {logAction}=require('../../../../utils/audit');
exports.get=async(req,res)=>res.json({success:true,data:await service.get(req.user.restaurantId,v.requiredId(req.params.productId,'Product'))});
exports.save=async(req,res)=>{
  const id=v.requiredId(req.params.productId,'Product');
  const groups=await service.save(req.user.restaurantId,id,req.body?.groups,req.user.id);
  await logAction(req,'update','product',{id,details:{addonGroups:groups}});
  res.json({success:true,data:groups});
};
