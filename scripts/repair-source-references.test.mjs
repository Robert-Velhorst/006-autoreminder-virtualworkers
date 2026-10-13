import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { prepareReferenceRepair, repairSourceReferences, YOUTUBE, BOOKKEEPING, ARCHIVE_LINKS } from './repair-source-references.mjs';

const titles=[
  'Review scheduling history for Siddhant Mohile appointment.', 'Suggest available meeting times via Trello or email.',
  'Confirm meeting time and send calendar invites.', 'Prepare agenda clarifying YouTube metadata automation needs.',
  'Host meeting; capture key points, decisions, actions.', 'Summarize outcomes and update Trello with requirements.',
];
function fixtures(){
  const sources=[
    {id:YOUTUBE,url:'https://trello.com/c/v1BFJ9DU/27-video',attachments:[],closed:false},
    {id:BOOKKEEPING,url:'https://trello.com/c/vwjUC0GZ/41-bookkeeping',attachments:ARCHIVE_LINKS.map(url=>({url})),closed:false},
    ...ARCHIVE_LINKS.map((url,i)=>({id:`archive-${i}`,url,closed:true,attachments:[{url:'https://trello.com/c/vwjUC0GZ/41-bookkeeping'}]})),
  ].map(s=>({...s,name:'Test source',desc:'Retained source text',idBoard:'fixture',dateLastActivity:'2026-01-15T21:00:00Z',observedAt:new Date().toISOString()}));
  const steps=titles.map((title,i)=>({id:100+i,cardId:YOUTUBE,stepNumber:i+1,title,status:'open',blockedBy:null,dependsOnCards:'["v1BFJ9DU"]'}));
  steps.push({id:200,cardId:BOOKKEEPING,stepNumber:3,title:'Review linked automation cards for approaches and limitations.',status:'open',blockedBy:null,dependsOnCards:JSON.stringify(ARCHIVE_LINKS.map(u=>new URL(u).pathname.split('/')[3]))});
  const plans=[YOUTUBE,BOOKKEEPING].map(cardId=>({cardId,cardName:'Test plan',planJson:JSON.stringify({steps:steps.filter(s=>s.cardId===cardId).map(s=>({number:s.stepNumber,text:s.title,dependsOnCards:JSON.parse(s.dependsOnCards),done:false})),untouched:'preserved'})}));
  return {sources,steps,plans};
}
describe('reviewed reference repair validation',()=>{
  it('retains source links and work steps while removing only reviewed false prerequisites',()=>{
    const f=fixtures();const r=prepareReferenceRepair(f.plans[0],f.steps,f.sources);
    assert.equal(r.changed.length,6);assert.equal(r.document.untouched,'preserved');
    assert.equal(r.document.steps[0].referenceCards[0],f.sources[0].url);
    assert.equal(r.document.steps[0].done,false);assert.equal(f.steps[0].dependsOnCards,'["v1BFJ9DU"]');
  });
  for(const mutation of ['source missing','not archived','changed prerequisite','changed title','blocked','completed','stale'])it(`rejects ${mutation}`,()=>{
    const f=fixtures();const step=f.steps.at(-1);
    if(mutation==='source missing')f.sources.pop();
    if(mutation==='not archived')f.sources.at(-1).closed=false;
    if(mutation==='changed prerequisite')step.dependsOnCards='["real-blocker"]';
    if(mutation==='changed title')step.title='Wait until all linked projects finish';
    if(mutation==='blocked')step.blockedBy='Robert approval';
    if(mutation==='completed')step.status='complete';
    if(mutation==='stale')f.sources[0].observedAt='2000-01-01';
    assert.throws(()=>prepareReferenceRepair(f.plans[1],f.steps,f.sources));
  });
});

describe('real MySQL reference repair',()=>{
  let db,vaId;
  before(async()=>{
    const u=new URL(process.env.APTLSS_TEST_DATABASE_URL||'');
    assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&['/recovery_test','/aptlss_test'].includes(u.pathname));
    db=await mysql.createConnection(u.href);
  });
  after(async()=>db?.end());
  beforeEach(async()=>{
    const [user]=await db.query("INSERT INTO users (openId,name,role) VALUES (?, 'Repair test','worker')",[`repair-test-${randomUUID()}`]);vaId=user.insertId;
    const f=fixtures();
    for(const p of f.plans)await db.query('INSERT INTO aptlss_plans (vaId,cardId,cardName,cardUrl,planJson) VALUES (?,?,?,?,?)',[vaId,p.cardId,p.cardName,f.sources.find(s=>s.id===p.cardId).url,p.planJson]);
    for(const s of f.steps)await db.query('INSERT INTO aptlss_steps (vaId,cardId,stepNumber,title,dependsOnCards) VALUES (?,?,?,?,?)',[vaId,s.cardId,s.stepNumber,s.title,s.dependsOnCards]);
  });
  afterEach(async()=>{
    for(const table of ['workspace_evidence_items','aptlss_steps','aptlss_plans','aptlss_audit_log'])await db.query(`DELETE FROM ${table} WHERE vaId=?`,[vaId]);
    await db.query('DELETE FROM users WHERE id=?',[vaId]);
  });
  it('dry-runs, atomically repairs, preserves statuses and reruns without duplicate evidence',async()=>{
    const args={vaId,sources:fixtures().sources,backupDirectory:resolve('.local/repair-tests',randomUUID())};
    assert.deepEqual(await repairSourceReferences(db,args),{applied:false,changes:7});
    assert.deepEqual(await repairSourceReferences(db,{...args,apply:true}),{applied:true,changes:7,evidenceCount:5});
    const [steps]=await db.query('SELECT status,dependsOnCards FROM aptlss_steps WHERE vaId=?',[vaId]);
    assert.ok(steps.every(s=>s.status==='open'&&s.dependsOnCards==='[]'));
    const [audit]=await db.query('SELECT payload FROM aptlss_audit_log WHERE vaId=?',[vaId]);assert.equal(audit.length,2);assert.ok(JSON.parse(audit[0].payload).beforePlan);
    assert.deepEqual(await repairSourceReferences(db,{...args,apply:true}),{applied:false,changes:0});
    const [count]=await db.query('SELECT COUNT(*) n FROM workspace_evidence_items WHERE vaId=?',[vaId]);assert.equal(count[0].n,5);
  });
  it('rolls back step, plan and evidence writes when audit persistence fails',async()=>{
    const failing={beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),query:(q,p)=>{
      if(q.startsWith('INSERT INTO aptlss_audit_log'))throw new Error('Simulated audit failure');return db.query(q,p);
    }};
    await assert.rejects(repairSourceReferences(failing,{vaId,sources:fixtures().sources,apply:true,backupDirectory:resolve('.local/repair-tests',randomUUID())}),/audit failure/);
    const [steps]=await db.query('SELECT dependsOnCards FROM aptlss_steps WHERE vaId=?',[vaId]);assert.ok(steps.every(s=>s.dependsOnCards!=='[]'));
    const [count]=await db.query('SELECT COUNT(*) n FROM workspace_evidence_items WHERE vaId=?',[vaId]);assert.equal(count[0].n,0);
  });
});
