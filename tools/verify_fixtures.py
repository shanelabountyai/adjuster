#!/usr/bin/env python3
"""Second derivation for Adjuster's fixtures. Exit 0 and print OK only if every frozen fixture agrees.

build_fixtures.py adjudicates procedurally from the domain brief. This script derives the same answers a DIFFERENT way:
it interprets rules/electronics/{facts,plan,ops}-v1.json (the rule data the product will load) with decimal.Decimal
arithmetic and Kleene three-valued logic, and checks the result against the fixtures and against answer keys typed
in below straight from the brief. So it proves two things at once: the fixtures are right, and the rule data encodes
the brief. It is a test oracle in tools/, not product code. Stdlib only.
"""
import datetime as dt, glob, json, os, re, sys
from decimal import Decimal, ROUND_HALF_UP, getcontext

getcontext().prec = 60
HERE = os.path.dirname(os.path.abspath(__file__))
FIX, RULES = os.path.join(HERE, "..", "fixtures"), os.path.join(HERE, "..", "rules", "electronics")
fails = []


def chk(ok, msg):
    if not ok: fails.append(msg)


def load(p): return json.load(open(p))
q = lambda x: int(Decimal(x).quantize(Decimal(1), rounding=ROUND_HALF_UP))  # the one rounding rule: half up
D = dt.date.fromisoformat

# ---- answer keys, typed from docs/domain-brief.md s4 and s11 (not read from any fixture)
PAY_KEY = {"PAY-A": 22500, "PAY-B": 77500, "PAY-C": 0, "PAY-D": 30000, "PAY-E": 46500, "PAY-F": 90100, "PAY-G": 50000, "PAY-I": 100000, "PAY-H": None}
GC_KEY = {  # outcome, payable (None = not stated in the brief), reasons
    "GC-01": ("APPROVE", 25000, []), "GC-02": ("DENY", None, ["E6"]), "GC-03": ("DENY", None, ["E3"]), "GC-04": ("DENY", None, ["E2", "E7"]),
    "GC-05": ("REFER", 77500, ["E23"]), "GC-06": ("APPROVE", 0, []), "GC-07": ("PARTIAL", 30000, []), "GC-08": ("APPROVE", 46500, []),
    "GC-09": ("DENY", None, ["E15"]), "GC-10": ("REFER", None, ["E5"]),
    "GC-12": ("REFER", None, ["F1", "F3"]), "GC-13": ("PARTIAL", 50000, []), "GC-14": ("DENY", None, ["E10", "E11"]),
}
DENY_ONLY_PAYABLE_NULL = {"GC-02", "GC-03", "GC-04", "GC-09", "GC-14"}
# D35, typed from decisions.md: GC-01's claim, 30000 less the deductible each contract bought (5000 / 10000)
RV_KEY = [("plan-v1", "APPROVE", 25000), ("plan-v2", "APPROVE", 20000)]
VP_KEY = {
    "VP-02": [("plan-v1", "ops-v2"), ("plan-v2", "ops-v2")],
    "VP-03": [("plan-v1", "ops-v1"), ("plan-v1", "ops-v2"), ("plan-v1", "ops-v2")],
    "VP-04": [("NO_EFFECTIVE_VERSION", "plan"), ("NO_EFFECTIVE_VERSION", "ops")],
}
# D38, typed from domain brief s7's status line, plus OPEN>IN_REVIEW (task 2.5) and the three guards on leaving DECIDED
PL01_KEY = ("OPEN>PENDING_EVIDENCE OPEN>IN_REVIEW PENDING_EVIDENCE>IN_REVIEW IN_REVIEW>PENDING_EVIDENCE IN_REVIEW>REFERRED REFERRED>DECIDED "
            "DECIDED>PAYMENT_PENDING?payable PAYMENT_PENDING>PAID PAID>CLOSED IN_REVIEW>DECIDED REFERRED>PENDING_EVIDENCE "
            "PENDING_EVIDENCE>CLOSED_NO_RESPONSE OPEN>WITHDRAWN PENDING_EVIDENCE>WITHDRAWN IN_REVIEW>WITHDRAWN REFERRED>WITHDRAWN "
            "DECIDED>UNDER_APPEAL?denied UNDER_APPEAL>DECIDED DECIDED>CLOSED?denied_or_zero CLOSED>REOPENED CLOSED_NO_RESPONSE>REOPENED REOPENED>IN_REVIEW")
PL01_GUARD = {"UNDER_APPEAL": lambda o, amt: o == "DENY", "CLOSED": lambda o, amt: o == "DENY" or amt == 0, "PAYMENT_PENDING": lambda o, amt: bool(amt)}
PL_KEY = {"PL-06": {"error": "CONTRACT_NOT_FOUND", "decision": None, "claimStatus": "REFERRED", "rulesRun": []}}
# D40, typed from decisions.md. Per run: outcome, payable, the run whose decision is returned, the run that decision supersedes.
PL_RUNS_KEY = {"PL-02": [("APPROVE", 25000, 0, None), ("APPROVE", 25000, 0, None)],
               "PL-03": [("PEND", None, 0, None), ("APPROVE", 25000, 1, 0)]}
PL_STATUS_FOR = {"APPROVE": "DECIDED", "PARTIAL": "DECIDED", "DENY": "DECIDED", "PEND": "PENDING_EVIDENCE", "REFER": "REFERRED"}
# Phase 3 (D47-D52). OV: whether each case is allowed, typed from domain brief s7's table.
OV_KEY = {"OV-01": [True, True, False, True, True], "OV-02": [False, True, True, False], "OV-03": [True, True, True, False, False, False, False]}
# Claim lives. rows: every decision row in order (E engine / O override, outcome, cents). end: claim status, payment status, cents paid.
P, E_, O_ = ("E", "PEND", None), "E", "O"
LIFE_KEY = {
    "EV-01": dict(rows=[P], end=("PENDING_EVIDENCE", "NONE", 0)),
    "EV-02": dict(rows=[(E_, "DENY", None)], end=("DECIDED", "NONE", 0)),
    "EV-03": dict(rows=[P, P], end=("PENDING_EVIDENCE", "NONE", 0)),
    "EV-04": dict(rows=[P, P, P], end=("PENDING_EVIDENCE", "NONE", 0)),
    "EV-05": dict(rows=[P, P, P, P, (E_, "APPROVE", 25000)], end=("DECIDED", "NONE", 0)),
    "GC-11": dict(rows=[P, P, P, P, (E_, "APPROVE", 22500)], end=("DECIDED", "NONE", 0)),
    "GC-15": dict(rows=[P, P, P, P, P, (E_, "REFER", 85100), (O_, "APPROVE", 85100), (E_, "REFER", 170100), (O_, "APPROVE", 170100)], end=("CLOSED", "PAID", 170100)),
}
# GC-15, typed from domain brief s11: how each numbered step ends (claim status, the current decision's outcome and cents, cents paid so far)
GC15_KEY = {1: ("PENDING_EVIDENCE", "PEND", None, 0), 2: ("PENDING_EVIDENCE", "PEND", None, 0), 3: ("PENDING_EVIDENCE", "PEND", None, 0),
            5: ("REFERRED", "REFER", 85100, 0), 6: ("DECIDED", "APPROVE", 85100, 0), 7: ("CLOSED", "APPROVE", 85100, 85100), 8: ("CLOSED", "APPROVE", 170100, 170100)}

STAGES = ["intake", "contract_verification", "coverage_period", "peril_exclusions", "frequency_limits", "evidence", "red_flags", "valuation", "deductible_limits", "authority", "decision"]
SKIPPED_ON_DENY = ["evidence", "red_flags", "valuation", "deductible_limits", "authority"]
SEVERITY = {"PASS": 0, "REFER": 1, "PEND": 2, "DENY": 3}  # D8: objective deny > pend > refer > approve


# ------------------------------------------------------------------ three-valued conditions (None = UNKNOWN)

def cell(c, get):
    v, op, val = get(c["fact"]), c["op"], c.get("value")
    if op == "is_known": return v is not None
    if v is None: return None
    return {"eq": lambda: v == val, "neq": lambda: v != val, "lt": lambda: v < val, "lte": lambda: v <= val, "gt": lambda: v > val,
            "gte": lambda: v >= val, "in": lambda: v in val, "not_in": lambda: v not in val, "between": lambda: val[0] <= v <= val[1]}[op]()


def row(cells, get):
    rs = [cell(c, get) for c in cells]
    if any(r is False for r in rs): return False
    return None if any(r is None for r in rs) else True


def rule(r, get, roots=lambda f: [f]):
    rows = [(w, row(w["when"], get)) for w in r["rows"]]
    hits = [w for w, v in rows if v is True]
    if hits:
        return dict(result=max((w["then"]["outcome"] for w in hits), key=SEVERITY.get), hits=[w["id"] for w in hits], missing=[])
    unknown = [w for w, v in rows if v is None]
    if unknown:
        # D51: of the facts an unknown cell is computed from, name the ones that are themselves unknown
        missing = sorted({x for w in unknown for c in w["when"] if cell(c, get) is None for x in roots(c["fact"]) if get(x) is None})
        return dict(result="PEND", hits=[], missing=missing)
    return dict(result="GAP", hits=[], missing=[])


def tv(x): return "UNKNOWN" if x is None else ("TRUE" if x else "FALSE")


# ------------------------------------------------------------------ calc steps

def run_steps(steps, get, regs):
    out = []
    for s in steps:
        reg = s.get("reg", "L")
        if not all(cell(c, get) is True for c in s.get("when", [])):
            out.append(dict(id=s["id"], op=s["op"], reg=reg, applied=False, operand=None, inputCents=None, outputCents=None)); continue
        before = regs.get(reg)

        def val(o):
            if "fact" in o: return ("fact", o["fact"], get(o["fact"]))
            if "const" in o: return ("const", None, o["const"])
            return ("reg", o["reg"], regs[o["reg"]])
        if s["op"] == "min_of":
            regs[reg] = min(val(o)[2] for o in s["operands"]); operand = None
        else:
            kind, name, v = val(s["operand"]); operand = dict(kind=kind, name=name, value=v)
            b = before
            regs[reg] = {"start_from": lambda: v, "subtract": lambda: b - v, "apply_bps": lambda: q(Decimal(b) * v / 10000),
                         "cap_at": lambda: min(b, v), "floor_at": lambda: max(b, v)}[s["op"]]()
        out.append(dict(id=s["id"], op=s["op"], reg=reg, applied=True, operand=operand, inputCents=before, outputCents=regs[reg]))
    return out


# ------------------------------------------------------------------ the engine, as a data interpreter

class Ctx:
    def __init__(self, facts, dic, plan):
        self.f, self.dic, self.plan, self.memo = facts, {x["id"]: x for x in dic["facts"]}, plan, {}

    def get(self, fid):
        if fid in self.f: return self.f[fid]
        if fid in self.memo: return self.memo[fid]
        d = self.dic.get(fid)
        v = None
        if d and d["source"] == "derived": v = self.derive(d)
        elif d and d["source"] == "lookup": v = self.lookup(fid.split(".", 1)[1])
        self.memo[fid] = v
        return v

    def roots(self, fid):
        d = self.dic.get(fid)
        if d and d["source"] == "derived":
            return sorted({r for k, a in d["args"].items() if k in ("from", "to", "num", "den", "list", "anchor") for r in self.roots(a)})
        return [fid]

    def derive(self, d):
        a, fn = d["args"], d["fn"]
        g = lambda k: self.get(a[k])
        if fn == "days_between": return None if None in (g("from"), g("to")) else (D(g("to")) - D(g("from"))).days
        if fn == "full_years_between":
            if None in (g("from"), g("to")): return None
            x, y = D(g("from")), D(g("to"))
            return y.year - x.year - ((y.month, y.day) < (x.month, x.day))
        if fn == "ratio_bps":
            n, m = g("num"), g("den")
            return None if n is None or m is None or m == 0 else q(Decimal(n) * 10000 / m)
        if fn == "ratio_exceeds_bps":
            n, m = g("num"), g("den")
            return None if n is None or m is None else n * 10000 > a["bps"] * m
        if fn == "sum_prior_paid": return sum(p["paidCents"] for p in g("list"))
        if fn == "count_claims_in_window":
            anchor, peril = D(g("anchor")), self.get("claim.peril")
            n = 0
            for p in g("list"):
                if not 0 <= (anchor - D(p["dateOfLoss"])).days <= a["windowDays"]: continue
                f = a["peril"]
                if f == "same" and p["peril"] != peril: continue
                if isinstance(f, list) and p["peril"] not in f: continue
                if "counts" in a and p["outcome"] not in a["counts"]: continue
                n += 1
            return n
        raise AssertionError(fn)

    def lookup(self, name):
        t = next(l for l in self.plan["lookups"] if l["id"] == name)
        rows = [(r, row(r["when"], self.get)) for r in t["rows"]]
        hits = [r for r, v in rows if v is True]
        chk(len(hits) <= 1, f"lookup {name}: unique table matched {len(hits)} rows")
        return hits[0]["value"] if hits else None  # None covers both UNKNOWN and a gap; fixtures here exercise neither


def decide(plan, ops, dic, facts):
    ctx = Ctx(dict(facts), dic, plan)
    get = ctx.get
    rules = plan["rules"] + ops["rules"]
    run = lambda rs: [(r, rule(r, get, ctx.roots)) for r in rs]
    early = run([r for r in rules if r["stage"] in STAGES[:5]])
    deny = any(x["result"] == "DENY" for _, x in early) and ops["outcomePolicy"]["autoDenyEnabled"]
    skipped = list(SKIPPED_ON_DENY) if deny else []
    mid = [] if deny else run([r for r in rules if r["stage"] in ("evidence", "red_flags")])
    pend = any(x["result"] == "PEND" for _, x in early + mid)
    valuation = payable = fulfilled = after_ded = None
    late = []
    if not deny and not pend:
        regs = {}
        steps = run_steps(plan["payout"]["steps"], get, regs)
        for k, r in plan["payout"]["outputs"].items(): ctx.f[f"calc.{k}"] = regs[r]
        payable, after_ded = regs["L"], regs["DED"]
        valuation = {"path": get("lookup.path"), "steps": steps}
        fulfilled = any(row(w["when"], get) is True for w in plan["fulfillment"])
        late = run([r for r in rules if r["stage"] == "authority"])
    allr = sorted(early + mid + late, key=lambda x: STAGES.index(x[0]["stage"]))
    res = [x["result"] for _, x in allr]
    if deny: outcome = "DENY"
    elif pend: outcome = "PEND"
    elif "REFER" in res: outcome = "REFER"
    else: outcome = "PARTIAL" if payable < after_ded else "APPROVE"
    key = outcome if outcome in ("DENY", "PEND", "REFER") else None
    return {"outcome": outcome, "reasons": [r["id"] for r, x in allr if x["result"] == key] if key else [], "payableCents": payable,
            "contractFulfilled": fulfilled, "skippedStages": skipped,
            "rules": [{"ruleId": r["id"], "result": x["result"], "missing": x["missing"]} for r, x in allr], "valuation": valuation}


# ------------------------------------------------------------------ checks

dic = load(f"{RULES}/facts-v1.json")
RS = {os.path.basename(p)[:-5]: load(p) for p in glob.glob(f"{RULES}/plan-*.json") + glob.glob(f"{RULES}/ops-*.json")}
plan, ops = RS["plan-v1"], RS["ops-v1"]
byid = {x["id"]: x for x in dic["facts"]}

# D35: each v2 is its v1 plus exactly the typed edits, nothing else
import copy
p2 = copy.deepcopy(plan); p2.update(version=2, effectiveFrom="2026-01-01")
next(r for r in next(l for l in p2["lookups"] if l["id"] == "deductibleCents")["rows"] if r["id"] == "ded.essential")["value"] = 10000
chk(RS.get("plan-v2") == p2, "plan-v2 is not plan-v1 with only the Essential deductible at 10000 (D35)")
o2 = copy.deepcopy(ops); o2.update(version=2, effectiveFrom="2026-04-01"); o2["authority"][0]["approveUpToCents"] = 75000
e23v2 = next(r for r in o2["rules"] if r["id"] == "E23")
for w in e23v2["rows"]: w["when"][0]["value"] = 75000
e23v2["rows"][1]["then"]["noteText"] = "Payable {amt} above auto-approve limit 75000."
e23v2["note"] = "75000 equals the system tier below; the two must move together."
chk(RS.get("ops-v2") == o2, "ops-v2 is not ops-v1 with only the system limit (and E23) at 75000 (D35)")
chk(sorted(RS) == ["ops-v1", "ops-v2", "plan-v1", "plan-v2"], f"rule set files: {sorted(RS)}")


def pick_ops(asof, versions):
    """Every rule file is published; walk newest first and take the first in force on asOf."""
    for v in sorted((v for v in versions if v["kind"] == "ops" and v["status"] == "published"), key=lambda v: D(v["effectiveFrom"]), reverse=True):
        if D(v["effectiveFrom"]) <= D(asof): return v["name"]
    return None


FILE_VERSIONS = [dict(name=n, kind=r["kind"], status="published", effectiveFrom=r["effectiveFrom"]) for n, r in RS.items()]

# rule data against the brief's s1 table, typed here independently
L = {l["id"]: {r["id"]: r for r in l["rows"]} for l in plan["lookups"]}
val = lambda l, r: L[l][r]["value"]
chk([val("perClaimLimitCents", k) for k in ("pcl.essential", "pcl.plus", "pcl.premier")] == [50000, 100000, 200000], "per-claim limits differ from the brief")
chk([val("aggregateLimitCents", k) for k in ("agg.essential", "agg.plus", "agg.premier")] == [100000, 200000, 400000], "aggregate limits differ from the brief")
chk([val("deductibleCents", k) for k in ("ded.essential", "ded.plus", "ded.premier.breakdown", "ded.premier.adh")] == [5000, 7500, 2500, 9900], "deductibles differ from the brief")
chk([val("retentionBps", k) for k in ("ret.acv.0", "ret.acv.1", "ret.acv.2", "ret.acv.3plus", "ret.rc")] == [10000, 8000, 6000, 4000, 10000], "ACV depreciation (20%/yr, max 60%) differs from the brief")
chk([val("fulfillsOnReplace", k) for k in ("ful.es", "ful.premier")] == [True, False], "replacement-fulfills flags differ from the brief")
pr = {r["id"]: r for r in plan["rules"]}
chk([x["when"][1]["value"] for x in pr["E3"]["rows"] if x["id"].startswith("E3.pass")] == [30, 14], "waiting periods differ from the brief")
chk(sorted(x["then"]["params"]["N"] for x in pr["E15"]["rows"] if x["id"].startswith("E15.fail")) == [2, 2, 3], "frequency limits differ from the brief")
chk([x["when"][1]["value"] for x in pr["E16"]["rows"] if x["id"].startswith("E16.pass")] == [100000, 200000, 400000], "E16 literals differ from the aggregate limits")
chk([(t["code"], t["approveUpToCents"]) for t in ops["authority"]] == [("system", 50000), ("adjuster", 100000), ("senior", 250000), ("manager", None)], "authority tiers differ from the brief")
e23 = next(r for r in ops["rules"] if r["id"] == "E23")
chk(e23["rows"][0]["when"][0]["value"] == 50000, "E23 literal must equal the system tier limit")
chk(ops["reminders"] == {"firstDay": 10, "secondDay": 20, "closeDay": 30}, "reminder days differ from the brief")
chk(plan["roundingMode"] == "half_up" and ops["outcomePolicy"]["autoDenyEnabled"] is True and ops["factDictionary"] == dic["id"], "envelope defaults (half_up, auto_deny_enabled, dictionary id)")
chk(all(s["op"] in ("start_from", "subtract", "apply_bps", "cap_at", "floor_at", "min_of") for s in plan["payout"]["steps"]), "calc step vocabulary")

# ------------------------------------------------------------------ Phase 3: authority and claim lives, replayed from the actions alone

def authority(ops_name, tier, power, paid, amount):
    """From ops rule data: the tier's limit against total incurred, and its powers plus those of every tier below it."""
    tiers = RS[ops_name]["authority"]
    i = next(n for n, t in enumerate(tiers) if t["code"] == tier)
    total, limit = max(paid, amount), tiers[i]["approveUpToCents"]
    held = {p for t in tiers[:i + 1] for p in t["powers"]}
    lacks = [w for w, bad in (("amount", limit is not None and total > limit), ("power", power is not None and power not in held)) if bad]
    return {"totalIncurredCents": total, "allowed": not lacks, "lacks": lacks}


def replay(fid, f):
    """Second derivation of a claim's life. State comes only from each event's action; every event's expected block must equal it."""
    doc_types = [x["id"][5:] for x in dic["facts"] if x["id"].startswith("docs.")]
    flag_ids = {r["id"] for r in RS["ops-v1"]["rules"] if r["kind"] == "flag"}
    edges = {(t["from"], t["to"]) for t in fx["PL-01"]["transitions"]}
    s = dict(status=None, intake={}, vers={}, waived=[], rows=[], eng=None, cur=None, paid=0, pay="NONE", level=0, pend_on=None, last=None)
    of = lambda ver: ver.split("/")[0]

    def doc(d):
        mine = [v["status"] for k, v in s["vers"].items() if of(k) == d]
        return "waived" if d in s["waived"] else mine[-1] if mine else "requested"

    def move(i, *path):
        for to in path:
            chk((s["status"], to) in edges, f"{fid} event {i}: {s['status']} -> {to} is not in PL-01")
            s["status"] = to

    def run(i, asof):
        facts = {**s["intake"], **{f"docs.{d}": doc(d) for d in doc_types}}
        relied = sorted(k for k, v in s["vers"].items() if v["status"] == "accepted")
        for k in relied: facts.update(s["vers"][k]["facts"])
        if s["last"] == (asof, facts, relied): return
        ops_name = pick_ops(asof, FILE_VERSIONS)
        got = decide(RS[f["plan"]], RS[ops_name], dic, facts)
        chk(not any(r["result"] == "GAP" for r in got["rules"]), f"{fid} event {i}: a rule had no matching row")
        move(i, "IN_REVIEW", PL_STATUS_FOR[got["outcome"]])
        v = got["valuation"]
        s["rows"].append({"kind": "engine", "ops": ops_name, "outcome": got["outcome"], "reasons": got["reasons"], "payableCents": got["payableCents"],
                          "path": v and v["path"], "aggregateRemainingAfterCents": v and v["steps"][-1]["outputCents"], "contractFulfilled": got["contractFulfilled"],
                          "notPassed": [r for r in got["rules"] if r["result"] != "PASS"], "supersedes": s["eng"], "documentVersions": relied})
        s.update(last=(asof, facts, relied), eng=len(s["rows"]) - 1, cur=len(s["rows"]) - 1, level=0, pend_on=asof if got["outcome"] == "PEND" else None)

    for i, ev in enumerate(f["events"]):
        a, asof, extra = ev["action"], ev["asOf"], {}
        t = a["type"]
        chk(i == 0 or asof >= f["events"][i - 1]["asOf"], f"{fid} event {i}: goes back in time")
        if t == "open":
            chk(i == 0 and all(byid.get(x, {}).get("source") == "input" for x in a["facts"]), f"{fid}: open is first and carries input facts only")
            s.update(status="OPEN", intake=a["facts"])
            run(i, asof)
        elif t == "upload":
            for k, v in s["vers"].items():
                if of(k) == a["doc"]: v["status"] = "superseded"
            chk(a["version"] == f"{a['doc']}/{1 + sum(of(k) == a['doc'] for k in s['vers'])}", f"{fid} event {i}: version number")
            s["vers"][a["version"]] = {"status": "received", "facts": {}}
            if s["status"] == "CLOSED_NO_RESPONSE": move(i, "REOPENED")
        elif t in ("reject", "accept"):
            v = s["vers"][a["version"]]
            chk(v["status"] == "received", f"{fid} event {i}: only a received version is accepted or rejected")
            v["status"] = t + "ed"
            if t == "accept":
                chk(all(byid.get(x, {}).get("source") == "input" for x in a["facts"]), f"{fid} event {i}: entered facts must be input facts")
                v["facts"] = a["facts"]
                run(i, asof)
        elif t == "waive":
            chk(authority(pick_ops(asof, FILE_VERSIONS), a["by"], "waive_documents", s["paid"], 0)["allowed"] and a["reasonText"], f"{fid} event {i}: waiver without the power or a reason")
            s["waived"].append(a["doc"])
            run(i, asof)
        elif t == "tick":
            if s["status"] == "PENDING_EVIDENCE":
                rem, days = RS[pick_ops(asof, FILE_VERSIONS)]["reminders"], (D(asof) - D(s["pend_on"])).days
                if days >= rem["closeDay"]: move(i, "CLOSED_NO_RESPONSE")
                else: s["level"] = max(s["level"], 2 if days >= rem["secondDay"] else 1 if days >= rem["firstDay"] else 0)
        elif t == "override":
            e = s["rows"][s["eng"]]
            ops_name = pick_ops(asof, FILE_VERSIONS)
            au = authority(ops_name, a["by"], "clear_flags" if flag_ids & set(e["reasons"]) else None, s["paid"], a["amountCents"])
            chk(s["cur"] == s["eng"] and e["outcome"] == "REFER" and au["allowed"] and a["reasonCode"] and a["reasonText"], f"{fid} event {i}: override of a non-referral, out of authority, or without a reason")
            chk(a["amountCents"] == e["payableCents"], f"{fid} event {i}: these fixtures approve the engine's calculated amount")
            s["rows"].append({"kind": "override", "ops": ops_name, "outcome": a["outcome"], "payableCents": a["amountCents"], "overrides": s["eng"], "by": a["by"],
                              "totalIncurredCents": au["totalIncurredCents"], "documentVersions": e["documentVersions"]})
            s["cur"] = len(s["rows"]) - 1
            move(i, "DECIDED")
        elif t == "pay":
            d = s["rows"][s["cur"]]
            due = (d["payableCents"] or 0) - s["paid"]
            chk(d["outcome"] in ("APPROVE", "PARTIAL") and due > 0, f"{fid} event {i}: nothing to pay")
            move(i, "PAYMENT_PENDING", "PAID", "CLOSED")
            s.update(paid=s["paid"] + due, pay="PAID")
            extra = {"paymentCents": due}
        elif t == "reopen":
            move(i, "REOPENED")
        else:
            chk(False, f"{fid} event {i}: unknown action {t}")
        got = {"claimStatus": s["status"], "paymentStatus": s["pay"], "paidCents": s["paid"], "reminderLevel": s["level"], "docs": {d: doc(d) for d in doc_types},
               "versions": {k: v["status"] for k, v in s["vers"].items()}, "decisionRows": len(s["rows"]), "decision": {"row": s["cur"], **s["rows"][s["cur"]]}, **extra}
        e = ev["expected"]
        chk(got == e, f"{fid} event {i} ({t}): replay disagrees with the oracle on " + ", ".join(k for k in sorted(set(got) | set(e)) if got.get(k) != e.get(k)))

    key = LIFE_KEY[fid]
    chk([("E" if r["kind"] == "engine" else "O", r["outcome"], r["payableCents"]) for r in s["rows"]] == key["rows"], f"{fid}: decision rows differ from the key")
    chk((s["status"], s["pay"], s["paid"]) == key["end"], f"{fid}: ends {s['status']} {s['pay']} {s['paid']}, key {key['end']}")
    chk(all(r["outcome"] != "DENY" for r in s["rows"]) or fid == "EV-02", f"{fid}: a denial where none belongs")
    return s


def check_lives():
    ev = lambda fid, i: fx[fid]["events"][i]["expected"]
    # EV-01: every required document for the peril is its own reason. EV-02: the denial never reaches the evidence stage.
    chk({"E20.proofOfPurchase", "E20.repairEstimate", "E20.damagePhotos", "E20.incidentStatement"} <= set(ev("EV-01", 0)["decision"]["reasons"]), "EV-01: four documents, four reasons")
    chk(ev("EV-02", 0)["decision"]["reasons"] == ["E6"] and set(ev("EV-02", 0)["docs"].values()) == {"requested"}, "EV-02: denied on E6, nothing asked for")
    chk(ev("EV-03", -1)["versions"] == {"repairEstimate/1": "superseded", "repairEstimate/2": "accepted"}, "EV-03: the first version is superseded, not gone")
    a, b = ev("EV-04", 2)["decision"], ev("EV-04", -1)["decision"]
    chk(fx["EV-04"]["events"][2]["action"]["facts"] == fx["EV-04"]["events"][-1]["action"]["facts"] and len({e["asOf"] for e in fx["EV-04"]["events"]}) == 1
        and {k: v for k, v in a.items() if k not in ("row", "supersedes", "documentVersions")} == {k: v for k, v in b.items() if k not in ("row", "supersedes", "documentVersions")}
        and (a["documentVersions"], b["documentVersions"], b["supersedes"]) == (["repairEstimate/1"], ["repairEstimate/2"], a["row"]),
        "EV-04: same date, facts and outcome; only the version relied on differs, and the later decision supersedes")
    chk(ev("EV-05", -2)["decision"]["outcome"] == "PEND" and len(ev("EV-05", -1)["decision"]["documentVersions"]) == 4, "EV-05: the last acceptance decides, on four versions")
    # GC-11, typed from domain brief s6 and s11: reminder on day 10 and 20, closed on day 30, no denial, reopened by the document
    ticks = [(e["asOf"], e["expected"]["reminderLevel"], e["expected"]["claimStatus"], e["expected"]["decisionRows"]) for e in fx["GC-11"]["events"] if e["action"]["type"] == "tick"]
    pend = next(e["asOf"] for e in reversed(fx["GC-11"]["events"]) if e["action"]["type"] == "accept" and e["expected"]["decision"]["outcome"] == "PEND")
    chk([((D(d) - D(pend)).days, lv, st) for d, lv, st, _ in ticks] == [(9, 0, "PENDING_EVIDENCE"), (10, 1, "PENDING_EVIDENCE"), (20, 2, "PENDING_EVIDENCE"), (30, 2, "CLOSED_NO_RESPONSE")]
        and len({n for *_, n in ticks}) == 1 and ev("GC-11", len(fx["GC-11"]["events"]) - 3)["decision"]["reasons"][0] == "E20.proofOfPurchase",
        f"GC-11: reminders and close differ from the brief: {ticks}")
    chk(ev("GC-11", -2)["claimStatus"] == "REOPENED", "GC-11: the arriving document reopens the claim")
    # GC-15: the last event of each numbered step against the brief
    last = {}
    for e in fx["GC-15"]["events"]:
        for n in (e["step"] if isinstance(e["step"], list) else [e["step"]]): last[n] = e["expected"]
    got = {n: (x["claimStatus"], x["decision"]["outcome"], x["decision"]["payableCents"], x["paidCents"]) for n, x in last.items() if n != 4}
    chk(got == GC15_KEY, f"GC-15: steps differ from the brief: {got}")
    chk(last[2]["reminderLevel"] == 1 and last[2]["decision"]["reasons"][:2] == ["E5", "E20.repairEstimate"] and last[3]["decision"]["reasons"] == ["E21"], "GC-15 steps 2-3: estimate missing with one reminder, then E21")
    chk(last[4]["docs"]["secondEstimate"] == "waived" and last[5]["decision"]["reasons"] == ["F2", "E23"] and last[5]["decision"]["path"] == "repair", "GC-15 steps 4-5: waiver, then a repair referred on F2 and E23")
    chk((last[6]["decision"]["by"], last[6]["decision"]["totalIncurredCents"]) == ("adjuster", 85100), "GC-15 step 6: adjuster, 85100 incurred")
    pays = [e["expected"]["paymentCents"] for e in fx["GC-15"]["events"] if e["action"]["type"] == "pay"]
    eng8 = next(e["expected"]["decision"] for e in fx["GC-15"]["events"] if e["action"].get("version") == "repairEstimate/2" and e["action"]["type"] == "accept")
    chk(pays == [85100, 85000] and (eng8["path"], eng8["aggregateRemainingAfterCents"], eng8["contractFulfilled"]) == ("replace", 209900, False)
        and (last[8]["decision"]["by"], last[8]["decision"]["totalIncurredCents"]) == ("senior", 170100)
        and not authority("ops-v1", "adjuster", "clear_flags", 85100, 170100)["allowed"],
        f"GC-15 step 8: supplemental 85000 on a 170100 replacement, 209900 left, senior adjuster: {pays} {eng8['path']} {eng8['aggregateRemainingAfterCents']}")
    # GC-05's sign-off: the referral is approved at the engine's 77500 by an adjuster
    so, g5 = fx["GC-05"]["signoff"], fx["GC-05"]["expected"]
    au = authority(pick_ops(so["asOf"], FILE_VERSIONS), so["by"], "clear_flags" if any(r.startswith("F") for r in g5["reasons"]) else None, so["paidCents"], so["amountCents"])
    chk(so["asOf"] > fx["GC-05"]["asOf"] and so["expected"] == {"kind": "override", "ops": pick_ops(so["asOf"], FILE_VERSIONS), "outcome": "APPROVE", "payableCents": 77500, "claimStatus": "DECIDED", "authority": au}
        and au["allowed"] and so["amountCents"] == g5["payableCents"] == 77500 and so["reasonCode"] and so["reasonText"], f"GC-05 sign-off: {so['expected']} / {au}")


fx = {os.path.basename(p)[:-5]: load(p) for p in sorted(glob.glob(f"{FIX}/*/*.json"))}
want = [f"RE-{i:02d}" for i in range(1, 24)] + sorted(PAY_KEY) + sorted(GC_KEY) + ["RV-01"] + sorted(VP_KEY) + sorted(PL_KEY) + sorted(PL_RUNS_KEY) + ["PL-01"] + sorted(OV_KEY) + sorted(LIFE_KEY)
chk(sorted(fx) == sorted(want), f"fixture set differs: missing {sorted(set(want) - set(fx))}, extra {sorted(set(fx) - set(want))}")

for fid, f in fx.items():
    k = f["kind"]
    if k in ("decision", "valuation"):
        inputs = [x for x in f["facts"] if byid.get(x, {}).get("source") != "input"]
        chk(not inputs, f"{fid}: facts not declared as inputs: {inputs}")
        got = decide(RS[f.get("plan", "plan-v1")], RS[f.get("ops", "ops-v1")], dic, f["facts"])
        e = f["expected"]
        if k == "decision":
            chk(f["ops"] == pick_ops(f["asOf"], FILE_VERSIONS), f"{fid}: names {f['ops']}, but {pick_ops(f['asOf'], FILE_VERSIONS)} is in force on {f['asOf']}")
            chk(got == e, f"{fid}: interpreter disagrees with the oracle: " + "; ".join(x for x in e if got.get(x) != e[x]))
            o, p, rs = GC_KEY[fid]
            chk(e["outcome"] == o and e["reasons"] == rs, f"{fid}: outcome/reasons differ from the brief ({e['outcome']} {e['reasons']})")
            chk(p is None or e["payableCents"] == p, f"{fid}: payable {e['payableCents']} != brief {p}")
            chk((e["payableCents"] is None) == (fid in DENY_ONLY_PAYABLE_NULL), f"{fid}: denied claims carry a null amount, others a number")
            chk(not any(r["result"] == "GAP" for r in e["rules"]), f"{fid}: a rule had no matching row")
        else:
            chk(got["payableCents"] == e["payableCents"] == PAY_KEY[fid], f"{fid}: payable {got['payableCents']} / {e['payableCents']} != brief {PAY_KEY[fid]}")
            chk(got["valuation"] == {"path": e["path"], "steps": e["steps"]}, f"{fid}: calc trace disagrees")
            chk(got["contractFulfilled"] == e["contractFulfilled"], f"{fid}: contractFulfilled")
    elif k == "rule-version":
        chk([c["plan"] for c in f["cases"]] == [p for p, _, _ in RV_KEY] and len({c["asOf"] for c in f["cases"]}) == 1, f"{fid}: one claim, one asOf, a v1 and a v2 contract")
        claim = [{x: v for x, v in c["facts"].items() if x.startswith("claim.")} for c in f["cases"]]  # the loss; product dates follow each sale
        chk(claim[0] == claim[1], f"{fid}: the claim facts differ between the two contracts")
        for c, (p, o, amt) in zip(f["cases"], RV_KEY):
            got = decide(RS[c["plan"]], RS[c["ops"]], dic, c["facts"])
            chk(got == c["expected"], f"{fid} {p}: interpreter disagrees with the oracle")
            chk(c["ops"] == pick_ops(c["asOf"], FILE_VERSIONS), f"{fid} {p}: wrong ops for {c['asOf']}")
            chk((c["expected"]["outcome"], c["expected"]["payableCents"]) == (o, amt), f"{fid} {p}: {c['expected']['outcome']} {c['expected']['payableCents']} != {o} {amt}")
    elif k == "selection":
        for v in f["versions"]:
            chk(v["name"] not in RS or v["effectiveFrom"] == RS[v["name"]]["effectiveFrom"], f"{fid}: {v['name']} effectiveFrom differs from the rule file")
        for c, key in zip(f["cases"], VP_KEY[fid]):
            vs = c.get("versions", f["versions"])
            pin = next(v for v in vs if v["name"] == c["contract"]["planVersion"])
            o = pick_ops(c["asOf"], vs)
            got = {"error": "NO_EFFECTIVE_VERSION", "kind": "plan"} if D(pin["effectiveFrom"]) > D(c["asOf"]) else \
                  {"plan": pin["name"], "ops": o} if o else {"error": "NO_EFFECTIVE_VERSION", "kind": "ops"}
            chk(got == c["expected"] and tuple(c["expected"].values()) == key, f"{fid} '{c['name']}': {c['expected']} / {got} / key {key}")
        chk(len(f["cases"]) == len(VP_KEY[fid]), f"{fid}: case count")
    elif k == "transitions":
        got = {f"{t['from']}>{t['to']}" + (f"?{t['when']}" if "when" in t else "") for t in f["transitions"]}
        chk(got == set(PL01_KEY.split()) and len(f["transitions"]) == len(got), f"{fid}: table differs from the key: {sorted(got ^ set(PL01_KEY.split()))}")
        sql = open(os.path.join(HERE, "..", "prisma/migrations/20261003000000_contract_claim/migration.sql")).read()
        chk(sorted(f["statuses"]) == sorted(re.findall(r"'([A-Z_]+)'", sql.split("claim_status CHECK")[1].split("))")[0])), f"{fid}: statuses differ from the claim_status CHECK")
        for c in f["guardCases"]:
            d = c["decision"]
            legal = sorted(to for to, g in PL01_GUARD.items() if d and g(d["outcome"], d["payableCents"]))
            chk(legal == sorted(c["legal"]), f"{fid} '{c['name']}': {c['legal']} != {legal}")
    elif k == "readjudication":
        # D40: a row is written exactly when asOf or the facts differ from the last decision's, and only from a status PL-01 lets into IN_REVIEW
        chk(len(f["runs"]) == len(PL_RUNS_KEY[fid]), f"{fid}: run count")
        facts, last, status, rows, wrote = dict(f["facts"]), None, "OPEN", 0, None
        for i, (r, key) in enumerate(zip(f["runs"], PL_RUNS_KEY[fid])):
            facts.update(r["change"]); e = r["expected"]
            chk(r["ops"] == pick_ops(r["asOf"], FILE_VERSIONS) and r["statusBefore"] == status, f"{fid} run {i}: ops or statusBefore")
            if last != (r["asOf"], facts):
                chk(any(t["from"] == status and t["to"] == "IN_REVIEW" for t in fx["PL-01"]["transitions"]), f"{fid} run {i}: {status} cannot be reviewed")
                got = decide(RS[f["plan"]], RS[r["ops"]], dic, facts)
                chk(all(got[x] == e[x] for x in ("outcome", "reasons", "payableCents")), f"{fid} run {i}: interpreter disagrees with the oracle")
                chk(e["decision"] == i and e["supersedes"] == wrote, f"{fid} run {i}: a changed input writes a decision that supersedes the last")
                last, rows, wrote = (r["asOf"], dict(facts)), rows + 1, i
            chk((e["outcome"], e["payableCents"], e["decision"], e["supersedes"]) == key, f"{fid} run {i}: {e} != key {key}")
            chk(e["decisionRows"] == rows and e["claimStatus"] == PL_STATUS_FOR[e["outcome"]], f"{fid} run {i}: row count or claim status")
            status = e["claimStatus"]
    elif k == "authority":
        chk(len(f["cases"]) == len(OV_KEY[fid]), f"{fid}: case count")
        for c, allowed in zip(f["cases"], OV_KEY[fid]):
            got = authority(f["ops"], c["tier"], c["power"], c["paidCents"], c["amountCents"])
            chk(got == c["expected"] and got["allowed"] is allowed, f"{fid} '{c['name']}': {c['expected']} / {got} / key {allowed}")
    elif k == "lifecycle":
        replay(fid, f)
    elif k == "pipeline":
        chk(f["expected"] == PL_KEY[fid] and f["claim"]["contractId"] not in f["contracts"], f"{fid}: {f['expected']}")
    elif k == "ref":
        t = fx[f["ref"]]["expected"]
        chk(t["payableCents"] is None and t["valuation"] is None and f["expected"]["payableCents"] is None and PAY_KEY[fid] is None, f"{fid}: a denial carries a null amount and no valuation")
    elif k == "condition":
        for c in f["cases"]:
            chk(tv(cell(c.get("cell", f["cell"]), lambda x, ff=c["facts"]: ff.get(x))) == c["expected"], f"{fid}: {c}")
    elif k == "condition-list":
        for c in f["cases"]:
            chk(tv(cell(c["cell"], lambda x, ff=c["facts"]: ff.get(x))) == c["expected"], f"{fid}: {c['cell']} {c['facts']}")
    elif k == "row":
        for c in f["cases"]:
            chk(tv(row(f["when"], lambda x, ff=c["facts"]: ff.get(x))) == c["expected"], f"{fid}: {c['facts']}")
    elif k == "rule":
        for c in f["cases"]:
            chk(rule(c["rule"], lambda x, ff=c["facts"]: ff.get(x)) == c["expected"], f"{fid}: {c['facts']} -> {rule(c['rule'], lambda x, ff=c['facts']: ff.get(x))}")
    elif k == "calc":
        regs = {}
        got = run_steps(f["steps"], lambda x: f["facts"][x], regs)
        chk(got == f["expected"]["steps"] and regs == f["expected"]["registers"], f"{fid}: calc trace disagrees: {got} {regs}")
    elif k == "validate":
        chk(all(c["expectedCodes"] for c in f["cases"]), f"{fid}: every case names the codes it must raise (checked by tests/rules, not here)")
    else:
        chk(False, f"{fid}: unknown fixture kind {k}")

check_lives()

if fails:
    print("FAIL")
    for m in fails: print(" -", m)
    sys.exit(1)
print(f"OK ({len(fx)} fixtures: {sum(1 for f in fx.values() if f['id'].startswith('RE'))} RE, {sum(1 for f in fx.values() if f['id'].startswith('PAY'))} PAY, "
      f"{sum(1 for f in fx.values() if f['id'].startswith('GC'))} GC, {sum(1 for f in fx.values() if f['id'][:2] in ('RV', 'VP', 'PL', 'EV', 'OV'))} RV/VP/PL/EV/OV; "
      "payables match the brief to the cent)")
