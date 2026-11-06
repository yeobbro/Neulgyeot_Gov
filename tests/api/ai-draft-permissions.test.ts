/** AI draft approve/discard require write permission on the target; read access is not enough. */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as drafts from "../../app/api/ai/drafts/route";
import * as review from "../../app/api/ai/drafts/[id]/review/route";
import type { Db } from "../../lib/server/db/client";
import { call, DEMO_USERS, freshDb } from "../helpers";

let db: Db;
const A = DEMO_USERS.admin;
const CM = DEMO_USERS.cmHaesol; // region rg_haesol/rg_daon, assigned to ir_2 and case_3 in the seed
before(async () => {
  db = await freshDb();
});

const newReferralDraft = async () => {
  const r = await call(drafts.POST, { as: A, body: { kind: "referral_summary", referralId: "ir_2" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id as string;
};
const newCaseDraft = async () => {
  const r = await call(drafts.POST, { as: CM, body: { kind: "meeting_brief", caseId: "case_3" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id as string;
};
const reviewAs = (who: string, id: string, action: "approve" | "discard", extra: Record<string, unknown> = {}) =>
  call(review.POST, { as: who, params: { id }, body: { action, ...extra } });
const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM ai_drafts WHERE id = $1`, [id]))[0].status;

test("referral draft: a read-only user (in region, not assigned) can list but cannot approve or discard", async () => {
  const id = await newReferralDraft();
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [A]); // CM keeps region read access only
  try {
    const list = await call(drafts.GET, { as: CM, url: "/api/ai/drafts?referralId=ir_2" });
    assert.equal(list.status, 200, "read access is unchanged");
    assert.ok(list.json.data.some((d: any) => d.id === id));
    const ap = await reviewAs(CM, id, "approve");
    assert.equal(ap.status, 403, JSON.stringify(ap.json));
    const di = await reviewAs(CM, id, "discard");
    assert.equal(di.status, 403);
    assert.equal(await statusOf(id), "draft", "nothing changed");
  } finally {
    await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [CM]);
  }
});

test("referral draft: the assigned case manager may approve; an admin may discard", async () => {
  const a = await newReferralDraft();
  const ok = await reviewAs(CM, a, "approve");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(await statusOf(a), "approved");
  const b = await newReferralDraft();
  assert.equal((await reviewAs(A, b, "discard")).status, 200);
  assert.equal(await statusOf(b), "discarded");
});

test("case draft: read-only (assignment ended) cannot approve or discard; assigned case manager can", async () => {
  const id = await newCaseDraft();
  await db.query(`UPDATE case_assignments SET ended_at = now() WHERE case_id = 'case_3' AND user_id = $1`, [CM]);
  try {
    assert.equal((await reviewAs(CM, id, "approve")).status, 403);
    assert.equal((await reviewAs(CM, id, "discard")).status, 403);
    assert.equal(await statusOf(id), "draft");
  } finally {
    await db.query(`UPDATE case_assignments SET ended_at = NULL WHERE case_id = 'case_3' AND user_id = $1`, [CM]);
  }
  assert.equal((await reviewAs(CM, id, "discard")).status, 200);
});

test("other tenant, out-of-region, auditor and provider users get 404 (existence not revealed)", async () => {
  const ref = await newReferralDraft();
  const cs = await newCaseDraft();
  for (const who of [DEMO_USERS.otherAdmin, DEMO_USERS.cmMaru, DEMO_USERS.auditor, DEMO_USERS.providerNursing]) {
    for (const id of [ref, cs]) {
      for (const action of ["approve", "discard"] as const) {
        const r = await reviewAs(who, id, action);
        assert.equal(r.status, 404, `${who} ${action} → ${r.status}`);
      }
    }
  }
  assert.equal(await statusOf(ref), "draft");
  assert.equal(await statusOf(cs), "draft");
});

test("audit: successful reviews record actor, target, action and time; denied attempts are recorded too", async () => {
  const id = await newReferralDraft();
  await reviewAs(DEMO_USERS.cmMaru, id, "approve"); // denied (404)
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [A]);
  await reviewAs(CM, id, "discard"); // denied (403)
  await db.query(`UPDATE incoming_referrals SET assigned_user_id = $1 WHERE id = 'ir_2'`, [CM]);
  assert.equal((await reviewAs(CM, id, "approve")).status, 200);
  const ok = await db.query<{ actor_id: string; action: string; entity_id: string; outcome: string; meta: any; at: Date }>(
    `SELECT actor_id, action, entity_id, outcome, meta, at FROM audit_logs WHERE entity_id = $1 AND action = 'ai.approve'`, [id]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].actor_id, CM);
  assert.equal(ok[0].outcome, "success");
  assert.equal(ok[0].meta.target, "referral");
  assert.ok(ok[0].at instanceof Date || typeof ok[0].at === "string");
  // route() records every denial as access.denied (actor, code, method, request path)
  const deniedByActor = await db.query<{ actor_id: string; meta: any }>(`SELECT actor_id, meta FROM audit_logs WHERE action = 'access.denied' AND actor_id IN ($1, $2)`, [DEMO_USERS.cmMaru, CM]);
  assert.ok(deniedByActor.length >= 2, "both denied attempts are audited");
  assert.ok(deniedByActor.some((r) => r.meta.code === "not_found") && deniedByActor.some((r) => r.meta.code === "forbidden"));
});

test("CSRF and authentication policy unchanged for review", async () => {
  const id = await newReferralDraft();
  assert.equal((await call(review.POST, { as: CM, params: { id }, body: { action: "approve" }, csrf: false })).status, 403);
  assert.equal((await call(review.POST, { params: { id }, body: { action: "approve" } })).status, 401);
  assert.equal(await statusOf(id), "draft");
});
