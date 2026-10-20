import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPAIR = 'source-references-20260913';
export const YOUTUBE = '65b9505819de9392c6fbf906';
export const BOOKKEEPING = '67841bb1daccf6d4ca5d55eb';
export const ARCHIVE_LINKS = [
  'https://trello.com/c/oqkxlb4T/9-automating-receipts-into-wave-accounting-handicaps',
  'https://trello.com/c/9wFJaX7g/7-automating-receipts-into-mijngeldzakennl',
  'https://trello.com/c/niQpyTdw/8-automating-receipts-into-wave-accounting-business',
];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const short = url => new URL(url).pathname.split('/')[2];
const reviewedTitles = {
  [YOUTUBE]: [
    'Review scheduling history for Siddhant Mohile appointment.',
    'Suggest available meeting times via Trello or email.',
    'Confirm meeting time and send calendar invites.',
    'Prepare agenda clarifying YouTube metadata automation needs.',
    'Host meeting; capture key points, decisions, actions.',
    'Summarize outcomes and update Trello with requirements.',
  ],
  [BOOKKEEPING]: ['Review linked automation cards for approaches and limitations.'],
};

// This is an explicitly reviewed, bounded repair, not automatic text classification.
export function prepareReferenceRepair(plan, steps, sources) {
  const document = JSON.parse(plan.planJson);
  const source = sources.find(s => s.id === plan.cardId);
  if (!source || !Array.isArray(document.steps)) throw new Error('Missing original source or plan steps');
  for (const s of sources) {
    if (new URL(s.url).origin !== 'https://trello.com' || !s.dateLastActivity || !Number.isFinite(Date.parse(s.dateLastActivity))
      || !Number.isFinite(Date.parse(s.observedAt)) || Math.abs(Date.now()-Date.parse(s.observedAt))>3600000) throw new Error('Fresh verified Trello sources required');
  }
  const youtube = plan.cardId === YOUTUBE;
  if (!youtube && plan.cardId !== BOOKKEEPING) throw new Error('Card is outside this repair');
  const refs = youtube ? ['v1BFJ9DU'] : ARCHIVE_LINKS.map(u => new URL(u).pathname.split('/')[3]);
  const urls = youtube ? [source.url] : ARCHIVE_LINKS;
  if (youtube && short(source.url) !== 'v1BFJ9DU') throw new Error('Self-reference identity mismatch');
  for (const url of urls) {
    const retained = sources.find(s => short(s.url) === short(url));
    if (!retained || !retained.desc?.trim()) throw new Error('Referenced source was not fetched');
    if (!youtube && (!retained.closed || !source.attachments.some(a => a.url === url)
      || !retained.attachments.some(a => short(a.url) === short(source.url)))) {
      throw new Error('Archived source and reciprocal consolidation link must be verified');
    }
  }
  const candidates = youtube ? [1,2,3,4,5,6] : [3];
  const changed = [];
  for (const number of candidates) {
    const matching = steps.filter(s => s.cardId === plan.cardId && s.stepNumber === number && s.status !== 'obsolete');
    const planned = document.steps.filter(s => s.number === number);
    if (matching.length !== 1 || planned.length !== 1) throw new Error('Ambiguous step identity');
    const step = matching[0], item = planned[0];
    if (document.referenceRepair?.id === REPAIR && same(JSON.parse(step.dependsOnCards), []) && same(item.dependsOnCards, [])) continue;
    if (step.status !== 'open' || step.blockedBy || !same(JSON.parse(step.dependsOnCards), refs)
      || !same(item.dependsOnCards, refs) || step.title !== item.text
      || step.title !== reviewedTitles[plan.cardId][youtube?number-1:0]) throw new Error('Step changed since review; refusing repair');
    changed.push({ id: step.id, number, before: step.dependsOnCards });
    item.referenceCards = urls;
    item.dependsOnCards = [];
  }
  document.referenceRepair = { id: REPAIR, reason: youtube
    ? 'Own-card source links are context, not prerequisites for completing the same card.'
    : 'These archived, reciprocally linked cards are source material to review, not outstanding delivery prerequisites.',
    sourceUrls: urls };
  return { changed, document, sourceUrls: urls };
}

export async function repairSourceReferences(db, { vaId, sources, apply = false, backupDirectory }) {
  await db.beginTransaction();
  try {
    const [plans] = await db.query('SELECT * FROM aptlss_plans WHERE vaId=? AND cardId IN (?,?) ORDER BY cardId FOR UPDATE', [vaId,YOUTUBE,BOOKKEEPING]);
    const [steps] = await db.query('SELECT * FROM aptlss_steps WHERE vaId=? AND cardId IN (?,?) ORDER BY cardId,stepNumber FOR UPDATE', [vaId,YOUTUBE,BOOKKEEPING]);
    if (plans.length !== 2) throw new Error('Both worker-owned plans must exist');
    const repairs = plans.map(p => ({ plan:p, ...prepareReferenceRepair(p, steps.filter(s=>s.cardId===p.cardId), sources) }));
    const changes = repairs.reduce((n,r)=>n+r.changed.length,0);
    if (!apply || !changes) { await db.rollback(); return { applied:false, changes }; }
    if (!backupDirectory) throw new Error('Backup directory required');
    mkdirSync(backupDirectory,{recursive:true});
    writeFileSync(resolve(backupDirectory,`before-${Date.now()}.json`),JSON.stringify({repair:REPAIR,vaId,plans,steps,sources},null,2),{flag:'wx',mode:0o600});
    let evidenceCount=0;
    for (const r of repairs) {
      if (!r.changed.length) continue;
      const records = sources.filter(s=>s.id===r.plan.cardId || r.sourceUrls.some(u=>short(u)===short(s.url)));
      const evidenceIds=[];
      for (const s of records) {
        const content = JSON.stringify(s);
        const sourceId = `${REPAIR}:${s.id}:${hash(s)}`;
        const metadata = JSON.stringify({origin:REPAIR,archived:s.closed,sourceDate:s.dateLastActivity,referenceOnly:true});
        const [insert] = await db.query(`INSERT INTO workspace_evidence_items
          (vaId,source,sourceId,sourceContainerId,kind,title,summary,content,sourceUrl,modifiedAt,observedAt,contentHash,metadataJson,reviewStatus,reviewedAt,reviewedBy)
          VALUES (?,'trello',?,?,'reference_card',?,?,?,?,?,?,?,?, 'linked',NOW(),'Robert-authorized maintenance')
          ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
          [vaId,sourceId,s.idBoard,s.name,s.closed?'Archived reference material; archival does not prove work completion.':'Verified source card reference.',content,s.url,new Date(s.dateLastActivity),new Date(s.observedAt),hash(s),metadata]);
        const eid=insert.insertId; evidenceIds.push(eid); evidenceCount++;
        await db.query(`INSERT INTO aptlss_evidence_revisions (evidenceId,contentHash,truthClass,content,metadataJson,observedAt,recordedBy)
          VALUES (?,?,'source_record',?,?,?,'Robert-authorized maintenance') ON DUPLICATE KEY UPDATE id=id`,[eid,hash(s),content,metadata,new Date(s.observedAt)]);
        await db.query(`INSERT INTO workspace_evidence_links (evidenceId,cardId,relevanceScore,matchReason,linkMethod)
          VALUES (?,?,100,?,'manual') ON DUPLICATE KEY UPDATE id=id`,[eid,r.plan.cardId,r.document.referenceRepair.reason]);
        await db.query(`INSERT INTO aptlss_evidence_subject_links (evidenceId,vaId,subjectType,subjectId,relevanceScore,linkMethod,matchReason)
          VALUES (?,?,'card',?,100,'confirmed',?) ON DUPLICATE KEY UPDATE id=id`,[eid,vaId,r.plan.cardId,r.document.referenceRepair.reason]);
      }
      for(const change of r.changed) await db.query("UPDATE aptlss_steps SET dependsOnCards='[]' WHERE id=? AND vaId=? AND cardId=?",[change.id,vaId,r.plan.cardId]);
      await db.query('UPDATE aptlss_plans SET planJson=? WHERE id=? AND vaId=?',[JSON.stringify(r.document),r.plan.id,vaId]);
      await db.query(`INSERT INTO aptlss_audit_log (vaId,cardId,cardName,action,description,payload,source,approved)
        VALUES (?,?,?,'source_reference_repair',?,?,'owner_requested',true)`,[vaId,r.plan.cardId,r.plan.cardName,r.document.referenceRepair.reason,
        JSON.stringify({repair:REPAIR,beforePlan:r.plan.planJson,changes:r.changed,evidenceIds,sourceUrls:r.sourceUrls,afterPlanHash:hash(r.document)})]);
    }
    await db.commit();
    return {applied:true,changes,evidenceCount};
  } catch(error) { await db.rollback(); throw error; }
}
