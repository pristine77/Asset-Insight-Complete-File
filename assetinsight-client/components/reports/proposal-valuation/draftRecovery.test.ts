import { describe, expect, it } from "vitest";
import {
  cellKey, readCell, rebaseDraft, draftPointerKey, draftStorageKey, draftStoragePrefix,
  parseDraftBackup, serializeDraftBackup, latestDraftsByLineage, isEmptyDraft, DRAFT_TTL_MS,
  type DraftBackup, type DraftEdit,
} from "./draftRecovery";
import type { ProposalValuationSheet } from "./types";

const now = 1793808000000;
function sheet(value: number | null = 100): ProposalValuationSheet {
  return {
    evaluator_columns: [{id:"jay",name:"Jay"},{id:"chad",name:"Chad"}],
    rows:[{
      lot_id:"stable-lot",asset_id:"27",asset_category:"Truck",year:"2014",make:"Ford",model:"F150",serial_number:"original",cr_details:"Truck",condition_score:"3",location:"Regina",pictures:1,picture_urls:["synthetic.jpg"],
      market_check:{comparable_count:"",avg_retail_asking_price:"",market_saturation:"",market_velocity:"",regional_demand:"",notes:"original market"},
      asset_insight:"CA$500",evaluator_values:{jay:value,chad:null},low_est_sale_value:null,high_est_sale_value:null,buyer_premium_percent:15,buyer_premium_amount:null,total_expected_gross:null,allocated_value:null,notes:"original",cleaning:null,lien_search:null,video_cost:null,lotting_fee:null,advertising:null,
    }],
    file_summary:{buyers_premium_basis:"uncapped",total_risk_weighted_value:null,file_risk_multiplier:null,commission_percent_no_guarantee:null,offer2_nmg_percent:0.785,capped_threshold_percent:0.1},
  };
}
const edit = (value: number | null = 500, from: number | null = 100): DraftEdit => ({lotId:"stable-lot",field:"evaluator_values.jay",value,from});
function backup(overrides: Partial<DraftBackup> = {}): DraftBackup {
  return {version:1,actorId:"owner",reportId:"report",draftId:"editor-a",lineageId:"lineage-a",savedAt:now,revision:7,edits:[edit()],overlaps:[],dropped:[],retryEnvelope:null,...overrides};
}

describe("valuation draft rebase",()=>{
  it("preserves local cell edits and independent server changes without changing source or formulas",()=>{
    const latest=sheet();latest.rows[0]!.notes="remote note";const before=structuredClone(latest);
    const result=rebaseDraft(latest,[edit()]);
    expect(readCell(result.sheet,edit())).toBe(500);
    expect(result.sheet.rows[0]!.notes).toBe("remote note");
    expect(result.sheet.rows[0]!.buyer_premium_amount).toBe(75);
    expect(result.overlaps).toEqual([]);expect(result.edits).toEqual([edit()]);expect(latest).toEqual(before);
  });
  it("keeps the original conflict base across repeated refresh and durable reload",()=>{
    const first=rebaseDraft(sheet(900),[edit()]);
    expect(first.overlaps).toEqual([{key:cellKey(edit()),lotId:"stable-lot",field:"evaluator_values.jay",base:100,theirs:900,yours:500}]);
    expect(first.edits[0]!.from).toBe(900);
    const stored=parseDraftBackup(serializeDraftBackup(backup({...first,revision:8})),"owner","report",now)!;
    const again=rebaseDraft(sheet(900),stored.edits,stored.overlaps,stored.dropped);
    expect(again.overlaps).toEqual(first.overlaps);
    const changed=rebaseDraft(sheet(950),again.edits,again.overlaps);
    expect(changed.overlaps[0]).toMatchObject({base:100,theirs:950,yours:500});
  });
  it("retains a blank original conflict baseline after later rebases",()=>{
    const first=rebaseDraft(sheet(900),[edit(500,null)]);
    const again=rebaseDraft(sheet(950),first.edits,first.overlaps);
    expect(again.overlaps[0]).toMatchObject({base:null,theirs:950,yours:500});
  });
  it("keeps unresolved overlaps even if the remote value returns to the original baseline",()=>{
    const conflict=rebaseDraft(sheet(900),[edit()]);
    expect(rebaseDraft(sheet(100),conflict.edits,conflict.overlaps).overlaps[0]).toMatchObject({base:100,theirs:100,yours:500});
  });
  it("drops a pending change only when the server already confirms that exact value",()=>{
    const conflict=rebaseDraft(sheet(900),[edit()]);
    const resolved=rebaseDraft(sheet(500),conflict.edits,conflict.overlaps);
    expect(resolved.edits).toEqual([]);expect(resolved.overlaps).toEqual([]);
  });
  it.each(["row","column"])("keeps edits recoverable when their %s disappears",kind=>{
    const latest=sheet();if(kind==="row")latest.rows=[];else latest.evaluator_columns=[];
    const missing=rebaseDraft(latest,[edit()]);
    expect(missing.edits).toEqual([]);expect(missing.dropped).toEqual([edit()]);
    expect(rebaseDraft(latest,missing.edits,missing.overlaps,missing.dropped).dropped).toEqual([edit()]);
    const restored=rebaseDraft(sheet(),missing.edits,missing.overlaps,missing.dropped);
    expect(restored.edits).toEqual([edit()]);expect(restored.dropped).toEqual([]);
    expect(readCell(restored.sheet,edit())).toBe(500);
  });
  it("does not move a removed row's edit onto the next row",()=>{
    const latest=sheet();latest.rows[0]!.lot_id="replacement-lot";
    const result=rebaseDraft(latest,[edit()]);expect(result.dropped).toEqual([edit()]);expect(latest.rows[0]!.evaluator_values.jay).toBe(100);
  });
  it("retains original overlap evidence while the target is absent",()=>{
    const conflict=rebaseDraft(sheet(900),[edit()]);const missing=sheet();missing.rows=[];
    const gone=rebaseDraft(missing,conflict.edits,conflict.overlaps);
    const restored=rebaseDraft(sheet(900),gone.edits,gone.overlaps,gone.dropped);
    expect(restored.overlaps[0]).toMatchObject({base:100,theirs:900,yours:500});
  });
  it("keeps a newer same-cell edit instead of an older dropped recovery record",()=>{
    const result=rebaseDraft(sheet(),[edit(700)],[],[edit(500)]);
    expect(result.edits).toEqual([edit(700)]);
  });
  it("distinguishes explicit zero from blank and preserves zero baselines",()=>{
    expect(rebaseDraft(sheet(0),[edit(null,100)]).overlaps[0]).toMatchObject({base:100,theirs:0,yours:null});
    expect(rebaseDraft(sheet(0),[edit(500,0)]).overlaps).toEqual([]);
    expect(readCell(sheet(null),edit())).toBeNull();
  });
  it("reads and rebases nested market and file summary values by their API fields",()=>{
    const changes:DraftEdit[]=[{lotId:"stable-lot",field:"market_check.notes",from:"original market",value:"local market"},{lotId:null,field:"file_summary.buyers_premium_basis",from:"uncapped",value:"capped"}];
    const result=rebaseDraft(sheet(),changes);
    expect(readCell(result.sheet,changes[0]!)).toBe("local market");expect(readCell(result.sheet,changes[1]!)).toBe("capped");expect(result.overlaps).toEqual([]);
  });
  it("never interprets read-only, prototype or unknown paths as editable cells",()=>{
    for(const field of ["asset_id","asset_insight","evaluator_values.__proto__","__proto__","file_summary.__proto__","not-a-field"]){
      expect(readCell(sheet(),{lotId:"stable-lot",field})).toBeUndefined();
    }
  });
});

describe("scoped durable valuation drafts",()=>{
  it("round trips exact immutable retry identity alongside newer same-cell edits",()=>{
    const retryEnvelope={changes:[{lotId:"stable-lot",field:"evaluator_values.jay",value:500}],request:{baseRevision:7,clientMutationId:"exact-retry-uuid"}};
    const original=backup({edits:[edit(700)],retryEnvelope});
    const parsed=parseDraftBackup(serializeDraftBackup(original),"owner","report",now)!;
    expect(parsed.retryEnvelope).toEqual(retryEnvelope);expect(parsed.edits).toEqual([edit(700)]);
    parsed.retryEnvelope!.changes[0]!.value=999;expect(original.retryEnvelope!.changes[0]!.value).toBe(500);
  });
  it("bounds an exact retry envelope to the existing 500-cell API limit without truncating",()=>{
    const changes=Array.from({length:500},(_,i)=>({lotId:`lot-${i}`,field:"evaluator_values.jay",value:i}));
    const record=backup({retryEnvelope:{changes,request:{baseRevision:9,clientMutationId:"exact-500"}}});
    expect(parseDraftBackup(serializeDraftBackup(record),"owner","report",now)!.retryEnvelope!.changes).toEqual(changes);
    record.retryEnvelope!.changes.push({lotId:"overflow",field:"notes",value:"not discarded"});
    expect(parseDraftBackup(JSON.stringify(record),"owner","report",now)).toBeNull();
  });
  it("accepts an empty checkpoint and suppresses its older lineage without deleting another editor",()=>{
    const first=backup();const second=backup({draftId:"editor-b",lineageId:"lineage-b",savedAt:now+1});
    const tombstone=backup({draftId:"editor-c",savedAt:now+2,edits:[]});
    const store=new Map([first,second,tombstone].map(item=>[draftStorageKey(item.actorId,item.reportId,item.draftId),serializeDraftBackup(item)]));
    const records=[...store.values()].map(value=>parseDraftBackup(value,"owner","report",now+2)!);
    const newest=latestDraftsByLineage(records);
    expect(store.size).toBe(3);expect(newest).toHaveLength(2);
    expect(newest.filter(item=>!isEmptyDraft(item)).map(item=>item.draftId)).toEqual(["editor-b"]);
  });
  it("prefers an empty checkpoint on equal timestamps and keeps scopes distinct",()=>{
    const empty=backup({draftId:"cleared",edits:[]});
    expect(latestDraftsByLineage([empty,backup()])[0]!.draftId).toBe("cleared");
    expect(latestDraftsByLineage([backup(),backup({actorId:"other"}),backup({reportId:"other"})])).toHaveLength(3);
  });
  it("uses actor/report/editor-specific encoded keys and a separate session pointer",()=>{
    expect(draftStorageKey("a:b","c","tab")).not.toBe(draftStorageKey("a","b:c","tab"));
    expect(draftStorageKey("owner","r","first")).not.toBe(draftStorageKey("owner","r","second"));
    expect(draftStorageKey("owner","r","first").startsWith(draftStoragePrefix("owner","r"))).toBe(true);
    expect(draftPointerKey("owner","r")).not.toContain(draftStoragePrefix("owner","r"));
  });
  it("refuses another account/report, expired backups and unreasonable future timestamps",()=>{
    const raw=serializeDraftBackup(backup());
    expect(parseDraftBackup(raw,"other","report",now)).toBeNull();expect(parseDraftBackup(raw,"owner","other",now)).toBeNull();
    expect(parseDraftBackup(raw,"owner","report",now+DRAFT_TTL_MS+1)).toBeNull();
    expect(parseDraftBackup(raw,"owner","report",now-301000)).toBeNull();
    expect(parseDraftBackup(raw,"owner","report",now+DRAFT_TTL_MS)).not.toBeNull();
  });
  it("projects stored records onto known fields without persisting credentials",()=>{
    const raw=JSON.stringify({...backup(),accessToken:"secret",refreshToken:"secret",retryEnvelope:{changes:[edit()],request:{baseRevision:7,clientMutationId:"exact",token:"secret"},authorization:"secret"}});
    const parsed=parseDraftBackup(raw,"owner","report",now)!;
    expect(JSON.stringify(parsed)).not.toContain("secret");expect(parsed.retryEnvelope).toEqual({changes:[{lotId:"stable-lot",field:"evaluator_values.jay",value:500}],request:{baseRevision:7,clientMutationId:"exact"}});
  });
  it.each([
    {edits:[{...edit(),field:"asset_insight"}]},
    {edits:[{...edit(),value:{token:"x"}}]},
    {edits:[{...edit(),from:"unexpected numeric text"}]},
    {edits:[{...edit(),field:"evaluator_values.__proto__"}]},
    {revision:-1}, {version:2}, {draftId:""}, {lineageId:""},
    {overlaps:[{key:"wrong",lotId:"stable-lot",field:"notes",base:"a",theirs:"b",yours:"c"}]},
  ])("fails closed on malformed backup %j",override=>{
    expect(parseDraftBackup(JSON.stringify({...backup(),...override}),"owner","report",now)).toBeNull();
  });
  it("does not silently convert a nonfinite pending value into blank during serialization",()=>{
    expect(()=>serializeDraftBackup(backup({edits:[edit(Infinity)]}))).toThrow(/invalid number/);
    expect(parseDraftBackup(JSON.stringify(backup()).replace('"value":500','"value":1e400'),"owner","report",now)).toBeNull();
  });
  it("retains unfinished focused text without turning it into a committed numeric value",()=>{
    const activeInput={lotId:"stable-lot",field:"evaluator_values.jay",raw:"-",from:100};
    const parsed=parseDraftBackup(serializeDraftBackup(backup({edits:[],activeInput})),"owner","report",now)!;
    expect(parsed.activeInput).toEqual(activeInput);expect(parsed.edits).toEqual([]);expect(isEmptyDraft(parsed)).toBe(false);
    expect(latestDraftsByLineage([backup({edits:[]}),parsed])[0]).not.toBeUndefined();
  });
  it.each([{lotId:"",field:"notes",raw:"hello",from:""},{lotId:"stable-lot",field:"__proto__",raw:"a",from:""},{lotId:"stable-lot",field:"notes",raw:"x".repeat(16001),from:""},{lotId:"stable-lot",field:"evaluator_values.jay",raw:"-",from:"bad"}])("refuses invalid active input",activeInput=>{
    expect(parseDraftBackup(JSON.stringify(backup({activeInput})),"owner","report",now)).toBeNull();
  });
  it("retains removed edits and overlap evidence in the stored schema",()=>{
    const conflict=rebaseDraft(sheet(900),[edit()]);
    const latest=sheet();latest.evaluator_columns=[];const removed=rebaseDraft(latest,conflict.edits,conflict.overlaps);
    const parsed=parseDraftBackup(serializeDraftBackup(backup({...removed})),"owner","report",now)!;
    expect(parsed.dropped).toEqual(removed.dropped);expect(parsed.overlaps).toEqual(removed.overlaps);
  });
});
