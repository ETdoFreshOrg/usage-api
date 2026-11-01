// Copied unchanged from ETdoFreshOrg/imessage-mcp server/oauth (same single-owner OAuth module).
// Copied unchanged from ETdoFreshOrg/memory-database mcp/oauth/oauth-store.mjs (commit bf1959f),
// which took it from ETdoFreshOrg/etcode services/mcp-oauth.
import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';

// Durable OAuth state: consent grants and the SHA-256 hashes of issued access and
// refresh tokens. Raw tokens, the owner key and pending consent are never stored.
// Each table behaves like the Map it replaces, keyed by hash or grant ID.
export class OAuthStore {
 constructor(path=':memory:'){
  this.db=new DatabaseSync(path);
  if(path!==':memory:')try{chmodSync(path,0o600);}catch{}
  this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  for(const name of ['grants','access','refresh'])this[name]=new StoredMap(this.db,'oauth_'+name);
 }
 prune(now){for(const map of [this.grants,this.access,this.refresh])map.prune(now);}
 close(){this.db.close();}
}
class StoredMap {
 constructor(db,table){
  db.exec(`CREATE TABLE IF NOT EXISTS ${table}(key TEXT PRIMARY KEY,expires INTEGER NOT NULL,value TEXT NOT NULL)`);
  this.q={get:db.prepare(`SELECT value FROM ${table} WHERE key=?`),set:db.prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?,?)`),delete:db.prepare(`DELETE FROM ${table} WHERE key=?`),size:db.prepare(`SELECT count(*) AS n FROM ${table}`),prune:db.prepare(`DELETE FROM ${table} WHERE expires<=?`)};
 }
 get(key){const row=this.q.get.get(key);return row?JSON.parse(row.value):undefined;}
 has(key){return this.q.get.get(key)!==undefined;}
 set(key,value){this.q.set.run(key,value.expires,JSON.stringify(value));return this;}
 delete(key){return this.q.delete.run(key).changes>0;}
 get size(){return this.q.size.get().n;}
 prune(now){this.q.prune.run(now);}
}
