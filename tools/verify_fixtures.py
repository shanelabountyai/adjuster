#!/usr/bin/env python3
"""Second derivation for Adjuster's fixtures. Exit 0 and print OK only if every frozen fixture agrees.

build_fixtures.py adjudicates procedurally from the domain brief. This script derives the same answers a DIFFERENT way:
it interprets rules/electronics/{facts,plan,ops}-v1.json (the rule data the product will load) with decimal.Decimal
arithmetic and Kleene three-valued logic, and checks the result against the fixtures and against answer keys typed
in below straight from the brief. So it proves two things at once: the fixtures are right, and the rule data encodes
the brief. It is a test oracle in tools/, not product code. Stdlib only.
"""
import datetime as dt, glob, json, os, sys
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
PAY_KEY = {"PAY-A": 22500, "PAY-B": 77500, "PAY-C": 0, "PAY-D": 30000, "PAY-E": 46500, "PAY-F": 90100, "PAY-G": 50000, "PAY-H": None}
GC_KEY = {  # outcome, payable (None = not stated in the brief), reasons
    "GC-01": ("APPROVE", 25000, []), "GC-02": ("DENY", None, ["E6"]), "GC-03": ("DENY", None, ["E3"]), "GC-04": ("DENY", None, ["E2", "E7"]),
    "GC-05": ("REFER", 77500, ["E23"]), "GC-06": ("APPROVE", 0, []), "GC-07": ("PARTIAL", 30000, []), "GC-08": ("APPROVE", 46500, []),
    "GC-09": ("DENY", None, ["E15"]), "GC-10": ("REFER", None, ["E5"]),
}
DENY_ONLY_PAYABLE_NULL = {"GC-02", "GC-03", "GC-04", "GC-09"}

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
        missing = sorted({x for w in unknown for c in w["when"] if cell(c, get) is None for x in roots(c["fact"])})
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

dic, plan, ops = load(f"{RULES}/facts-v1.json"), load(f"{RULES}/plan-v1.json"), load(f"{RULES}/ops-v1.json")
byid = {x["id"]: x for x in dic["facts"]}

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

fx = {os.path.basename(p)[:-5]: load(p) for p in sorted(glob.glob(f"{FIX}/*/*.json"))}
want = [f"RE-{i:02d}" for i in range(1, 24)] + sorted(PAY_KEY) + sorted(GC_KEY)
chk(sorted(fx) == sorted(want), f"fixture set differs: missing {sorted(set(want) - set(fx))}, extra {sorted(set(fx) - set(want))}")

for fid, f in fx.items():
    k = f["kind"]
    if k in ("decision", "valuation"):
        inputs = [x for x in f["facts"] if byid.get(x, {}).get("source") != "input"]
        chk(not inputs, f"{fid}: facts not declared as inputs: {inputs}")
        got = decide(plan, ops, dic, f["facts"])
        e = f["expected"]
        if k == "decision":
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

if fails:
    print("FAIL")
    for m in fails: print(" -", m)
    sys.exit(1)
print(f"OK ({len(fx)} fixtures: {sum(1 for f in fx.values() if f['id'].startswith('RE'))} RE, {sum(1 for f in fx.values() if f['id'].startswith('PAY'))} PAY, "
      f"{sum(1 for f in fx.values() if f['id'].startswith('GC'))} GC; payables match the brief to the cent)")
