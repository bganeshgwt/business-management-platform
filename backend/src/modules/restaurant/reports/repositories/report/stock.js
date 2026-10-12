// Stock consumption query.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { MOVED, MOVEMENT_AT_OUTLET, STOCK_USED, STOCK_WASTED, WASTE_UNDONE, scopeParams } = require("./sql");

const consumptionReport = async (scope) => {
  const result = await pool.query(
    `WITH moved AS (${MOVED})
     SELECT i.name AS item_name, u.short_name AS unit_short_name,
            COALESCE(SUM(-st.quantity) FILTER (WHERE ${STOCK_USED}), 0) AS consumed,
            COALESCE(SUM(-st.quantity) FILTER (WHERE ${STOCK_WASTED}), 0)
              - COALESCE(SUM(st.quantity) FILTER (WHERE ${WASTE_UNDONE}), 0) AS wasted,
            COALESCE(SUM(st.quantity) FILTER (WHERE st.transaction_type = 'purchase'), 0) AS purchased,
            COALESCE(SUM(st.quantity * st.unit_cost) FILTER (WHERE st.transaction_type = 'purchase'), 0)
              AS purchase_value,
            i.current_stock,
            i.last_cost
     FROM moved st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE st.business_date BETWEEN $2::date AND $3::date
       AND ${MOVEMENT_AT_OUTLET}
     GROUP BY i.id, u.short_name
     HAVING SUM(ABS(st.quantity)) > 0
     ORDER BY consumed DESC, i.name`,
    scopeParams(scope)
  );

  return result.rows;
};

module.exports = {
  consumptionReport,
};
