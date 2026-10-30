const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const h = require('./healthCommon');

// The lab's departments (lab_departments): the eight every lab has, made with
// the clinic (haematology, biochemistry, microbiology, serology / immunology,
// clinical pathology, histopathology, imaging, other), and those the lab
// adds. Each test and profile is in one (Tests & panels); the worklists are
// gathered by them. Staff tied to a department (a lab technician) find their
// departments first on the worklist: a preference, not an access rule.
// A department is renamed or switched off, never deleted; Other stays on.

const { fail, id } = h;
const requireLab = (business) => {
  h.requireType(business, ['healthcare'], 'Lab screens');
  if (!business.modules.includes('lab')) fail('Laboratory is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
};

const LIST = `SELECT d.id,d.code,d.name,d.active,d.sort_order,
    (SELECT count(*)::int FROM lab_tests t WHERE t.business_id=d.business_id AND t.department_id=d.id AND t.active) AS tests,
    COALESCE((SELECT json_agg(json_build_object('user_id',s.user_id,'name',u.name) ORDER BY u.name) FROM lab_department_staff s JOIN users u ON u.id=s.user_id
      WHERE s.business_id=d.business_id AND s.department_id=d.id),'[]') AS staff
  FROM lab_departments d WHERE d.business_id=$1`;

// The departments of the signed-in person (their worklist's first).
const mineOf = async (db, business) => (await repo.all(db, 'SELECT department_id FROM lab_department_staff WHERE business_id=$1 AND user_id=$2',
  [business.id, business.member_user_id])).map((row) => row.department_id);

// Every department, the switched-off last, with its tests in use and its
// staff; the person's own (mine); for those who keep them, the staff who may
// be tied to one (members whose role sees the lab).
async function list(business) {
  requireLab(business);
  await access.require(business, 'lab.view');
  const [departments, mine] = await Promise.all([
    repo.all(repo.pool, `${LIST} ORDER BY d.active DESC,d.sort_order,lower(d.name)`, [business.id]),
    mineOf(repo.pool, business),
  ]);
  const people = access.can(business, 'lab.edit') ? await repo.all(repo.pool, `SELECT u.id AS user_id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.role_id=r.id AND p.permission_code='lab.view'))
    ORDER BY u.name`, [business.id]) : [];
  return { departments, mine, people };
}

const nameOf = (body) => v.requiredString(typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : body.name, 'Department name', 80);
async function nameFree(db, business, name, except = null) {
  const taken = await repo.one(db, 'SELECT id FROM lab_departments WHERE business_id=$1 AND lower(name)=lower($2) AND ($3::bigint IS NULL OR id<>$3)', [business.id, name, except]);
  if (taken) fail(`There is a department called ${name} already`, 409);
}

// staff: the user ids tied to the department, all of them (replacing those before).
async function readStaff(db, business, value) {
  if (value === undefined) return null;
  const ids = [...new Set(v.requiredArray(value, 'Staff').map((u) => id(u, 'Staff member')))];
  if (ids.length > 100) fail('At most 100 people in a department');
  const found = await repo.all(db, 'SELECT user_id FROM business_memberships WHERE business_id=$1 AND user_id=ANY($2::bigint[]) AND active', [business.id, ids]);
  if (found.length !== ids.length) fail('That person is not on this clinic\'s staff', 404);
  return ids;
}
async function saveStaff(db, business, user, departmentId, ids) {
  await db.query('DELETE FROM lab_department_staff WHERE business_id=$1 AND department_id=$2 AND NOT (user_id=ANY($3::bigint[]))', [business.id, departmentId, ids]);
  for (const userId of ids) {
    await db.query('INSERT INTO lab_department_staff(business_id,department_id,user_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [business.id, departmentId, userId, user.id]);
  }
}

// body: { name, staff? }
async function create(business, user, body) {
  requireLab(business);
  await access.require(business, 'lab.edit');
  const name = nameOf(body);
  return repo.transaction(async (db) => {
    await nameFree(db, business, name);
    const staff = await readStaff(db, business, body.staff);
    const row = await repo.one(db, 'INSERT INTO lab_departments(business_id,name,sort_order,created_by) VALUES($1,$2,100,$3) RETURNING *', [business.id, name, user.id]);
    if (staff) await saveStaff(db, business, user, row.id, staff);
    await repo.audit(db, business.id, user.id, 'lab.department_created', row.id, { name, staff: staff?.length || 0 });
    return repo.one(db, `${LIST} AND d.id=$2`, [business.id, row.id]);
  });
}

// body: { name?, active?, staff? }. Other stays on; a department with tests
// in use is switched off once they are moved.
async function update(business, user, departmentId, body) {
  requireLab(business);
  await access.require(business, 'lab.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM lab_departments WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(departmentId, 'Department')]);
    if (!current) fail('Department not found', 404);
    const name = body.name === undefined ? current.name : nameOf(body);
    if (name.toLowerCase() !== current.name.toLowerCase()) await nameFree(db, business, name, current.id);
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    if (!active && current.code === 'other') fail('Other stays on: a test without a department of its own is in it', 409);
    if (!active && current.active) {
      const used = await repo.one(db, 'SELECT count(*)::int AS n FROM lab_tests WHERE business_id=$1 AND department_id=$2 AND active', [business.id, current.id]);
      if (used.n) fail(`Move the ${used.n} test${used.n === 1 ? '' : 's'} in ${current.name} to another department first (Tests & panels)`, 409);
    }
    const staff = await readStaff(db, business, body.staff);
    await db.query('UPDATE lab_departments SET name=$3,active=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, current.id, name, active]);
    if (staff) await saveStaff(db, business, user, current.id, staff);
    await repo.audit(db, business.id, user.id, active === current.active ? 'lab.department_updated' : active ? 'lab.department_switched_on' : 'lab.department_switched_off',
      current.id, { name, ...(name !== current.name ? { was: current.name } : {}), ...(staff ? { staff: staff.length } : {}) });
    return repo.one(db, `${LIST} AND d.id=$2`, [business.id, current.id]);
  });
}

// A test's department: one of this lab's, switched on (or the one it is in already).
async function readDepartment(db, business, value, current = null) {
  if (value === undefined || value === null || value === '') return current;
  const departmentId = id(value, 'Department');
  const row = await repo.one(db, 'SELECT id,active,name FROM lab_departments WHERE business_id=$1 AND id=$2', [business.id, departmentId]);
  if (!row) fail('Department not found', 404);
  if (!row.active && String(row.id) !== String(current)) fail(`${row.name} is switched off: choose another department`, 409);
  return row.id;
}

module.exports = { list, create, update, mineOf, readDepartment };
