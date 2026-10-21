const repo=require('../src/modules/business/core/repositories/business.repository');

// Sample stories explicitly opt into their specialist tools. This cannot
// change a real business or another person's demonstration data.
const DEMO_TOOLS=['offers','loyalty','stock_transfers','repairs','finance','packages','commissions','lab','processing','tasks','issues','projects'];
// Team tools go on only in trades they are recommended for (a supermarket,
// pharmacy or clinic), as a real owner of that trade would set them.
const WORK_TOOLS=['tasks','issues','projects'];

// A tool is switched on only once every tool it needs is on (a salon has no
// inventory, so no stock transfers); rounds repeat until nothing more can go on.
async function enableDemoTools(userId,businessIds) {
  if(!businessIds.length)return;
  for(;;){
    const {rowCount}=await repo.pool.query(`INSERT INTO business_capabilities(business_id,capability,enabled_by)
      SELECT b.id,t.module_code,$1 FROM businesses b JOIN platform_module_business_types t ON t.business_type=b.business_type
      WHERE b.id=ANY($2::bigint[]) AND b.is_demo AND b.created_by=$1 AND t.module_code=ANY($3::text[])
        AND (t.module_code<>ALL($4::text[]) OR EXISTS (SELECT 1 FROM platform_module_business_types r
          WHERE r.business_type=b.business_type AND r.module_code='tasks' AND r.recommended))
        AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id=b.id AND c.capability=t.module_code)
        AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code=t.module_code
          AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id=b.id AND c.capability=d.requires_module_code))
      ORDER BY b.id,t.module_code ON CONFLICT DO NOTHING`,[userId,businessIds,DEMO_TOOLS,WORK_TOOLS]);
    if(!rowCount)return;
  }
}
module.exports={enableDemoTools,DEMO_TOOLS,WORK_TOOLS};
