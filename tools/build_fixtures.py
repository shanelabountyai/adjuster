#!/usr/bin/env python3
"""Fixture ORACLE for Adjuster. Generates the frozen JSON fixtures under fixtures/.

This is NOT product code. It adjudicates the domain brief's claims with plain procedural Python and exact
rational arithmetic (fractions.Fraction), so the product can be tested against numbers it did not produce.
Do not import it from the product and do not port it line by line: write the product test-first against the
frozen fixtures. It deliberately does NOT read rules/*.json; tools/verify_fixtures.py does, as the second derivation.

Terms and rule behaviour are from docs/domain-brief.md (s1 plan terms, s3 rules E1-E23, s4 payout, s9 flags,
s11 golden claims) and docs/decisions.md (D1-D22, O1-O7 defaults). Stdlib only.
"""
import calendar, datetime as dt, json, os
from fractions import Fraction

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")

STAGES = ["intake", "contract_verification", "coverage_period", "peril_exclusions", "frequency_limits", "evidence",
          "red_flags", "valuation", "deductible_limits", "authority", "decision"]
SKIPPED_ON_DENY = ["evidence", "red_flags", "valuation", "deductible_limits", "authority"]

# domain brief s1. `freq` = (limit per rolling 12 months, whether only ADH claims count)
TIER = {
    "essential": dict(months=24, wait=30, perils=["breakdown"], ded={"breakdown": 5000, "adh": 5000}, pcl=50000, agg=100000, acv=True, freq=(2, False), fulfills=True),
    "plus": dict(months=36, wait=30, perils=["breakdown", "adh"], ded={"breakdown": 7500, "adh": 7500}, pcl=100000, agg=200000, acv=True, freq=(2, True), fulfills=True),
    "premier": dict(months=36, wait=14, perils=["breakdown", "adh", "battery_degradation"], ded={"breakdown": 2500, "adh": 9900}, pcl=200000, agg=400000, acv=False, freq=(3, True), fulfills=False),
}
DOC_OK = ("accepted", "waived")


def rhu(x: Fraction) -> int:
    """The ONE rounding rule (D16): round half up, to integer cents. Non-negative inputs only."""
    assert x >= 0
    return (2 * x.numerator + x.denominator) // (2 * x.denominator)


def add_months(d: dt.date, k: int) -> dt.date:
    y, m = divmod(d.month - 1 + k, 12)
    y, m = d.year + y, m + 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


D = dt.date.fromisoformat
iso = lambda d: d.isoformat()


def full_years(a: dt.date, b: dt.date) -> int:
    return b.year - a.year - ((b.month, b.day) < (a.month, a.day))


# ------------------------------------------------------------------ the adjudicator

def adjudicate(f):
    t = TIER[f["contract.planCode"]]
    start, end, dol, rep = D(f["contract.termStart"]), D(f["contract.termEnd"]), D(f["claim.dateOfLoss"]), D(f["claim.dateReported"])
    peril = f["claim.peril"]
    since, to_end, lag = (dol - start).days, (end - dol).days, (rep - dol).days
    prior = f["history.priorClaims"]

    def count(window, perils=None, same=False, paid_only=False):
        n = 0
        for p in prior:
            if not 0 <= (dol - D(p["dateOfLoss"])).days <= window: continue
            if perils and p["peril"] not in perils: continue
            if same and p["peril"] != peril: continue
            if paid_only and p["outcome"] not in ("APPROVE", "PARTIAL"): continue
            n += 1
        return n

    paid = sum(p["paidCents"] for p in prior)
    R_, C_ = f["claim.replacementValueCents"], f["claim.coveredRepairCents"]
    ratio = rhu(Fraction(C_ * 10000, R_))
    docs_ok = lambda k: f.get(f"docs.{k}") in DOC_OK
    out = []  # (stage, ruleId, result)

    def add(stage, rid, result): out.append((stage, rid, result))

    # ---- plan rules (class C), file order
    add("coverage_period", "E1", "PASS" if f["contract.status"] == "active" else "DENY")
    add("coverage_period", "E2", "PASS" if since >= 0 and to_end >= 0 else "DENY")
    add("coverage_period", "E3", "DENY" if 0 <= since < t["wait"] else "PASS")
    add("coverage_period", "E4", "REFER" if lag > 30 else "PASS")
    add("peril_exclusions", "E6", "PASS" if peril in t["perils"] else "DENY")
    add("peril_exclusions", "E7", "DENY" if f["claim.cosmeticOnly"] else "PASS")
    add("peril_exclusions", "E8", "REFER" if f["claim.preExisting"] else "PASS")
    if not f["claim.consumableOrAccessory"]: e9 = "PASS"
    elif f["contract.planCode"] == "premier" and peril == "battery_degradation" and f["claim.batteryCapacityPct"] < 80: e9 = "PASS"
    else: e9 = "DENY"
    add("peril_exclusions", "E9", e9)
    add("peril_exclusions", "E10", {"none": "PASS", "declared": "DENY", "suspected": "REFER"}[f["claim.unauthorizedRepair"]])
    add("peril_exclusions", "E11", "DENY" if f["claim.commercialUse"] else "PASS")
    add("peril_exclusions", "E12", "REFER" if f["claim.intentionalOrAbuse"] else "PASS")
    add("peril_exclusions", "E13", "DENY" if peril == "breakdown" and f["claim.inMfrWarrantyOrRecall"] else "PASS")
    add("peril_exclusions", "E14", "DENY" if f["claim.productUnavailable"] else "PASS")
    add("peril_exclusions", "E18", "DENY" if f["claim.softwareOrData"] else "PASS")
    add("peril_exclusions", "E19", "DENY" if f["claim.externalCause"] else "PASS")
    n, adh_only = t["freq"]
    if adh_only and peril != "adh": e15 = "PASS"
    else: e15 = "DENY" if count(365, perils=["adh"] if adh_only else None, paid_only=True) >= n else "PASS"
    add("frequency_limits", "E15", e15)
    add("frequency_limits", "E16", "DENY" if paid >= t["agg"] else "PASS")
    # ---- ops rules (class O), file order
    add("intake", "E17", "REFER" if count(7, same=True) > 0 else "PASS")
    add("contract_verification", "E5", "PASS" if f["claim.serialMatchesContract"] else "REFER")
    add("evidence", "E22", "PASS" if f["claim.claimantIsHolder"] or docs_ok("transferProof") else "PEND")
    add("evidence", "E20.proofOfPurchase", "PASS" if docs_ok("proofOfPurchase") else "PEND")
    add("evidence", "E20.repairEstimate", "PASS" if docs_ok("repairEstimate") else "PEND")
    add("evidence", "E20.damagePhotos", "PASS" if peril != "adh" or docs_ok("damagePhotos") else "PEND")
    add("evidence", "E20.incidentStatement", "PASS" if peril != "adh" or docs_ok("incidentStatement") else "PEND")
    add("evidence", "E21", "PASS" if f["evidence.estimateFromNetwork"] or docs_ok("secondEstimate") else "PEND")
    wait_end = (D(f["contract.waitingEndsOn"]) - dol).days  # F1 reads the date seeded on the contract
    flags = [
        ("F1", 0 <= -wait_end <= 7),
        ("F2", count(60) >= 1),
        ("F3", (dol - D(f["evidence.proofOfPurchaseDate"])).days < 0),
        ("F4", (start - D(f["product.purchaseDate"])).days > 30 and since < 60),  # PROVISIONAL 30 / 60
        ("F5", rhu(Fraction(C_ * 10000, t["pcl"])) >= 9500 or 6500 <= ratio <= 7000),  # PROVISIONAL band
        ("F6", f["history.claimantContractsWithClaims"] >= 3),
        ("F7", f["evidence.photoMetaDateBeforeLoss"] or f["evidence.documentHashOnOtherClaim"]),
        ("F8", not f["evidence.estimateFromNetwork"] and f["evidence.estimatorIsPayee"]),
        ("F9", 0 <= to_end <= 30),
        ("F10", f["claim.accountChanged"]),
    ]
    for rid, hit in flags: add("red_flags", rid, "REFER" if hit else "PASS")

    deny = any(r == "DENY" for _, _, r in out)  # auto_deny_enabled = true (O1 default)
    skipped = list(SKIPPED_ON_DENY) if deny else []
    out = [x for x in out if x[0] not in skipped]
    pend = any(r == "PEND" for _, _, r in out)

    valuation, payable, fulfilled = None, None, None
    if not deny and not pend:
        valuation, payable, after_ded, agg_after = valuate(f, t, C_, R_, ratio, paid, start, dol)
        fulfilled = (valuation["path"] == "replace" and t["fulfills"]) or agg_after <= 0
        add("authority", "E23", "REFER" if payable > 50000 else "PASS")
    out.sort(key=lambda x: STAGES.index(x[0]))  # stable: file order inside a stage

    if deny: outcome = "DENY"
    elif pend: outcome = "PEND"
    elif any(r == "REFER" for _, _, r in out): outcome = "REFER"
    else: outcome = "PARTIAL" if payable < after_ded else "APPROVE"
    key = {"DENY": "DENY", "PEND": "PEND", "REFER": "REFER"}.get(outcome)
    return {
        "outcome": outcome,
        "reasons": [rid for _, rid, r in out if r == key] if key else [],
        "payableCents": payable,
        "contractFulfilled": fulfilled,
        "skippedStages": skipped,
        "rules": [{"ruleId": rid, "result": r, "missing": []} for _, rid, r in out],
        "valuation": valuation,
    }


def valuate(f, t, C, R, ratio, paid, start, dol):
    """Domain brief s4, steps 1-9, emitting the calc-step trace in the same shape the engine must produce."""
    peril = f["claim.peril"]
    path = "replace" if ratio > 7000 else "repair"  # C > 70% of R; ratio is half-up bps (D16/D17), see the review's boundary note
    ret = 10000 if not t["acv"] else {0: 10000, 1: 8000, 2: 6000}.get(full_years(D(f["product.purchaseDate"]), dol), 4000)
    price, ded = f["product.purchasePriceCents"], t["ded"][peril]
    regs, steps = {}, []

    def step(sid, op, reg, applied, operand, fn):
        if not applied:
            steps.append(dict(id=sid, op=op, reg=reg, applied=False, operand=None, inputCents=None, outputCents=None)); return
        before = regs.get(reg)
        kind, name, value = operand
        regs[reg] = fn(before, value)
        steps.append(dict(id=sid, op=op, reg=reg, applied=True, operand=dict(kind=kind, name=name, value=value), inputCents=before, outputCents=regs[reg]))

    fact = lambda n, v: ("fact", n, v)
    step("c1", "start_from", "L", path == "repair", fact("claim.coveredRepairCents", C), lambda b, v: v)
    step("c2", "start_from", "L", path == "replace", fact("claim.replacementValueCents", R), lambda b, v: v)
    step("c3", "apply_bps", "L", path == "replace", fact("lookup.retentionBps", ret), lambda b, v: rhu(Fraction(b * v, 10000)))
    step("c4", "cap_at", "L", True, fact("product.purchasePriceCents", price), lambda b, v: min(b, v))
    step("c5", "subtract", "L", True, fact("lookup.deductibleCents", ded), lambda b, v: b - v)
    step("c6", "floor_at", "L", True, ("const", None, 0), lambda b, v: max(b, v))
    step("c7", "start_from", "DED", True, ("reg", "L", regs["L"]), lambda b, v: v)
    step("c8", "cap_at", "L", True, fact("lookup.perClaimLimitCents", t["pcl"]), lambda b, v: min(b, v))
    step("c9", "start_from", "AGG", True, fact("lookup.aggregateLimitCents", t["agg"]), lambda b, v: v)
    step("c10", "subtract", "AGG", True, fact("d.sumPriorPaid", paid), lambda b, v: b - v)
    step("c11", "floor_at", "AGG", True, ("const", None, 0), lambda b, v: max(b, v))
    step("c12", "cap_at", "L", True, ("reg", "AGG", regs["AGG"]), lambda b, v: min(b, v))
    step("c13", "start_from", "AFTER", True, ("reg", "AGG", regs["AGG"]), lambda b, v: v)
    step("c14", "subtract", "AFTER", True, ("reg", "L", regs["L"]), lambda b, v: b - v)
    return {"path": path, "steps": steps}, regs["L"], regs["DED"], regs["AFTER"]


# ------------------------------------------------------------------ claim facts

def facts(tier, *, dol=None, price, R, C, peril="breakdown", prior=(), purchase=None, start=dt.date(2025, 1, 15), **over):
    t = TIER[tier]
    purchase = purchase or start
    dol = dol or add_months(start, 8)
    end = add_months(start, t["months"]) - dt.timedelta(days=1)
    f = {
        "contract.planCode": tier, "contract.status": "active", "contract.termStart": iso(start), "contract.termEnd": iso(end),
        "contract.waitingEndsOn": iso(start + dt.timedelta(days=t["wait"])),
        "product.purchaseDate": iso(purchase), "product.purchasePriceCents": price,
        "claim.peril": peril, "claim.dateOfLoss": iso(dol), "claim.dateReported": iso(dol + dt.timedelta(days=2)),
        "claim.cosmeticOnly": False, "claim.preExisting": False, "claim.consumableOrAccessory": False,
        "claim.unauthorizedRepair": "none", "claim.commercialUse": False, "claim.intentionalOrAbuse": False,
        "claim.inMfrWarrantyOrRecall": False, "claim.productUnavailable": False, "claim.softwareOrData": False,
        "claim.externalCause": False, "claim.serialMatchesContract": True, "claim.claimantIsHolder": True, "claim.accountChanged": False,
        "claim.coveredRepairCents": C, "claim.replacementValueCents": R,
        "history.priorClaims": list(prior), "history.claimantContractsWithClaims": 1,
        "evidence.estimateFromNetwork": True, "evidence.estimatorIsPayee": False, "evidence.proofOfPurchaseDate": iso(purchase),
        "evidence.photoMetaDateBeforeLoss": False, "evidence.documentHashOnOtherClaim": False,
        "docs.proofOfPurchase": "accepted", "docs.repairEstimate": "accepted", "docs.damagePhotos": "accepted", "docs.incidentStatement": "accepted",
    }
    f.update(over)
    return f


def prior(cid, dol, peril, paid, outcome="APPROVE"):
    return dict(claimId=cid, dateOfLoss=iso(dol), peril=peril, outcome=outcome, paidCents=paid)


def decision_fixture(fid, title, source, f, note=None):
    asof = D(f["claim.dateOfLoss"]) + dt.timedelta(days=3)
    doc = {"id": fid, "kind": "decision", "title": title, "source": source, "asOf": iso(asof), "plan": "plan-v1", "ops": "ops-v1", "facts": f, "expected": adjudicate(f)}
    if note: doc["note"] = note
    return doc


def write(sub, doc):
    os.makedirs(os.path.join(ROOT, sub), exist_ok=True)
    with open(os.path.join(ROOT, sub, doc["id"] + ".json"), "w") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write("\n")


# ------------------------------------------------------------------ GC and PAY

def build_gc():
    s = dt.date(2025, 1, 15)
    gcs = []
    gcs.append(("GC-01", "Essential washer motor fails month 8; repair 30000; documents complete", "domain brief s11",
                facts("essential", price=90000, R=60000, C=30000)))
    gcs.append(("GC-02", "Essential cracked phone screen (ADH on a breakdown-only plan)", "domain brief s11",
                facts("essential", price=60000, R=60000, C=25000, peril="adh")))
    gcs.append(("GC-03", "Plus laptop failure on day 12 (waiting period)", "domain brief s11",
                facts("plus", dol=s + dt.timedelta(days=12), price=120000, R=110000, C=30000)))
    end = add_months(s, 36) - dt.timedelta(days=1)
    gcs.append(("GC-04", "Plus loss 10 days after term end; scratches only", "domain brief s11",
                facts("plus", dol=end + dt.timedelta(days=10), price=80000, R=70000, C=5000, peril="adh", **{"claim.cosmeticOnly": True})))
    gcs.append(("GC-05", "Premier TV, PAY-B: replace threshold, above the auto-approve limit", "domain brief s11 / PAY-B",
                facts("premier", price=90000, R=80000, C=60000)))
    gcs.append(("GC-06", "Essential, PAY-C: below the deductible, approved at 0", "domain brief s11 / PAY-C",
                facts("essential", price=60000, R=60000, C=4000)))
    d7 = add_months(s, 8)
    gcs.append(("GC-07", "Plus, PAY-D: aggregate remaining 30000 caps the payment", "domain brief s11 / PAY-D",
                facts("plus", price=150000, R=140000, C=60000, prior=[prior("GC-07-P1", d7 - dt.timedelta(days=200), "breakdown", 170000)])))
    p8 = dt.date(2023, 6, 10)
    gcs.append(("GC-08", "Plus, PAY-E: replace on an ACV plan, two years of depreciation", "domain brief s11 / PAY-E",
                facts("plus", start=p8, dol=dt.date(2025, 7, 15), price=80000, R=90000, C=70000)))
    d9 = add_months(s, 8)
    gcs.append(("GC-09", "Plus third ADH claim in 12 months", "domain brief s11",
                facts("plus", price=80000, R=70000, C=20000, peril="adh",
                      prior=[prior("GC-09-P1", d9 - dt.timedelta(days=100), "adh", 5000), prior("GC-09-P2", d9 - dt.timedelta(days=200), "adh", 5000)])))
    gcs.append(("GC-10", "Premier, estimate serial differs from the contract serial", "domain brief s11",
                facts("premier", price=90000, R=80000, C=40000, **{"claim.serialMatchesContract": False})))
    for gid, title, src, f in gcs:
        write("gc", decision_fixture(gid, title, src, f))


def build_pay():
    base = dict(start=dt.date(2025, 1, 15), dol=dt.date(2025, 9, 15))
    cases = [
        ("PAY-A", "plus", "repair", dict(price=120000, R=110000, C=30000)),
        ("PAY-B", "premier", "replace", dict(price=90000, R=80000, C=60000)),
        ("PAY-C", "essential", "below deductible", dict(price=60000, R=60000, C=4000)),
        ("PAY-D", "plus", "aggregate", dict(price=150000, R=140000, C=60000, prior=[prior("PAY-D-P1", dt.date(2025, 2, 1), "breakdown", 170000)])),
        ("PAY-E", "plus", "depreciation", dict(price=80000, R=90000, C=70000, start=dt.date(2023, 6, 10), dol=dt.date(2025, 7, 15))),
        ("PAY-F", "premier", "price cap", dict(price=100000, R=130000, C=130000, peril="adh")),
        ("PAY-G", "essential", "per-claim cap", dict(price=120000, R=100000, C=62000)),
    ]
    for pid, tier, what, kw in cases:
        f = facts(tier, **{**base, **kw})
        e = adjudicate(f)
        v = e["valuation"]
        write("pay", {
            "id": pid, "kind": "valuation", "title": f"{tier.capitalize()} {what}", "source": "domain brief s4",
            "note": "Valuation-level: the calc-step evaluator runs plan-v1 payout against these facts. Facts the brief does not state are filled in so eligibility is clean."
                    + (" PAY-F: the brief says 'total loss' without a repair figure; C is set equal to R." if pid == "PAY-F" else ""),
            "facts": f,
            "expected": {"path": v["path"], "steps": v["steps"], "payableCents": e["payableCents"], "contractFulfilled": e["contractFulfilled"]},
        })
    write("pay", {"id": "PAY-H", "kind": "ref", "title": "Essential denial: valuation does not run, amount is null (not 0)", "source": "domain brief s4",
                  "ref": "GC-02", "expected": {"payableCents": None, "valuation": None, "outcome": "DENY"}})


# ------------------------------------------------------------------ RE: evaluator-level fixtures (RE-01..RE-23)
# The brief and PRD name these ids but never define them; this mapping is a PROPOSAL (see docs/phase-1-review.md).
# Expected values below are written by hand from the three-valued semantics, not computed.

def cond(fid, title, cell, cases, ids=None):
    return {"id": fid, "kind": "condition", "title": title, "source": "PRD P0-1", "dictionary": "rules/electronics/facts-v1.json", "cell": cell,
            "cases": [{"facts": c[0], "expected": c[1]} for c in cases]}


def minimal_ops(cell=None, rules=None):
    cell = cell or {"fact": "claim.peril", "op": "eq", "value": "adh"}
    return {"schema": "adjuster.ruleset/1", "kind": "ops", "product": "electronics", "version": 1, "effectiveFrom": "2025-01-01",
            "factDictionary": "facts-v1", "roundingMode": "half_up",
            "rules": rules or [{"id": "E5", "name": "t", "class": "O", "stage": "contract_verification", "kind": "eligibility",
                                "rows": [{"id": "E5.pass", "when": [cell], "then": {"outcome": "PASS"}}]}]}


def calc_fx(fid, title, facts_, steps, expected_steps, final):
    return {"id": fid, "kind": "calc", "title": title, "source": "PRD P0-1", "facts": facts_, "steps": steps,
            "expected": {"steps": expected_steps, "registers": final}}


def build_re():
    U, T, F = "UNKNOWN", "TRUE", "FALSE"
    peril = lambda v: {"claim.peril": v}
    pct = lambda v: {"claim.batteryCapacityPct": v}
    dol = lambda v: {"claim.dateOfLoss": v}
    res = [
        cond("RE-01", "eq", {"fact": "claim.peril", "op": "eq", "value": "adh"}, [(peril("adh"), T), (peril("breakdown"), F)]),
        cond("RE-02", "neq", {"fact": "claim.peril", "op": "neq", "value": "adh"}, [(peril("breakdown"), T), (peril("adh"), F)]),
        cond("RE-03", "lt (integer and date)", {"fact": "claim.batteryCapacityPct", "op": "lt", "value": 80}, [(pct(79), T), (pct(80), F), (pct(81), F)]),
        cond("RE-04", "lte", {"fact": "claim.batteryCapacityPct", "op": "lte", "value": 80}, [(pct(79), T), (pct(80), T), (pct(81), F)]),
        cond("RE-05", "gt", {"fact": "claim.batteryCapacityPct", "op": "gt", "value": 80}, [(pct(81), T), (pct(80), F), (pct(79), F)]),
        cond("RE-06", "gte", {"fact": "claim.batteryCapacityPct", "op": "gte", "value": 80}, [(pct(80), T), (pct(81), T), (pct(79), F)]),
        cond("RE-07", "in", {"fact": "claim.peril", "op": "in", "value": ["breakdown", "adh"]}, [(peril("adh"), T), (peril("breakdown"), T), (peril("other"), F)]),
        cond("RE-08", "not_in", {"fact": "claim.peril", "op": "not_in", "value": ["breakdown", "adh"]}, [(peril("other"), T), (peril("adh"), F)]),
        cond("RE-09", "between is inclusive at both ends", {"fact": "claim.batteryCapacityPct", "op": "between", "value": [70, 80]},
             [(pct(70), T), (pct(75), T), (pct(80), T), (pct(69), F), (pct(81), F)]),
        cond("RE-10", "is_known: present is TRUE, missing is FALSE, never UNKNOWN", {"fact": "claim.batteryCapacityPct", "op": "is_known"}, [(pct(0), T), ({}, F)]),
    ]
    # date ordering rides along on RE-03
    res[2]["cases"] += [{"facts": dol("2025-05-31"), "expected": T, "cell": {"fact": "claim.dateOfLoss", "op": "lt", "value": "2025-06-01"}},
                        {"facts": dol("2025-06-01"), "expected": F, "cell": {"fact": "claim.dateOfLoss", "op": "lt", "value": "2025-06-01"}}]
    res.append({"id": "RE-11", "kind": "validate", "title": "Unknown operator and unknown calc step fail validation", "source": "PRD P0-1", "dictionary": "rules/electronics/facts-v1.json",
                "cases": [
                    {"name": "operator 'contains'", "ruleSet": minimal_ops({"fact": "claim.peril", "op": "contains", "value": "adh"}), "expectedCodes": ["UNKNOWN_OPERATOR"]},
                    {"name": "calc step 'multiply'", "ruleSet": {**minimal_ops(), "kind": "plan", "payout": {"steps": [{"id": "c1", "op": "multiply", "operand": {"const": 2}}], "outputs": {"payableCents": "L"}}}, "expectedCodes": ["UNKNOWN_CALC_STEP"]},
                ]})
    res.append({"id": "RE-12", "kind": "validate", "title": "Unknown fact and type mismatch fail validation", "source": "PRD P0-1", "dictionary": "rules/electronics/facts-v1.json",
                "cases": [
                    {"name": "unknown fact", "ruleSet": minimal_ops({"fact": "claim.colour", "op": "eq", "value": "red"}), "expectedCodes": ["UNKNOWN_FACT"]},
                    {"name": "lt on an enum fact", "ruleSet": minimal_ops({"fact": "claim.peril", "op": "lt", "value": "adh"}), "expectedCodes": ["TYPE_MISMATCH"]},
                    {"name": "number compared to an enum fact", "ruleSet": minimal_ops({"fact": "claim.peril", "op": "eq", "value": 5}), "expectedCodes": ["TYPE_MISMATCH"]},
                    {"name": "value outside the enum", "ruleSet": minimal_ops({"fact": "claim.peril", "op": "eq", "value": "theft"}), "expectedCodes": ["TYPE_MISMATCH"]},
                    {"name": "between with low > high", "ruleSet": minimal_ops({"fact": "claim.batteryCapacityPct", "op": "between", "value": [80, 70]}), "expectedCodes": ["TYPE_MISMATCH"]},
                ]})

    L = lambda *steps: list(steps)
    st = lambda sid, op, operand, reg="L": {"id": sid, "op": op, "reg": reg, "operand": operand} if op != "min_of" else {"id": sid, "op": op, "reg": reg, "operands": operand}
    tr = lambda sid, op, reg, kind, name, val, i, o: dict(id=sid, op=op, reg=reg, applied=True, operand=dict(kind=kind, name=name, value=val), inputCents=i, outputCents=o)
    cf, pc = "claim.coveredRepairCents", "product.purchasePriceCents"
    res += [
        calc_fx("RE-13", "start_from: from a fact, from a constant", {cf: 12345},
                [st("a", "start_from", {"fact": cf}), st("b", "start_from", {"const": 700}, "X")],
                [tr("a", "start_from", "L", "fact", cf, 12345, None, 12345), tr("b", "start_from", "X", "const", None, 700, None, 700)], {"L": 12345, "X": 700}),
        calc_fx("RE-14", "subtract: no implicit floor, the result may go negative", {cf: 1000, pc: 2500},
                [st("a", "start_from", {"fact": cf}), st("b", "subtract", {"fact": pc})],
                [tr("a", "start_from", "L", "fact", cf, 1000, None, 1000), tr("b", "subtract", "L", "fact", pc, 2500, 1000, -1500)], {"L": -1500}),
        calc_fx("RE-15", "apply_bps: half up at exactly .5, below .5 rounds down", {cf: 5},
                [st("a", "start_from", {"fact": cf}), st("b", "apply_bps", {"const": 5000}),
                 st("c", "start_from", {"const": 3}, "Y"), st("d", "apply_bps", {"const": 5000}, "Y"),
                 st("e", "start_from", {"const": 1}, "Z"), st("f", "apply_bps", {"const": 4999}, "Z")],
                [tr("a", "start_from", "L", "fact", cf, 5, None, 5), tr("b", "apply_bps", "L", "const", None, 5000, 5, 3),
                 tr("c", "start_from", "Y", "const", None, 3, None, 3), tr("d", "apply_bps", "Y", "const", None, 5000, 3, 2),
                 tr("e", "start_from", "Z", "const", None, 1, None, 1), tr("f", "apply_bps", "Z", "const", None, 4999, 1, 0)], {"L": 3, "Y": 2, "Z": 0}),
        calc_fx("RE-16", "cap_at lowers a larger value and leaves a smaller one", {cf: 9000, pc: 5000},
                [st("a", "start_from", {"fact": cf}), st("b", "cap_at", {"fact": pc}), st("c", "start_from", {"const": 3000}, "Y"), st("d", "cap_at", {"fact": pc}, "Y")],
                [tr("a", "start_from", "L", "fact", cf, 9000, None, 9000), tr("b", "cap_at", "L", "fact", pc, 5000, 9000, 5000),
                 tr("c", "start_from", "Y", "const", None, 3000, None, 3000), tr("d", "cap_at", "Y", "fact", pc, 5000, 3000, 3000)], {"L": 5000, "Y": 3000}),
        calc_fx("RE-17", "floor_at raises a negative value to 0 and leaves a positive one", {cf: 700},
                [st("a", "start_from", {"const": -1500}), st("b", "floor_at", {"const": 0}), st("c", "start_from", {"fact": cf}, "Y"), st("d", "floor_at", {"const": 0}, "Y")],
                [tr("a", "start_from", "L", "const", None, -1500, None, -1500), tr("b", "floor_at", "L", "const", None, 0, -1500, 0),
                 tr("c", "start_from", "Y", "fact", cf, 700, None, 700), tr("d", "floor_at", "Y", "const", None, 0, 700, 700)], {"L": 0, "Y": 700}),
        calc_fx("RE-18", "min_of: the smallest of two or more operands, ignoring the register's old value", {cf: 8000, pc: 7000},
                [st("a", "start_from", {"const": 1}), st("b", "min_of", [{"fact": cf}, {"const": 6000}, {"fact": pc}])],
                [tr("a", "start_from", "L", "const", None, 1, None, 1), dict(id="b", op="min_of", reg="L", applied=True, operand=None, inputCents=1, outputCents=6000)], {"L": 6000}),
    ]
    ops_list = [("eq", "adh"), ("neq", "adh"), ("lt", 80), ("lte", 80), ("gt", 80), ("gte", 80), ("in", ["adh"]), ("not_in", ["adh"]), ("between", [70, 80])]
    unk = []
    for op, v in ops_list:
        fid = "claim.peril" if op in ("eq", "neq", "in", "not_in") else "claim.batteryCapacityPct"
        unk.append({"cell": {"fact": fid, "op": op, "value": v}, "facts": {}, "expected": U})
    unk.append({"cell": {"fact": "claim.batteryCapacityPct", "op": "is_known"}, "facts": {}, "expected": F})
    res.append({"id": "RE-19", "kind": "condition-list", "title": "A missing fact makes every operator UNKNOWN, except is_known which is FALSE", "source": "PRD P0-1 / D9", "cases": unk})
    A, B = {"fact": "claim.peril", "op": "eq", "value": "adh"}, {"fact": "claim.batteryCapacityPct", "op": "lt", "value": 80}
    res.append({"id": "RE-20", "kind": "row", "title": "Row AND is Kleene: FALSE beats UNKNOWN, TRUE with UNKNOWN stays UNKNOWN", "source": "D9", "when": [A, B],
                "cases": [{"facts": {**peril("adh"), **pct(70)}, "expected": T}, {"facts": {**peril("adh"), **pct(90)}, "expected": F},
                          {"facts": peril("adh"), "expected": U}, {"facts": peril("breakdown"), "expected": F}, {"facts": {}, "expected": U}]})
    res.append({"id": "RE-21", "kind": "condition-list", "title": "Unknown is never false: neq and not_in over a missing fact are UNKNOWN, not TRUE", "source": "D9",
                "cases": [{"cell": {"fact": "claim.peril", "op": "neq", "value": "adh"}, "facts": {}, "expected": U},
                          {"cell": {"fact": "claim.peril", "op": "not_in", "value": ["adh"]}, "facts": {}, "expected": U},
                          {"cell": {"fact": "claim.peril", "op": "neq", "value": "adh"}, "facts": peril("breakdown"), "expected": T}]})
    rule2 = {"id": "E7", "rows": [
        {"id": "r.deny", "when": [{"fact": "claim.cosmeticOnly", "op": "eq", "value": True}], "then": {"outcome": "DENY"}},
        {"id": "r.pass", "when": [{"fact": "claim.cosmeticOnly", "op": "eq", "value": False}], "then": {"outcome": "PASS"}}]}
    rule3 = {"id": "E9", "rows": [
        {"id": "r.a", "when": [{"fact": "claim.cosmeticOnly", "op": "eq", "value": True}, {"fact": "claim.batteryCapacityPct", "op": "lt", "value": 80}], "then": {"outcome": "DENY"}},
        {"id": "r.b", "when": [{"fact": "claim.preExisting", "op": "eq", "value": True}], "then": {"outcome": "REFER"}},
        {"id": "r.c", "when": [{"fact": "claim.cosmeticOnly", "op": "eq", "value": False}], "then": {"outcome": "PASS"}}]}
    res.append({"id": "RE-22", "kind": "rule", "title": "A rule with no TRUE row and an UNKNOWN row is PEND naming the missing facts; a TRUE row outranks UNKNOWN rows", "source": "D8 / D9", "cases": [
        {"rule": rule2, "facts": {}, "expected": {"result": "PEND", "hits": [], "missing": ["claim.cosmeticOnly"]}},
        {"rule": rule2, "facts": {"claim.cosmeticOnly": True}, "expected": {"result": "DENY", "hits": ["r.deny"], "missing": []}},
        {"rule": rule3, "facts": {"claim.cosmeticOnly": True}, "expected": {"result": "PEND", "hits": [], "missing": ["claim.batteryCapacityPct", "claim.preExisting"]}},
        {"rule": rule3, "facts": {"claim.cosmeticOnly": True, "claim.preExisting": True}, "expected": {"result": "REFER", "hits": ["r.b"], "missing": []}},
    ]})
    gap = {"id": "E6", "rows": [{"id": "g.a", "when": [{"fact": "claim.peril", "op": "eq", "value": "breakdown"}], "then": {"outcome": "PASS"}}]}
    res.append({"id": "RE-23", "kind": "rule", "title": "No row matches: GAP (REFER / RULE_GAP). Nothing defaults to approve", "source": "D10", "cases": [
        {"rule": gap, "facts": {"claim.peril": "adh"}, "expected": {"result": "GAP", "hits": [], "missing": []}},
        {"rule": gap, "facts": {"claim.peril": "breakdown"}, "expected": {"result": "PASS", "hits": ["g.a"], "missing": []}}]})
    for r in res: write("re", r)


if __name__ == "__main__":
    build_re(); build_pay(); build_gc()
    print("fixtures written to", os.path.normpath(ROOT))
