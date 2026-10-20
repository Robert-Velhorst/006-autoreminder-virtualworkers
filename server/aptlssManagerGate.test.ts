import { describe, expect, it } from "vitest";
import { evaluateManagerGate, type TrialObservation } from "./aptlssManagerGate";

const trial = (): TrialObservation[] => Array.from({length:100}, (_,i) => ({ proposalHash:`proposal-${i}`, createdAt:new Date(`2026-08-${String(24+Math.floor(i/20)).padStart(2,"0")}T10:00:00Z`), urgent:i%10===0, review:{verdict:"correct",critical:false} }));
const evaluate = (observations = trial(), safetyVerified = true) => evaluateManagerGate({ observations, safetyVerified, timezone:"Europe/Amsterdam",workingDays:[1,2,3,4,5] });

describe("manager measured acceptance gate", () => {
  it("allows 100 distinct correct proposals across five working days with current safety evidence", () => { expect(evaluate()).toMatchObject({eligible:true,reviewed:100,workingDays:5,correct:100}); });
  it("requires current implementation safety proof", () => { expect(evaluate(trial(),false).eligible).toBe(false); });
  it("cannot count repeated proposals as independent outcomes", () => { expect(evaluate(trial().map(x=>({...x,proposalHash:"same"}))).reviewed).toBe(1); });
  it("does not hide a reviewed proposal with an unreviewed repeat", () => {
    const rows=trial(); rows.push({...rows[0],createdAt:new Date("2026-08-29T10:00:00Z"),review:null}); expect(evaluate(rows).reviewed).toBe(100);
  });
  it("does not hide a critical error behind a correct duplicate", () => {
    const rows=trial(); rows.push({...rows[0],review:{verdict:"incorrect",critical:true}}); expect(evaluate(rows)).toMatchObject({eligible:false,critical:1});
  });
  it("accepts exactly 98 correct proposals out of the latest 100", () => {
    const rows=trial(); rows[0].review!.verdict="incorrect"; rows[1].review!.verdict="insufficient"; expect(evaluate(rows).eligible).toBe(true);
  });
  it("rejects 97 out of 100", () => {
    const rows=trial(); for(let i=0;i<3;i++) rows[i].review!.verdict="incorrect"; expect(evaluate(rows).eligible).toBe(false);
  });
  it("does not bury recent failures in older successes", () => {
    const rows=trial(); for(let i=0;i<3;i++) rows.push({proposalHash:`failure-${i}`,createdAt:new Date("2026-09-01T10:00:00Z"),urgent:false,review:{verdict:"incorrect",critical:false}}); expect(evaluate(rows).correct).toBe(97);
  });
  it("requires review of every urgent proposal even with 100 correct ones", () => {
    const rows=trial(); rows.push({proposalHash:"urgent",createdAt:new Date("2026-09-01T10:00:00Z"),urgent:true,review:null}); expect(evaluate(rows)).toMatchObject({eligible:false,unreviewedUrgent:1});
  });
  it("does not count nonworking weekends", () => {
    const rows=trial().map((r,i)=>({...r,createdAt:new Date(i<50?"2026-08-29T10:00:00Z":"2026-08-30T10:00:00Z")})); expect(evaluate(rows).workingDays).toBe(0);
  });
  it("uses the worker timezone when counting workdays", () => {
    const rows=trial().map(r=>({...r,createdAt:new Date("2026-08-28T23:30:00Z")})); expect(evaluate(rows).workingDays).toBe(0);
  });
  it("requires five actual reviewed days, not elapsed calendar time", () => {
    const rows=trial().map(r=>({...r,createdAt:new Date("2026-08-24T10:00:00Z")})); expect(evaluate(rows)).toMatchObject({eligible:false,workingDays:1});
  });
  it("cannot manufacture reviewed workdays by replaying unreviewed duplicates", () => {
    const rows=trial().map(r=>({...r,createdAt:new Date("2026-08-24T10:00:00Z")}));
    const copies=rows.slice(0,80).map((r,i)=>({...r,createdAt:new Date(`2026-08-${25+Math.floor(i/20)}T10:00:00Z`),review:null}));
    expect(evaluate([...rows,...copies])).toMatchObject({eligible:false,workingDays:1,reviewed:100});
  });
  it("cannot activate from an empty or incomplete trial", () => { expect(evaluate([]).eligible).toBe(false); expect(evaluate(trial().slice(0,99)).eligible).toBe(false); });
  it("never treats review absence as correctness", () => { expect(evaluate(trial().map(r=>({...r,review:null}))).correct).toBe(0); });
});
