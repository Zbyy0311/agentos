import { randomUUID } from 'node:crypto';
import type { TransactionDatabase } from '../store/Transaction.js';
import { inTransaction } from '../store/Transaction.js';
import { MemoryEntryRepository, type MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
export const MEMORY_LIFECYCLE_ACTIONS = ['archive','restore','delete','revalidate','set-validity'] as const;
export type MemoryLifecycleAction = typeof MEMORY_LIFECYCLE_ACTIONS[number];
export interface MemoryLifecycleInput {
  workspaceId:string; entryId:string; expectedVersion:number; action:MemoryLifecycleAction;
  validFrom?:string|null; validUntil?:string|null; expiresAt?:string|null;
}
export class MemoryLifecycleError extends Error {
  constructor(readonly code:string) {super(code);}
}
function validDate(value:unknown):value is string|null {
  return value === null || (typeof value==='string' && value.length<=40
    && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
}
export class MemoryLifecycleService {
  private readonly entries:MemoryEntryRepository;
  constructor(private readonly db:TransactionDatabase,private readonly now:()=>string=()=>new Date().toISOString()) {
    this.entries=new MemoryEntryRepository(db);
  }
  apply(input:MemoryLifecycleInput,onChange?:(entry:MemoryEntryRecord,timestamp:string)=>void):MemoryEntryRecord {
    if(!input.workspaceId?.trim()||!input.entryId?.trim()||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1
      ||!(MEMORY_LIFECYCLE_ACTIONS as readonly string[]).includes(input.action)) throw new MemoryLifecycleError('MEMORY_LIFECYCLE_INPUT_INVALID');
    const fields=['validFrom','validUntil','expiresAt'] as const;
    if(input.action==='set-validity' ? !fields.some(key=>input[key]!==undefined)||fields.some(key=>input[key]!==undefined&&!validDate(input[key]))
      : fields.some(key=>input[key]!==undefined)) throw new MemoryLifecycleError('MEMORY_LIFECYCLE_INPUT_INVALID');
    return inTransaction(this.db,()=>{
      const current=this.entries.findById(input.workspaceId,input.entryId);
      if(!current) throw new MemoryLifecycleError('MEMORY_ENTRY_NOT_FOUND');
      if(current.version!==input.expectedVersion) throw new MemoryLifecycleError('MEMORY_ENTRY_VERSION_CONFLICT');
      if((current.status==='deleted'&&input.action!=='restore')||current.status==='candidate'||current.status==='conflicted') throw new MemoryLifecycleError('MEMORY_ENTRY_NOT_UPDATABLE');
      if(input.action==='archive'&&current.status!=='active' || input.action==='restore'&&!['archived','deprecated','deleted'].includes(current.status))
        throw new MemoryLifecycleError('MEMORY_ENTRY_NOT_UPDATABLE');
      const status=input.action==='archive'?'archived':input.action==='delete'?'deleted':input.action==='restore'||input.action==='revalidate'?'active':current.status;
      const dates={validFrom:input.validFrom===undefined?current.validFrom:input.validFrom,
        validUntil:input.validUntil===undefined?current.validUntil:input.validUntil,
        expiresAt:input.expiresAt===undefined?current.expiresAt:input.expiresAt};
      // Revalidation does not silently extend an explicit validity period.
      if(dates.validFrom&&[dates.validUntil,dates.expiresAt].some(end=>end!==null&&Date.parse(end)<=Date.parse(dates.validFrom!)))
        throw new MemoryLifecycleError('MEMORY_LIFECYCLE_INPUT_INVALID');
      const timestamp=this.now();
      const changed=this.db.prepare(`UPDATE memory_entries SET status=?,valid_from=?,valid_until=?,expires_at=?,version=version+1,updated_at=?
        WHERE workspace_id=? AND id=? AND version=?`).run(status,dates.validFrom,dates.validUntil,dates.expiresAt,timestamp,input.workspaceId,input.entryId,input.expectedVersion) as {changes:number|bigint};
      if(Number(changed.changes)!==1) throw new MemoryLifecycleError('MEMORY_ENTRY_VERSION_CONFLICT');
      const entry=this.entries.findById(input.workspaceId,input.entryId)!;
      this.db.prepare(`INSERT INTO memory_lifecycle_actions (id,workspace_id,entry_id,action,from_version,to_version,before_json,after_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(),input.workspaceId,input.entryId,input.action,current.version,entry.version,JSON.stringify(current),JSON.stringify(entry),timestamp);
      onChange?.(entry,timestamp);
      return entry;
    });
  }
}
