const service = require('../services/menuServiceOptions.service');
const v = require('../../../../utils/validate');
const {logAction} = require('../../../../utils/audit');
exports.get = async (req,res) => res.json({success:true,data:await service.get(req.user.restaurantId,v.requiredId(req.params.productId,'Product'))});
exports.save = async (req,res) => {
  const id=v.requiredId(req.params.productId,'Product');
  const data=await service.save(req.user.restaurantId,id,req.body || {},req.user.id);
  logAction(req,'update','product',{id,details:{serviceOptions:data}});
  res.json({success:true,data,message:'Serving times and combo choices saved'});
};
