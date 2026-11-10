-- Up Migration
-- Indexes where PostgreSQL would otherwise read a whole table.
--
-- A customer's bills and payments: the contacts list sums each customer's
-- bills, and a statement, the payables and a KYC check read them; until now
-- each read every bill of the business.
CREATE INDEX business_documents_contact ON business_documents (business_id, contact_id, created_at) WHERE contact_id IS NOT NULL;

-- Deleting a row (or merging a guest) makes PostgreSQL look for the rows that
-- point at it, in each table that links to it. Without an index on the link
-- that look is a read of the whole table, under the delete's lock. These are
-- the links to rows the app really deletes or merges, in tables that grow
-- every day. Links into small set-up tables (opening hours, recipes, price
-- lists, discount limits) are read whole in a moment and stay as they are,
-- as do links narrowed to one booking or shift by an index already. A nullable
-- link is indexed where it is set only.

-- A product, a dish or its price window deleted from the menu.
CREATE INDEX idx_kot_items_product_id ON kot_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_order_items_price_window_id ON order_items (price_window_id) WHERE price_window_id IS NOT NULL;
CREATE INDEX idx_order_item_cancellations_product_id ON order_item_cancellations (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_dish_waste_entries_product_id ON dish_waste_entries (product_id);
CREATE INDEX idx_dish_waste_entries_product_variant_id ON dish_waste_entries (product_variant_id) WHERE product_variant_id IS NOT NULL;
CREATE INDEX idx_restaurant_preorder_items_product_id ON restaurant_preorder_items (product_id);
CREATE INDEX idx_restaurant_preorder_items_product_variant_id ON restaurant_preorder_items (product_variant_id) WHERE product_variant_id IS NOT NULL;

-- A stock item or its pack deleted, a purchase order (or its line) changed or deleted.
CREATE INDEX idx_inventory_batches_inventory_item_id ON inventory_batches (inventory_item_id);
CREATE INDEX idx_production_batches_output_item_id ON production_batches (output_item_id);
CREATE INDEX idx_purchase_return_items_inventory_item_id ON purchase_return_items (inventory_item_id);
CREATE INDEX idx_stock_indent_lines_inventory_item_id ON stock_indent_lines (inventory_item_id);
CREATE INDEX idx_goods_receipt_items_pack_id ON goods_receipt_items (pack_id) WHERE pack_id IS NOT NULL;
CREATE INDEX idx_purchase_order_items_pack_id ON purchase_order_items (pack_id) WHERE pack_id IS NOT NULL;
CREATE INDEX idx_goods_receipt_items_purchase_order_item_id ON goods_receipt_items (purchase_order_item_id) WHERE purchase_order_item_id IS NOT NULL;
CREATE INDEX idx_supplier_payments_purchase_order_id ON supplier_payments (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

-- An expense or a supplier deleted.
CREATE INDEX idx_cash_movements_expense_id ON cash_movements (expense_id) WHERE expense_id IS NOT NULL;
CREATE INDEX idx_expenses_supplier_id ON expenses (supplier_id) WHERE supplier_id IS NOT NULL;

-- A shift, a leave type, an employee or a role deleted.
CREATE INDEX idx_attendance_shift_id ON attendance (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX idx_attendance_leave_type_id ON attendance (leave_type_id) WHERE leave_type_id IS NOT NULL;
CREATE INDEX idx_shift_assignments_shift_id ON shift_assignments (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX idx_shift_assignments_leave_type_id ON shift_assignments (leave_type_id) WHERE leave_type_id IS NOT NULL;
CREATE INDEX idx_attendance_punch_photos_employee_id ON attendance_punch_photos (employee_id);
CREATE INDEX idx_tip_shareout_payments_employee_id ON tip_shareout_payments (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX idx_rider_settlements_rider_employee_id ON rider_settlements (rider_employee_id);
CREATE INDEX idx_business_task_assignees_employee_id ON business_task_assignees (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX idx_business_task_assignees_role_id ON business_task_assignees (role_id) WHERE role_id IS NOT NULL;

-- A table, an area or a floor deleted from the floor plan.
CREATE INDEX idx_order_moves_from_table_id ON order_moves (from_table_id) WHERE from_table_id IS NOT NULL;
CREATE INDEX idx_order_moves_to_table_id ON order_moves (to_table_id) WHERE to_table_id IS NOT NULL;
CREATE INDEX idx_captain_assignments_table_id ON captain_assignments (table_id) WHERE table_id IS NOT NULL;
CREATE INDEX idx_captain_assignments_area_id ON captain_assignments (area_id) WHERE area_id IS NOT NULL;
CREATE INDEX idx_captain_assignments_floor_id ON captain_assignments (floor_id) WHERE floor_id IS NOT NULL;
CREATE INDEX idx_logbook_entries_table_id ON logbook_entries (table_id) WHERE table_id IS NOT NULL;
CREATE INDEX idx_waitlist_entries_table_id ON waitlist_entries (table_id) WHERE table_id IS NOT NULL;

-- A guest merged into another or erased (each of their records is moved or checked first).
CREATE INDEX idx_orders_customer_id_fk ON orders (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_bills_account_customer_id ON bills (account_customer_id) WHERE account_customer_id IS NOT NULL;
CREATE INDEX idx_bills_discount_id_fk ON bills (discount_id) WHERE discount_id IS NOT NULL;
CREATE INDEX idx_complaints_customer_id ON complaints (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_feedback_customer_id ON feedback (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_reservations_customer_id ON reservations (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_restaurant_preorders_customer_id ON restaurant_preorders (customer_id);
CREATE INDEX idx_waitlist_entries_customer_id ON waitlist_entries (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_customer_advances_customer_id ON customer_advances (customer_id);

-- An outlet deleted (only one with no history): the largest tables pointing at it.
CREATE INDEX idx_orders_outlet_id ON orders (outlet_id) WHERE outlet_id IS NOT NULL;
CREATE INDEX idx_bills_outlet_id ON bills (outlet_id) WHERE outlet_id IS NOT NULL;
CREATE INDEX idx_kots_outlet_id ON kots (outlet_id) WHERE outlet_id IS NOT NULL;
CREATE INDEX idx_stock_transactions_outlet_id ON stock_transactions (outlet_id) WHERE outlet_id IS NOT NULL;
CREATE INDEX idx_cash_movements_outlet_id ON cash_movements (outlet_id) WHERE outlet_id IS NOT NULL;

-- A task, task item, issue, list or milestone deleted; a quotation, job card or shop order line changed.
CREATE INDEX business_tasks_issue_id ON business_tasks (business_id, issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX business_tasks_project_list_id ON business_tasks (business_id, project_list_id) WHERE project_list_id IS NOT NULL;
CREATE INDEX business_tasks_milestone_id ON business_tasks (business_id, milestone_id) WHERE milestone_id IS NOT NULL;
CREATE INDEX business_task_items_issue_id ON business_task_items (business_id, issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX business_issues_source_task_id ON business_issues (business_id, source_task_id) WHERE source_task_id IS NOT NULL;
CREATE INDEX business_issues_source_task_item_id ON business_issues (business_id, source_task_item_id) WHERE source_task_item_id IS NOT NULL;
CREATE INDEX business_task_files_item_id ON business_task_files (business_id, item_id) WHERE item_id IS NOT NULL;
CREATE INDEX business_quotation_billed_line_id ON business_quotation_billed (business_id, line_id);
CREATE INDEX garage_job_card_photos_inspection_item_id ON garage_job_card_photos (business_id, inspection_item_id) WHERE inspection_item_id IS NOT NULL;
CREATE INDEX garage_part_issues_line_id ON garage_part_issues (business_id, line_id);
CREATE INDEX shop_order_lines_replaces_line_id ON shop_order_lines (business_id, replaces_line_id) WHERE replaces_line_id IS NOT NULL;

-- Down Migration
DROP INDEX shop_order_lines_replaces_line_id;
DROP INDEX garage_part_issues_line_id;
DROP INDEX garage_job_card_photos_inspection_item_id;
DROP INDEX business_quotation_billed_line_id;
DROP INDEX business_task_files_item_id;
DROP INDEX business_issues_source_task_item_id;
DROP INDEX business_issues_source_task_id;
DROP INDEX business_task_items_issue_id;
DROP INDEX business_tasks_milestone_id;
DROP INDEX business_tasks_project_list_id;
DROP INDEX business_tasks_issue_id;
DROP INDEX idx_cash_movements_outlet_id;
DROP INDEX idx_stock_transactions_outlet_id;
DROP INDEX idx_kots_outlet_id;
DROP INDEX idx_bills_outlet_id;
DROP INDEX idx_orders_outlet_id;
DROP INDEX idx_customer_advances_customer_id;
DROP INDEX idx_waitlist_entries_customer_id;
DROP INDEX idx_restaurant_preorders_customer_id;
DROP INDEX idx_reservations_customer_id;
DROP INDEX idx_feedback_customer_id;
DROP INDEX idx_complaints_customer_id;
DROP INDEX idx_bills_discount_id_fk;
DROP INDEX idx_bills_account_customer_id;
DROP INDEX idx_orders_customer_id_fk;
DROP INDEX idx_waitlist_entries_table_id;
DROP INDEX idx_logbook_entries_table_id;
DROP INDEX idx_captain_assignments_floor_id;
DROP INDEX idx_captain_assignments_area_id;
DROP INDEX idx_captain_assignments_table_id;
DROP INDEX idx_order_moves_to_table_id;
DROP INDEX idx_order_moves_from_table_id;
DROP INDEX idx_business_task_assignees_role_id;
DROP INDEX idx_business_task_assignees_employee_id;
DROP INDEX idx_rider_settlements_rider_employee_id;
DROP INDEX idx_tip_shareout_payments_employee_id;
DROP INDEX idx_attendance_punch_photos_employee_id;
DROP INDEX idx_shift_assignments_leave_type_id;
DROP INDEX idx_shift_assignments_shift_id;
DROP INDEX idx_attendance_leave_type_id;
DROP INDEX idx_attendance_shift_id;
DROP INDEX idx_expenses_supplier_id;
DROP INDEX idx_cash_movements_expense_id;
DROP INDEX idx_supplier_payments_purchase_order_id;
DROP INDEX idx_goods_receipt_items_purchase_order_item_id;
DROP INDEX idx_purchase_order_items_pack_id;
DROP INDEX idx_goods_receipt_items_pack_id;
DROP INDEX idx_stock_indent_lines_inventory_item_id;
DROP INDEX idx_purchase_return_items_inventory_item_id;
DROP INDEX idx_production_batches_output_item_id;
DROP INDEX idx_inventory_batches_inventory_item_id;
DROP INDEX idx_restaurant_preorder_items_product_variant_id;
DROP INDEX idx_restaurant_preorder_items_product_id;
DROP INDEX idx_dish_waste_entries_product_variant_id;
DROP INDEX idx_dish_waste_entries_product_id;
DROP INDEX idx_order_item_cancellations_product_id;
DROP INDEX idx_order_items_price_window_id;
DROP INDEX idx_kot_items_product_id;
DROP INDEX business_documents_contact;
