// Local backup plus optional restore rehearsal in a newly created database.
// Usage: npm run db:backup -- --verify
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const config = require("../src/config/env");

function executable(name) {
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, name + (process.platform === "win32" ? ".exe" : ""));
  if (process.platform === "win32") {
    const root = path.join(process.env.ProgramFiles || "C:\\Program Files", "PostgreSQL");
    if (fs.existsSync(root)) {
      const versions = fs.readdirSync(root).filter(v => /^\d+$/.test(v)).sort((a,b) => Number(b)-Number(a));
      for (const version of versions) {
        const file = path.join(root,version,"bin",name+".exe");
        if (fs.existsSync(file)) return file;
      }
    }
  }
  return name;
}

function run(name, args) {
  const result = spawnSync(executable(name), args, { encoding: "utf8", windowsHide: true,
    env: { ...process.env, PGPASSWORD: config.db.password }, timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message || result.stderr}`);
}

async function main() {
  const folder = path.resolve(__dirname,"../.local/backups",new Date().toISOString().replace(/[:.]/g,"-")+"-"+crypto.randomBytes(3).toString("hex"));
  fs.mkdirSync(folder,{recursive:true});
  const archive = path.join(folder,"database.dump");
  const connection = ["--host",config.db.host,"--port",String(config.db.port),"--username",config.db.user,"--no-password"];
  run("pg_dump",[...connection,"--format=custom","--file",archive,"--dbname",config.db.database]);
  // Public uploads (logos, menu photos) and private ones (bills attached to
  // expenses and purchase bills, served only through the API) both belong to
  // the data: a restore without them would lose every attached bill.
  const uploads = path.resolve(__dirname,"../uploads");
  if (fs.existsSync(uploads)) fs.cpSync(uploads,path.join(folder,"uploads"),{recursive:true});
  const privateUploads = path.resolve(__dirname,"../private_uploads");
  if (fs.existsSync(privateUploads)) fs.cpSync(privateUploads,path.join(folder,"private_uploads"),{recursive:true});
  const manifest = { database:config.db.database,createdAt:new Date().toISOString(),uploadsIncluded:fs.existsSync(uploads),privateUploadsIncluded:fs.existsSync(privateUploads),restoreVerified:false };
  fs.writeFileSync(path.join(folder,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  if (process.argv.includes("--verify")) {
    const database = `rmp_restore_${crypto.randomBytes(10).toString("hex")}`;
    const admin = new Client({...config.db,database:"postgres"});
    let created=false, restored;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      created=true;
      run("pg_restore",[...connection,"--no-owner","--no-privileges","--exit-on-error","--dbname",database,archive]);
      restored = new Client({...config.db,database});
      await restored.connect();
      const {rows}=await restored.query("SELECT (SELECT count(*) FROM pgmigrations) AS migrations,(SELECT count(*) FROM users) AS users,(SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM bills) AS bills");
      manifest.restoreVerified=true;
      manifest.restoredCounts=rows[0];
    } finally {
      if(restored) await restored.end();
      try {
        if(created && /^rmp_restore_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`);
      } finally { await admin.end(); }
    }
    fs.writeFileSync(path.join(folder,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  }
  console.log(`Backup saved: ${folder}`);
  console.log(`Restore verified: ${manifest.restoreVerified}`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
