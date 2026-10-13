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

# D35: the second versions, one change each. Plan by the contract's pin; ops by asOf (D3).
PLANS = {"plan-v1": dict(effective=dt.date(2025, 1, 1), tiers=TIER),
         "plan-v2": dict(effective=dt.date(2026, 1, 1), tiers={**TIER, "essential": {**TIER["essential"], "ded": {"breakdown": 10000, "adh": 10000}}})}
OPS = {"ops-v1": dict(effective=dt.date(2025, 1, 1), auto_limit=50000),
       "ops-v2": dict(effective=dt.date(2026, 4, 1), auto_limit=75000),
       "ops-v3": dict(effective=dt.date(2026, 10, 13), auto_limit=75000)}  # D68: the senior tier gains author_rules, nothing else


def select_ops(asof, versions=None):
    """Latest published ops with effectiveFrom <= asOf (inclusive); a draft is never selected. None = no effective version."""
    versions = versions or [dict(name=n, kind="ops", status="published", effectiveFrom=iso(o["effective"])) for n, o in OPS.items()]
    ok = [v for v in versions if v["kind"] == "ops" and v["status"] == "published" and D(v["effectiveFrom"]) <= asof]
    return max(ok, key=lambda v: v["effectiveFrom"])["name"] if ok else None


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

def adjudicate(f, plan="plan-v1", ops="ops-v1"):
    plan, ops = (PLANS[plan] if isinstance(plan, str) else plan), (OPS[ops] if isinstance(ops, str) else ops)  # a name, or a draft's own terms (ID-xx)
    t = plan["tiers"][f["contract.planCode"]]
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
    R_, C_ = f["claim.replacementValueCents"], f.get("claim.coveredRepairCents")
    ratio = None if C_ is None else rhu(Fraction(C_ * 10000, R_))
    docs_ok = lambda k: f.get(f"docs.{k}") in DOC_OK
    out = []  # (stage, ruleId, result, missing)

    def add(stage, rid, result, missing=()): out.append((stage, rid, result, list(missing)))

    def tri(stage, rid, hit, names, yes="REFER"):
        """hit is True, False or None. None = a fact no document has supplied yet: PEND naming the unknown ones (D9, D51)."""
        add(stage, rid, "PEND" if hit is None else yes if hit else "PASS", sorted(n for n in names if f.get(n) is None) if hit is None else [])

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
    serial = f.get("claim.serialMatchesContract")
    tri("contract_verification", "E5", None if serial is None else not serial, ["claim.serialMatchesContract"])
    add("evidence", "E22", "PASS" if f["claim.claimantIsHolder"] or docs_ok("transferProof") else "PEND")
    add("evidence", "E20.proofOfPurchase", "PASS" if docs_ok("proofOfPurchase") else "PEND")
    add("evidence", "E20.repairEstimate", "PASS" if docs_ok("repairEstimate") else "PEND")
    add("evidence", "E20.damagePhotos", "PASS" if peril != "adh" or docs_ok("damagePhotos") else "PEND")
    add("evidence", "E20.incidentStatement", "PASS" if peril != "adh" or docs_ok("incidentStatement") else "PEND")
    net, payee = f.get("evidence.estimateFromNetwork"), f.get("evidence.estimatorIsPayee")
    tri("evidence", "E21", None if net is None else not (net or docs_ok("secondEstimate")), ["evidence.estimateFromNetwork"], yes="PEND")
    wait_end = (D(f["contract.waitingEndsOn"]) - dol).days  # F1 reads the date seeded on the contract
    pop, photo, dup = f.get("evidence.proofOfPurchaseDate"), f.get("evidence.photoMetaDateBeforeLoss"), f.get("evidence.documentHashOnOtherClaim")
    flags = [
        ("F1", 0 <= -wait_end <= 7, []),
        ("F2", count(60) >= 1, []),
        ("F3", None if pop is None else (dol - D(pop)).days < 0, ["evidence.proofOfPurchaseDate"]),
        ("F4", (start - D(f["product.purchaseDate"])).days > 30 and since < 60, []),  # PROVISIONAL 30 / 60
        ("F5", None if C_ is None else 9500 <= rhu(Fraction(C_ * 10000, t["pcl"])) < 10000 or 6500 <= ratio <= 7000,  # PROVISIONAL band; D25: below the limit only
         ["claim.coveredRepairCents"]),
        ("F6", f["history.claimantContractsWithClaims"] >= 3, []),
        # one known hit decides; otherwise every part must be known to clear
        ("F7", True if True in (photo, dup) else None if None in (photo, dup) else False, ["evidence.photoMetaDateBeforeLoss", "evidence.documentHashOnOtherClaim"]),
        ("F8", True if (net is False and payee is True) else False if (net is True or payee is False) else None, ["evidence.estimateFromNetwork", "evidence.estimatorIsPayee"]),
        ("F9", 0 <= to_end <= 30, []),
        ("F10", f.get("claim.accountChanged"), ["claim.accountChanged"]),
    ]
    for rid, hit, names in flags: tri("red_flags", rid, hit, names)

    deny = any(x[2] == "DENY" for x in out)  # auto_deny_enabled = true (O1 default)
    skipped = list(SKIPPED_ON_DENY) if deny else []
    out = [x for x in out if x[0] not in skipped]
    pend = any(x[2] == "PEND" for x in out)

    valuation, payable, fulfilled = None, None, None
    if not deny and not pend:
        valuation, payable, after_ded, agg_after = valuate(f, t, C_, R_, ratio, paid, start, dol)
        fulfilled = (valuation["path"] == "replace" and t["fulfills"]) or agg_after <= 0
        add("authority", "E23", "REFER" if payable > ops["auto_limit"] else "PASS")
    out.sort(key=lambda x: STAGES.index(x[0]))  # stable: file order inside a stage

    if deny: outcome = "DENY"
    elif pend: outcome = "PEND"
    elif any(x[2] == "REFER" for x in out): outcome = "REFER"
    else: outcome = "PARTIAL" if payable < after_ded else "APPROVE"
    key = {"DENY": "DENY", "PEND": "PEND", "REFER": "REFER"}.get(outcome)
    return {
        "outcome": outcome,
        "reasons": [rid for _, rid, r, _ in out if r == key] if key else [],
        "payableCents": payable,
        "contractFulfilled": fulfilled,
        "skippedStages": skipped,
        "rules": [{"ruleId": rid, "result": r, "missing": m} for _, rid, r, m in out],
        "valuation": valuation,
    }


def valuate(f, t, C, R, ratio, paid, start, dol):
    """Domain brief s4, steps 1-9, emitting the calc-step trace in the same shape the engine must produce."""
    peril = f["claim.peril"]
    path = "replace" if C * 10000 > 7000 * R else "repair"  # C > 70% of R, exact cross-multiplication (D26)
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


def decision_fixture(fid, title, source, f, note=None, plan="plan-v1"):
    asof = D(f["claim.dateOfLoss"]) + dt.timedelta(days=3)
    ops = select_ops(asof)
    doc = {"id": fid, "kind": "decision", "title": title, "source": source, "asOf": iso(asof), "plan": plan, "ops": ops, "facts": f, "expected": adjudicate(f, plan, ops)}
    if note: doc["note"] = note
    return doc


def write(sub, doc):
    os.makedirs(os.path.join(ROOT, sub), exist_ok=True)
    with open(os.path.join(ROOT, sub, doc["id"] + ".json"), "w") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write("\n")


# ------------------------------------------------------------------ GC and PAY

def golden():
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
    d12 = s + dt.timedelta(days=16)
    gcs.append(("GC-12", "Premier, receipt dated after the date of loss; loss on day 16, two days after the waiting period", "domain brief s11",
                facts("premier", dol=d12, price=90000, R=80000, C=40000, **{"evidence.proofOfPurchaseDate": iso(d12 + dt.timedelta(days=1))})))
    gcs.append(("GC-13", "Essential, PAY-G: the per-claim limit caps the payment (no F5 at or over the limit, D25)", "domain brief s11 / PAY-G",
                facts("essential", price=120000, R=100000, C=62000)))
    gcs.append(("GC-14", "Essential, declared prior third-party repair and used in a cafe", "domain brief s11",
                facts("essential", price=60000, R=60000, C=20000, **{"claim.unauthorizedRepair": "declared", "claim.commercialUse": True})))
    return gcs


def build_gc():
    for gid, title, src, f in golden():
        write("gc", decision_fixture(gid, title, src, f))


# PL-01 (D38): domain brief s7's status line as a table. A third element names what the claim's current decision must be.
PRE = ["OPEN", "PENDING_EVIDENCE", "IN_REVIEW", "REFERRED"]
EDGES = [("OPEN", "PENDING_EVIDENCE"), ("OPEN", "IN_REVIEW"), ("PENDING_EVIDENCE", "IN_REVIEW"), ("IN_REVIEW", "PENDING_EVIDENCE"),
         ("IN_REVIEW", "REFERRED"), ("IN_REVIEW", "DECIDED"), ("REFERRED", "DECIDED"), ("REFERRED", "PENDING_EVIDENCE"),
         ("PENDING_EVIDENCE", "CLOSED_NO_RESPONSE")] + [(s, "WITHDRAWN") for s in PRE] + [
         ("DECIDED", "PAYMENT_PENDING", "payable"), ("DECIDED", "UNDER_APPEAL", "denied"), ("DECIDED", "CLOSED", "denied_or_zero"),
         ("UNDER_APPEAL", "DECIDED"), ("PAYMENT_PENDING", "PAID"), ("PAID", "CLOSED"),
         ("CLOSED", "REOPENED"), ("CLOSED_NO_RESPONSE", "REOPENED"), ("REOPENED", "IN_REVIEW")]
STATUS_FOR = {"APPROVE": "DECIDED", "PARTIAL": "DECIDED", "DENY": "DECIDED", "PEND": "PENDING_EVIDENCE", "REFER": "REFERRED"}


# ------------------------------------------------------------------ Phase 2: RV, VP, PL (D35)

def build_phase2():
    dol = dt.date(2026, 8, 3)
    cases = []
    for plan, start in (("plan-v1", dt.date(2025, 12, 1)), ("plan-v2", dt.date(2026, 2, 1))):
        doc = decision_fixture(None, None, None, facts("essential", start=start, dol=dol, price=90000, R=60000, C=30000), plan=plan)
        cases.append({"contract": f"sold {iso(start)}, pins {plan}", **{k: doc[k] for k in ("asOf", "plan", "ops", "facts", "expected")}})
    write("rv", {"id": "RV-01", "kind": "rule-version", "title": "The same loss under a contract sold before plan-v2 and one sold after: each keeps the terms it bought",
                 "source": "PRD P0-2 / D3 / D35", "note": "GC-01's claim. Only the contract (dates, pin) differs; plan-v2 raised the Essential deductible.",
                 "cases": cases})

    versions = [dict(name=n, kind="plan", status="published", effectiveFrom=iso(p["effective"])) for n, p in PLANS.items()] + \
               [dict(name=n, kind="ops", status="published", effectiveFrom=iso(o["effective"])) for n, o in OPS.items()] + \
               [dict(name="ops-v4", kind="ops", status="draft", effectiveFrom="2026-12-01")]

    def select(pin, asof, vs):
        if D(next(v for v in vs if v["name"] == pin)["effectiveFrom"]) > asof: return {"error": "NO_EFFECTIVE_VERSION", "kind": "plan"}
        o = select_ops(asof, vs)
        return {"plan": pin, "ops": o} if o else {"error": "NO_EFFECTIVE_VERSION", "kind": "ops"}

    def case(name, pin, dol, asof, vs=None):
        c = {"name": name, "contract": {"planVersion": pin}, "dateOfLoss": dol, "dateReported": iso(D(dol) + dt.timedelta(days=2)), "asOf": asof}
        if vs: c["versions"] = vs
        c["expected"] = select(pin, D(asof), vs or versions)
        return c

    vp = [
        ("VP-02", "The plan comes from the contract's pin, never the date of loss, the date reported or the latest version", [
            case("v1 contract, everything after plan-v2's effective date", "plan-v1", "2026-08-03", "2026-08-06"),
            case("v2 contract", "plan-v2", "2026-08-03", "2026-08-06")]),
        ("VP-03", "Ops is the latest published version effective on asOf (inclusive), never by date of loss; a draft is never selected", [
            case("day before ops-v2", "plan-v1", "2026-03-20", "2026-03-31"),
            case("ops-v2's effective date, loss before it", "plan-v1", "2026-03-20", "2026-04-01"),
            case("after the draft ops-v4's date", "plan-v1", "2026-03-20", "2027-01-01")]),
        ("VP-04", "No effective version: no decision, a coded error naming the kind", [
            case("pinned plan not yet effective on asOf", "plan-v2", "2025-12-20", "2025-12-31"),
            case("only a draft ops exists", "plan-v1", "2025-06-01", "2025-06-04",
                 vs=[v for v in versions if v["kind"] == "plan" or v["status"] == "draft"])]),
    ]
    for fid, title, cs in vp:
        write("vp", {"id": fid, "kind": "selection", "title": title, "source": "PRD P0-2 / D3 / D35", "versions": versions, "cases": cs})

    claim = {k: v for k, v in facts("essential", price=90000, R=60000, C=30000).items() if k.startswith("claim.")}
    write("pl", {"id": "PL-06", "kind": "pipeline", "title": "Contract not found short-circuits: no rule runs, no decision row, the claim is referred",
                 "source": "domain brief s2 / D12 / D35", "contracts": ["CT-0001"], "claim": {"contractId": "CT-0404", "facts": claim},
                 "expected": {"error": "CONTRACT_NOT_FOUND", "decision": None, "claimStatus": "REFERRED", "rulesRun": []}})

    pre, edges = PRE, EDGES
    gcase = lambda name, decision, legal: {"name": name, "from": "DECIDED", "decision": decision, "legal": legal}
    write("pl", {"id": "PL-01", "kind": "transitions", "title": "Claim status moves only along the table; anything else throws",
                 "source": "domain brief s7 / D38",
                 "statuses": pre + ["DECIDED", "PAYMENT_PENDING", "PAID", "CLOSED", "CLOSED_NO_RESPONSE", "WITHDRAWN", "UNDER_APPEAL", "REOPENED"],
                 "transitions": [{"from": e[0], "to": e[1], **({"when": e[2]} if len(e) > 2 else {})} for e in edges],
                 "guardCases": [
                     gcase("denied", {"outcome": "DENY", "payableCents": None}, ["CLOSED", "UNDER_APPEAL"]),
                     gcase("approved at 0", {"outcome": "APPROVE", "payableCents": 0}, ["CLOSED"]),
                     gcase("approved with an amount", {"outcome": "APPROVE", "payableCents": 25000}, ["PAYMENT_PENDING"]),
                     gcase("partial with an amount", {"outcome": "PARTIAL", "payableCents": 50000}, ["PAYMENT_PENDING"]),
                     # D61: the guards read what the claim has been paid (absent = 0)
                     gcase("supplemental above what was paid", {"outcome": "APPROVE", "payableCents": 170100, "paidCents": 85100}, ["PAYMENT_PENDING"]),
                     gcase("supplemental equal to what was paid", {"outcome": "APPROVE", "payableCents": 85100, "paidCents": 85100}, ["CLOSED"]),
                     gcase("supplemental below what was paid", {"outcome": "APPROVE", "payableCents": 50000, "paidCents": 85100}, ["CLOSED"]),
                     gcase("no current decision is not a pass", None, [])]})

    # PL-02 / PL-03 (D13, D40): one claim run more than once. `change` is what was entered on the claim before the run.
    # A run on the asOf and facts of the claim's last decision writes nothing; any other needs a status that can move to IN_REVIEW.
    status_for = STATUS_FOR

    def reruns(fid, title, f0, runs):
        f, last, exp, status, rows, out = f0, None, None, "OPEN", 0, []
        for i, (asof, change) in enumerate(runs):
            f = {**f, **change}
            ops = select_ops(D(asof))
            if last != (asof, f):
                assert (status, "IN_REVIEW") in edges, f"{fid} run {i}: {status} cannot be reviewed"
                e = adjudicate(f, "plan-v1", ops)
                exp = {"outcome": e["outcome"], "reasons": e["reasons"], "payableCents": e["payableCents"], "claimStatus": status_for[e["outcome"]],
                       "decision": i, "supersedes": exp and exp["decision"]}
                last, rows = (asof, f), rows + 1
            out.append({"asOf": asof, "change": change, "ops": ops, "statusBefore": status, "expected": {**exp, "decisionRows": rows}})
            status = exp["claimStatus"]
        write("pl", {"id": fid, "kind": "readjudication", "title": title, "source": "PRD P0-3 / D13 / D40",
                     "note": "expected.decision is the run whose decision row is returned; expected.supersedes is the run that row supersedes.",
                     "plan": "plan-v1", "facts": f0, "runs": out})

    reruns("PL-02", "An unchanged inputHash is a no-op: the existing decision is returned; no row, no status move",
           facts("essential", price=90000, R=60000, C=30000), [("2025-09-18", {}), ("2025-09-18", {})])
    reruns("PL-03", "Changed facts supersede under the same plan version and the ops version in force on the new asOf",
           facts("essential", start=dt.date(2025, 7, 20), price=90000, R=60000, C=30000, **{"docs.repairEstimate": "requested"}),
           [("2026-03-25", {}), ("2026-04-02", {"docs.repairEstimate": "accepted"})])


# ------------------------------------------------------------------ Phase 3: authority (OV), claim lives (EV, GC-11, GC-15)  D47-D52

# domain brief s7, typed here; verify_fixtures.py reads the same table from ops rule data. Powers accumulate up the list (D51).
AUTH = [("system", {"ops-v1": 50000, "ops-v2": 75000, "ops-v3": 75000}, []), ("adjuster", 100000, ["clear_flags", "waive_documents"]),
        ("senior", 250000, ["decide_appeals", "author_rules"]), ("manager", None, ["ex_gratia", "publish_rules"])]
SINCE = {"author_rules": "ops-v3"}  # D68: a power is held only under an ops version that names it
REMIND = dict(firstDay=10, secondDay=20, closeDay=30)
DOCS = ["proofOfPurchase", "repairEstimate", "damagePhotos", "incidentStatement", "secondEstimate", "transferProof"]
# which facts a person enters from which document (D51). Fixture input, not a rule: the accept action carries them.
FROM_DOC = {"proofOfPurchase": ["evidence.proofOfPurchaseDate"],
            "repairEstimate": ["claim.coveredRepairCents", "claim.serialMatchesContract", "evidence.estimateFromNetwork", "evidence.estimatorIsPayee"],
            "damagePhotos": ["evidence.photoMetaDateBeforeLoss", "evidence.documentHashOnOtherClaim"],
            "incidentStatement": ["claim.accountChanged"]}
# EV-06 (D54): domain brief s8's status line as a table over `docs.<type>`: status, action, status it leaves. A new upload
# always lands on `received` (D51c). An accepted document is not waived, and nothing follows a waiver.
DOC_MOVES = [("requested", "upload", "received"), ("received", "upload", "received"), ("rejected", "upload", "received"),
             ("accepted", "upload", "received"), ("received", "accept", "accepted"), ("received", "reject", "rejected"),
             ("requested", "waive", "waived"), ("received", "waive", "waived"), ("rejected", "waive", "waived")]
REJECTION_REASONS = ["illegible", "wrong_document", "serial_mismatch", "date_inconsistent", "incomplete"]  # domain brief s8
def doc_legal(status, action): return any(m[:2] == (status, action) for m in DOC_MOVES)


def authority(ops, tier, power, paid, amount):
    """Tested on total incurred = the larger of what the claim has been paid and the amount now being approved (D50)."""
    i = [c for c, _, _ in AUTH].index(tier)
    limit = AUTH[i][1][ops] if isinstance(AUTH[i][1], dict) else AUTH[i][1]
    total = max(paid, amount)
    lacks = (["amount"] if limit is not None and total > limit else []) + (["power"] if power and power not in [p for _, _, ps in AUTH[:i + 1] for p in ps if SINCE.get(p, "") <= ops] else [])
    return {"totalIncurredCents": total, "allowed": not lacks, "lacks": lacks}


def legal(a, b): return any(e[0] == a and e[1] == b for e in EDGES)


class Life:
    """One claim from FNOL on, as a list of events: one action each, and the state it must leave behind."""

    def __init__(self, full, plan="plan-v1"):
        from_docs = {n for ns in FROM_DOC.values() for n in ns}
        self.full, self.plan = full, plan
        self.intake = {k: v for k, v in full.items() if k not in from_docs and not k.startswith("docs.")}
        self.versions, self.waived, self.rows, self.events = {}, set(), [], []
        self.status, self.engine, self.current, self.paid, self.pay_status, self.level, self.pend_on = None, None, None, 0, "NONE", 0, None

    def doc(self, d):
        if d in self.waived: return "waived"
        vs = [v["status"] for k, v in self.versions.items() if k.split("/")[0] == d]
        return vs[-1] if vs else "requested"

    def snapshot(self):
        f = {**self.intake, **{f"docs.{d}": self.doc(d) for d in DOCS}}
        for v in self.versions.values():
            if v["status"] == "accepted": f.update(v["facts"])
        return f

    def move(self, *path):
        for to in path:
            assert legal(self.status, to), f"{self.status} -> {to}"
            self.status = to

    def run(self, asof):
        """D40 with D47: the input is asOf, the facts and the accepted document versions. Unchanged = nothing written."""
        f, relied = self.snapshot(), sorted(k for k, v in self.versions.items() if v["status"] == "accepted")
        if self.engine is not None and self.rows[self.engine]["input"] == (asof, f, relied): return
        ops = select_ops(D(asof))
        e = adjudicate(f, self.plan, ops)
        self.move("IN_REVIEW", STATUS_FOR[e["outcome"]])
        self.rows.append(dict(input=(asof, f, relied), shown={
            "kind": "engine", "ops": ops, "outcome": e["outcome"], "reasons": e["reasons"], "payableCents": e["payableCents"],
            "path": e["valuation"] and e["valuation"]["path"], "aggregateRemainingAfterCents": e["valuation"] and e["valuation"]["steps"][-1]["outputCents"],
            "contractFulfilled": e["contractFulfilled"], "notPassed": [r for r in e["rules"] if r["result"] != "PASS"],
            "supersedes": self.engine, "documentVersions": relied}))
        self.engine = self.current = len(self.rows) - 1
        self.level, self.pend_on = 0, asof if e["outcome"] == "PEND" else None

    def ev(self, asof, action, step=None, **extra):
        e = {"asOf": asof, "action": action, "expected": {
            "claimStatus": self.status, "paymentStatus": self.pay_status, "paidCents": self.paid, "reminderLevel": self.level,
            "docs": {d: self.doc(d) for d in DOCS}, "versions": {k: v["status"] for k, v in self.versions.items()},
            "decisionRows": len(self.rows), "decision": {"row": self.current, **self.rows[self.current]["shown"]}, **extra}}
        self.events.append({"step": step, **e} if step else e)

    # ---- actions
    def open(self, asof, step=None):
        self.status = "OPEN"
        self.run(asof)
        self.ev(asof, {"type": "open", "facts": self.intake}, step)

    def upload(self, asof, d, step=None):
        assert doc_legal(self.doc(d), "upload")
        for k, v in self.versions.items():
            if k.split("/")[0] == d: v["status"] = "superseded"
        ver = f"{d}/{1 + sum(k.split('/')[0] == d for k in self.versions)}"
        self.versions[ver] = dict(status="received", facts={})
        if self.status == "CLOSED_NO_RESPONSE": self.move("REOPENED")
        self.ev(asof, {"type": "upload", "doc": d, "version": ver}, step)
        return ver

    def reject(self, asof, ver, reason, step=None):
        assert self.versions[ver]["status"] == "received" and reason in REJECTION_REASONS
        self.versions[ver]["status"] = "rejected"
        self.ev(asof, {"type": "reject", "version": ver, "reason": reason}, step)

    def accept(self, asof, ver, step=None, **entered):
        v = self.versions[ver]
        assert v["status"] == "received"
        v.update(status="accepted", facts={n: entered.get(n, self.full[n]) for n in FROM_DOC[ver.split("/")[0]]})
        self.run(asof)
        self.ev(asof, {"type": "accept", "version": ver, "facts": v["facts"]}, step)

    def file(self, asof, *docs, step=None):
        for d in docs: self.accept(asof, self.upload(asof, d, step), step)

    def waive(self, asof, d, tier, text, step=None):
        a = authority(select_ops(D(asof)), tier, "waive_documents", self.paid, 0)
        assert a["allowed"] and doc_legal(self.doc(d), "waive")
        self.waived.add(d)
        self.run(asof)
        self.ev(asof, {"type": "waive", "doc": d, "by": tier, "reasonText": text}, step)

    def tick(self, asof, step=None):
        """The no-response job on the injected date, counted from the current PEND decision's asOf (D51). At most one reminder a run."""
        if self.status == "PENDING_EVIDENCE":
            days = (D(asof) - D(self.pend_on)).days
            if days >= REMIND["closeDay"]: self.move("CLOSED_NO_RESPONSE")
            else: self.level = max(self.level, (days >= REMIND["firstDay"]) + (days >= REMIND["secondDay"]))
        self.ev(asof, {"type": "tick"}, step)

    def override(self, asof, tier, code, text, step=None):
        e = self.rows[self.engine]["shown"]
        assert self.current == self.engine and e["outcome"] == "REFER"
        ops = select_ops(D(asof))
        a = authority(ops, tier, "clear_flags" if any(r.startswith("F") for r in e["reasons"]) else None, self.paid, e["payableCents"])
        assert a["allowed"], a
        self.rows.append(dict(shown={"kind": "override", "ops": ops, "outcome": "APPROVE", "payableCents": e["payableCents"], "overrides": self.engine,
                                     "by": tier, "totalIncurredCents": a["totalIncurredCents"], "documentVersions": e["documentVersions"]}))
        self.current = len(self.rows) - 1
        self.move("DECIDED")
        self.ev(asof, {"type": "override", "by": tier, "outcome": "APPROVE", "amountCents": e["payableCents"], "reasonCode": code, "reasonText": text}, step)

    def pay(self, asof, step=None):
        """The current decision's amount is the claim's total; what goes out is the part not yet paid, so the deductible is taken once."""
        due = self.rows[self.current]["shown"]["payableCents"] - self.paid
        assert due > 0
        self.move("PAYMENT_PENDING", "PAID", "CLOSED")
        self.paid, self.pay_status = self.paid + due, "PAID"
        self.ev(asof, {"type": "pay"}, step, paymentCents=due)

    def reopen(self, asof, reason, step=None):
        self.move("REOPENED")
        self.ev(asof, {"type": "reopen", "reason": reason}, step)

    def write(self, sub, fid, title, source, note=None):
        write(sub, {"id": fid, "kind": "lifecycle", "title": title, "source": source, **({"note": note} if note else {}), "plan": self.plan, "events": self.events})


def build_phase3():
    case = lambda name, tier, amount, power=None, paid=0: {"name": name, "tier": tier, "power": power, "paidCents": paid, "amountCents": amount,
                                                             "expected": authority("ops-v1", tier, power, paid, amount)}
    ov = [
        ("OV-01", "The tier's limit is inclusive, and a tier with no limit approves anything", [
            case("GC-05's sign-off", "adjuster", 77500), case("at the limit", "adjuster", 100000), case("one cent over", "adjuster", 100001),
            case("the next tier takes it", "senior", 100001), case("no limit", "manager", 99999999)]),
        ("OV-02", "Authority is tested on total incurred on the claim, never on the payment about to go out", [
            case("GC-15 step 8: 85000 more would fit, the 170100 total does not", "adjuster", 170100, paid=85100),
            case("GC-15 step 8, senior adjuster", "senior", 170100, paid=85100),
            case("a supplement that keeps the total inside the limit", "adjuster", 95000, paid=60000),
            case("a recomputed total below what was paid: paid money stays incurred", "adjuster", 60000, paid=120000)]),
        ("OV-03", "A power belongs to its tier and every tier above it", [
            case("adjuster clears a flag", "adjuster", 85100, "clear_flags"), case("adjuster waives a document", "adjuster", 0, "waive_documents"),
            case("senior adjuster clears a flag (GC-15 step 8)", "senior", 170100, "clear_flags", 85100),
            case("adjuster cannot decide an appeal", "adjuster", 0, "decide_appeals"), case("the system tier has no powers", "system", 0, "waive_documents"),
            case("power held, amount not", "adjuster", 100001, "clear_flags"), case("neither", "system", 60000, "clear_flags")]),
    ]
    for fid, title, cases in ov:
        write("ov", {"id": fid, "kind": "authority", "title": title, "source": "domain brief s7 / D18 / D50 / D51", "ops": "ops-v1", "cases": cases})

    gc01 = lambda: facts("essential", price=90000, R=60000, C=30000)
    day = "2025-09-17"  # the default claim's date reported

    c = Life(facts("plus", price=80000, R=70000, C=20000, peril="adh")); c.open(day)
    c.write("ev", "EV-01", "FNOL on an accidental-damage claim: PEND, and each of the four required documents is a reason", "PRD P0-6 / D51",
            "Facts that only a document can supply are unknown at FNOL, so the rules that read them pend too (notPassed[].missing).")
    c = Life(facts("essential", price=60000, R=60000, C=25000, peril="adh")); c.open(day)
    c.write("ev", "EV-02", "A claim deniable at FNOL is denied without asking for documents: the evidence stage does not run", "PRD P0-6 / D8", "GC-02's claim.")
    c = Life(gc01()); c.open(day)
    v = c.upload(day, "repairEstimate"); c.reject(day, v, "illegible"); c.accept(day, c.upload(day, "repairEstimate"))
    c.write("ev", "EV-03", "A new upload supersedes; the rejected version is still there", "PRD P0-6 / D51")
    c = Life(gc01()); c.open(day); c.file(day, "repairEstimate", "repairEstimate")
    c.write("ev", "EV-04", "Each decision names the document versions it relied on, and a replacement with the same content is a new input", "PRD P0-6 / D4 / D47",
            "Same asOf, same facts, same outcome: only documentVersions differs between the last two decisions, and the later one supersedes.")
    c = Life(gc01()); c.open(day); c.file(day, "damagePhotos", "incidentStatement", "repairEstimate", "proofOfPurchase")
    c.write("ev", "EV-05", "Accepting the last missing document re-adjudicates: PEND becomes APPROVE 25000", "PRD P0-6 / D51", "GC-01's claim.")

    c = Life(facts("plus", price=120000, R=110000, C=30000)); c.open(day); c.file(day, "repairEstimate", "damagePhotos", "incidentStatement")
    for d in ("2025-09-26", "2025-09-27", "2025-10-07", "2025-10-17"): c.tick(d)
    c.file("2025-11-03", "proofOfPurchase")
    c.write("gc", "GC-11", "Plus, no proof of purchase and no response: reminders on day 10 and 20, closed on day 30, reopened when it arrives", "domain brief s11 / s6",
            "Closing writes no decision: the claim's decision is still the PEND, never a denial. PAY-A's numbers once the receipt is in.")

    s = dt.date(2025, 1, 15)
    dol = s + dt.timedelta(days=200)
    c = Life(facts("premier", dol=dol, price=180000, R=190000, C=95000, peril="adh", prior=[prior("GC-15-P1", dol - dt.timedelta(days=45), "breakdown", 20000)],
                   **{"evidence.estimateFromNetwork": False}))
    c.open("2025-08-05", 1)
    c.file("2025-08-06", "proofOfPurchase", "damagePhotos", "incidentStatement", step=2); c.tick("2025-08-16", 2)
    c.file("2025-08-18", "repairEstimate", step=3)
    c.waive("2025-08-19", "secondEstimate", "adjuster", "No network servicer within 50 miles; estimate itemized and consistent with parts catalog", [4, 5])
    c.override("2025-08-20", "adjuster", "FLAG_CLEARED", "F2: unrelated failure, network-repaired", 6)
    c.pay("2025-08-21", 7)
    c.reopen("2025-09-10", "supplemental", 8)
    c.accept("2025-09-10", c.upload("2025-09-10", "repairEstimate", 8), 8, **{"claim.coveredRepairCents": 145000})
    c.override("2025-09-11", "senior", "FLAG_CLEARED", "F2: unrelated failure, network-repaired; teardown estimate reviewed", 8)
    c.pay("2025-09-12", 8)
    c.write("gc", "GC-15", "Capstone: a Premier laptop claim from FNOL to a supplemental that turns a repair into a replacement", "domain brief s11",
            "step is the brief's step number. The engine's amount is always the claim's total; a payment is the part of it not yet paid.")

    write("ev", {"id": "EV-06", "kind": "document-transitions", "title": "A document's status moves only along the table; anything else throws",
                 "source": "domain brief s8 / D51 / D54",
                 "note": "The status of docs.<type>. A version is superseded when a later version of its document exists, whatever else was said of it.",
                 "statuses": ["requested", "received", "accepted", "rejected", "superseded", "waived"],
                 "moves": [{"from": a, "action": b, "to": c} for a, b, c in DOC_MOVES],
                 "rejectionReasons": REJECTION_REASONS})

    gc5 = json.load(open(os.path.join(ROOT, "gc", "GC-05.json")))
    asof = iso(D(gc5["asOf"]) + dt.timedelta(days=1))
    gc5["signoff"] = {"asOf": asof, "by": "adjuster", "outcome": "APPROVE", "amountCents": gc5["expected"]["payableCents"], "reasonCode": "SIGN_OFF",
                      "reasonText": "Replacement value checked against the catalog", "paidCents": 0,
                      "expected": {"kind": "override", "ops": select_ops(D(asof)), "outcome": "APPROVE", "payableCents": gc5["expected"]["payableCents"], "claimStatus": "DECIDED",
                                   "authority": authority(select_ops(D(asof)), "adjuster", None, 0, gc5["expected"]["payableCents"])}}
    write("gc", gc5)


# ------------------------------------------------------------------ Phase 4: authoring (AU, OV-04) and the impact diff (ID)  D68-D75

# An edit is a path into a rule set and a value (or `remove`). A string step into a list names the element with that id
# (a tier by its code); a number is a position. The edits are typed here: this file still reads nothing under rules/.
def edit(*path, **kw): return {"path": list(path), **kw}

# AU-05 (D70): the life of one version row. `create` starts a row; it is refused while the kind and product has a draft.
DRAFT_MOVES = [(None, "create", "draft", "author_rules"), ("draft", "save", "draft", "author_rules"), ("draft", "publish", "published", "publish_rules")]
REFUSALS = ["DRAFT_EXISTS", "NOT_A_DRAFT", "OUT_OF_AUTHORITY", "PUBLISHER_IS_AUTHOR", "DIFF_STALE"]  # tested in this order; the first that applies is the error


def draft_life(ops, latest, steps):
    row, out = None, []  # row: the kind and product's newest version row
    for action, user, tier, *saw in steps:
        status = row["status"] if row and (action != "create" or row["status"] == "draft") else None
        move = next((m for m in DRAFT_MOVES if m[:2] == (status, action)), None)
        if not move: err = "DRAFT_EXISTS" if action == "create" else "NOT_A_DRAFT"
        elif not authority(ops, tier, move[3], 0, 0)["allowed"]: err = "OUT_OF_AUTHORITY"
        elif action == "publish" and user == row["authoredBy"]: err = "PUBLISHER_IS_AUTHOR"
        elif action == "publish" and saw[0] != row["revision"]: err = "DIFF_STALE"
        else:
            err = None
            if action == "create": latest += 1; row = dict(status="draft", version=latest, authoredBy=user, publishedBy=None, revision=0)
            elif action == "save": row.update(authoredBy=user, revision=row["revision"] + 1)
            else: row.update(status="published", publishedBy=user)
        out.append({"action": action, "by": {"user": user, "tier": tier}, **({"sawRevision": saw[0]} if saw else {}),
                    "expected": {"allowed": err is None, "error": err, "row": row and dict(row)}})
    return out


def build_phase4():
    case = lambda name, tier, power: {"name": name, "tier": tier, "power": power, "paidCents": 0, "amountCents": 0, "expected": authority("ops-v3", tier, power, 0, 0)}
    write("ov", {"id": "OV-04", "kind": "authority", "title": "Authoring a rule set and publishing one are two powers, held as every other power is",
                 "source": "domain brief s7 / D66 / D68", "ops": "ops-v3", "cases": [
                     case("a senior adjuster drafts", "senior", "author_rules"), case("an adjuster does not", "adjuster", "author_rules"),
                     case("a manager drafts too", "manager", "author_rules"), case("a manager publishes", "manager", "publish_rules"),
                     case("a senior adjuster does not publish", "senior", "publish_rules")]})

    E7 = ("rules", "E7", "rows", "E7.fail")
    drafts = [
        ("AU-01", "UNKNOWN_FACT", "ops-v3", "A cell names a fact the dictionary does not have", [edit("rules", "E5", "rows", "E5.fail", "when", 0, "fact", value="claim.serialNumber")]),
        ("AU-02", "TYPE_MISMATCH", "plan-v2", "A yes/no fact compared to a word", [edit(*E7, "when", 0, "value", value="yes")]),
        ("AU-03", "OVERLAP", "plan-v2", "Two rows of a unique table can match the same claim", [edit("lookups", "deductibleCents", "rows", "ded.plus", "when", 0, "value", value="essential")]),
        ("AU-04", "MISSING_TEMPLATE", "plan-v2", "A denial with no text for the file note", [edit(*E7, "then", "noteText", remove=True)]),
    ]
    for fid, code, base, title, edits in drafts:
        write("au", {"id": fid, "kind": "draft-validation", "title": f"{title}: the draft cannot be published", "source": "PRD P0-9 / D70",
                     "base": base, "edits": edits, "expectedCodes": [code]})

    S1, S2, M1, M2, A1 = ("u-senior-1", "senior"), ("u-senior-2", "senior"), ("u-manager-1", "manager"), ("u-manager-2", "manager"), ("u-adjuster-1", "adjuster")
    scenarios = [
        ("one person drafts, another publishes", [("create", *S1), ("save", *S1), ("publish", *M1, 1)]),
        ("who may draft", [("create", *A1), ("create", *M1)]),
        ("who may publish", [("create", *S1), ("save", *S1), ("publish", *S2, 1), ("publish", *M1, 1)]),
        ("the author cannot publish, whatever the tier", [("create", *M1), ("save", *M1), ("publish", *M1, 1), ("publish", *M2, 1)]),
        ("the author is whoever saved last", [("create", *M1), ("save", *M2), ("publish", *M2, 1), ("publish", *M1, 1)]),
        ("the publisher must have seen this content", [("create", *S1), ("save", *S1), ("save", *S1), ("publish", *M1, 1), ("publish", *M1, 2)]),
        ("one open draft, and a published row is closed", [("create", *S1), ("create", *M1), ("save", *S1), ("publish", *M1, 1), ("save", *S1), ("publish", *M2, 1), ("create", *S1)]),
    ]
    write("au", {"id": "AU-05", "kind": "draft-transitions", "title": "A version row moves only along the table, by a user holding the power, and never published by its author",
                 "source": "PRD P0-9 / D66 / D68 / D70",
                 "note": "Each scenario starts with `latestPublished` as the newest version and no draft. `sawRevision` is the save count of the content the publisher's "
                         "impact diff ran on. `expected.row` is the newest row after the step; a refused step leaves it as it was.",
                 "ops": "ops-v3", "latestPublished": 3, "statuses": ["draft", "published", "retired"],
                 "moves": [{"from": a, "action": b, "to": c, "power": d} for a, b, c, d in DRAFT_MOVES], "refusals": REFUSALS,
                 "scenarios": [{"name": n, "steps": draft_life("ops-v3", 3, st)} for n, st in scenarios]})

    # ID (D71): every golden decision against a draft standing in for the plan (or ops) version it was decided under.
    claims = [decision_fixture(gid, t, src, f) for gid, t, src, f in golden()]
    shown = lambda e: {k: e[k] for k in ("outcome", "reasons", "payableCents")}
    ded = lambda cents: dict(tiers={**TIER, "essential": {**TIER["essential"], "ded": {"breakdown": cents, "adh": cents}}})
    ded_edit = lambda cents: edit("lookups", "deductibleCents", "rows", "ded.essential", "value", value=cents)
    diffs = [
        ("ID-01", "Essential deductible 5000 to 30000", "plan-v1", [ded_edit(30000)], dict(plan=ded(30000))),
        ("ID-02", "plan-v2 as a draft over plan-v1: the Essential deductible at 10000", "plan-v1",
         [edit("version", value=2), edit("effectiveFrom", value="2026-01-01"), ded_edit(10000)], dict(plan=PLANS["plan-v2"])),
        ("ID-03", "The auto-approve limit raised to 80000: a referral becomes an approval", "ops-v1",
         [edit("authority", "system", "approveUpToCents", value=80000), edit("rules", "E23", "rows", "E23.pass", "when", 0, "value", value=80000),
          edit("rules", "E23", "rows", "E23.fail", "when", 0, "value", value=80000),
          edit("rules", "E23", "rows", "E23.fail", "then", "noteText", value="Payable {amt} above auto-approve limit 80000.")], dict(ops=dict(auto_limit=80000))),
        ("ID-04", "Plus per-claim limit 100000 to 150000: no golden claim reaches either", "plan-v1",
         [edit("lookups", "perClaimLimitCents", "rows", "pcl.plus", "value", value=150000)], dict(plan=dict(tiers={**TIER, "plus": {**TIER["plus"], "pcl": 150000}}))),
    ]
    for fid, title, base, edits, draft in diffs:
        changed = []
        for c in claims:
            after = adjudicate(c["facts"], draft.get("plan", c["plan"]), draft.get("ops", c["ops"]))
            if shown(after) != shown(c["expected"]): changed.append({"claim": c["id"], "before": shown(c["expected"]), "after": shown(after)})
        write("id", {"id": fid, "kind": "impact-diff", "title": title, "source": "PRD P0-9 / D71",
                     "note": "The draft is `base` with `edits` applied. It stands in for the version of its kind each claim was decided under; the claim's facts, asOf and other version stay.",
                     "base": base, "edits": edits, "claims": [c["id"] for c in claims],
                     "expected": {"changed": changed, "unchanged": len(claims) - len(changed)}})


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
        ("PAY-I", "plus", "replace threshold boundary: 77001 of 110000 is 7000.09 bps, replace (D26)", dict(price=120000, R=110000, C=77001)),
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
    build_re(); build_pay(); build_gc(); build_phase2(); build_phase3(); build_phase4()
    print("fixtures written to", os.path.normpath(ROOT))
