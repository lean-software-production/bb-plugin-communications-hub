import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub';

const databases: Database.Database[] = [];
function setup() { const db = new Database(':memory:'); databases.push(db); return {db, hub: new Hub(db)}; }
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const segment = (key: string, text = 'We agreed to add authentication.', startMs: number | null = 1000) => ({sourceKey:key,speaker:'Alex',text,startMs,endMs:startMs === null ? null : startMs+1000});

describe('persistent conversation library', () => {
  it('keeps immutable passages and attachment state when the hub is reconstructed', () => {
    const {db,hub} = setup(); const m=hub.ensureConversation('import','one','Planning');
    hub.appendSegments(m.id,[segment('a')]); hub.attach('thread-a',m.id);
    const before=hub.readTranscript(m.id,{}); const reopened=new Hub(db);
    expect(reopened.getAttachment('thread-a')).toEqual({threadId:'thread-a',conversationId:m.id,cursor:0});
    expect(reopened.readTranscript(m.id,{}).segments).toEqual(before.segments);
    expect(reopened.ensureConversation('import','one','New title').id).toBe(m.id);
  });
  it('deduplicates retransmission without replacing cited text and rejects invalid batches atomically', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','occurrence','Planning');
    hub.appendSegments(m.id,[segment('a')]); hub.appendSegments(m.id,[segment('a','Different text')]);
    expect(() => hub.appendSegments(m.id,[segment('b'),segment('c','x'.repeat(2001))])).toThrow();
    expect(hub.readTranscript(m.id,{}).segments.map(s=>s.text)).toEqual(['We agreed to add authentication.']);
  });
  it('isolates reading cursors and includes late speech by ingestion sequence', () => {
    const {hub}=setup(); const m=hub.ensureConversation('import','one','Planning');
    hub.appendSegments(m.id,[segment('a'),segment('b')]); hub.attach('A',m.id); hub.attach('B',m.id);
    hub.acknowledge('A',m.id,2); hub.appendSegments(m.id,[segment('late','A late correction',0)]);
    expect(hub.readTranscript(m.id,{after:hub.getAttachment('A')!.cursor}).segments.map(s=>s.text)).toEqual(['A late correction']);
    expect(hub.getAttachment('B')!.cursor).toBe(0);
    expect(() => hub.acknowledge('B',m.id,100)).toThrow();
    const other=hub.ensureConversation('import','two','Other'); expect(() => hub.acknowledge('A',other.id,1)).toThrow();
    hub.attach('A',other.id); expect(hub.getAttachment('A')!.cursor).toBe(0);
    hub.detach('A'); expect(hub.getConversation(m.id).segmentCount).toBe(3);
  });
  it('returns bounded pages with a next cursor and filters speech intervals', () => {
    const {hub}=setup(); const m=hub.ensureConversation('import','one','Planning');
    hub.appendSegments(m.id,Array.from({length:33},(_,i)=>segment(String(i),'passage '+i,i*1000)));
    const first=hub.readTranscript(m.id,{limit:30}); expect(first.segments).toHaveLength(30); expect(first.hasMore).toBe(true);
    expect(hub.readTranscript(m.id,{after:first.nextCursor}).segments).toHaveLength(3);
    expect(hub.readTranscript(m.id,{fromMs:1500,toMs:2500}).segments.map(s=>s.text)).toEqual(['passage 1','passage 2']);
    expect(() => hub.readTranscript(m.id,{limit:500})).toThrow();
  });
  it('searches only the chosen conversation and treats user punctuation as data', () => {
    const {hub}=setup(); const a=hub.ensureConversation('import','a','A'), b=hub.ensureConversation('import','b','B');
    hub.appendSegments(a.id,[segment('a','Authentication rollout is agreed'),segment('b','Other')]);
    hub.appendSegments(b.id,[segment('a','Authentication rollout is cancelled')]);
    expect(hub.searchTranscript(a.id,{query:'authentication rollout'}).segments.map(s=>s.text)).toEqual(['Authentication rollout is agreed']);
    expect(() => hub.searchTranscript(a.id,{query:'" OR * --'})).not.toThrow();
    expect(() => hub.readTranscript('missing',{})).toThrow(/conversation/i);
  });
  it('marks previously active captures interrupted on restart without marking stored imports live', () => {
    const {hub}=setup(); const m=hub.ensureConversation('zoom','one','Live'); hub.setCapture(m.id,'capturing');
    const imported=hub.ensureConversation('import','two','Stored'); hub.interruptActiveCaptures();
    expect(hub.getConversation(m.id).captureState).toBe('interrupted');
    hub.setCapture(m.id,'capturing'); expect(hub.getConversation(m.id).interruptionCount).toBe(1); expect(hub.getConversation(imported.id).captureState).toBe('idle');
  });
});
