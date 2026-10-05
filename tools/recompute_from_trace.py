#!/usr/bin/env python3
"""Hand-recompute oracle (task 2.10, D43). A test oracle, not product code: never import or port it.

Reads stored explanations on stdin, one JSON object per line: {"id": ..., "explanation": <adjuster.trace/1>}.
From the explanation alone (no rule set, no facts, no engine) it redoes the payout arithmetic step by step and
compares the result with the amount the explanation states. Prints {id: recomputed payableCents} as JSON.
Exits 1 on any disagreement, on a step that does not follow from the one before it, and on empty input.
"""
import json
import sys


def half_up(n, d):  # the one rounding rule (D16): integers only, .5 away from zero
    q, r = divmod(abs(n), abs(d))
    q += 2 * r >= abs(d)
    return -q if (n < 0) != (d < 0) else q


OPS = {
    "start_from": lambda a, v: v,
    "subtract": lambda a, v: a - v,
    "apply_bps": lambda a, v: half_up(a * v, 10000),
    "cap_at": min,
    "floor_at": max,
}


def payable(t):
    v, outcome = t["valuation"], t["decision"]["outcome"]
    if (v is None) != (outcome in ("DENY", "PEND")):
        raise ValueError(f"{outcome} with{'out' if v is None else ''} a valuation")
    if v is None:
        return None  # denied or pended: no amount, never 0
    regs = {}
    for s in v["steps"]:
        if not s["applied"]:
            continue
        if s["op"] not in OPS:  # min_of: the trace does not store its operands (open, D43)
            raise ValueError(f"{s['id']}: {s['op']} cannot be recomputed from the trace")
        o = s["operand"]
        a = None if s["op"] == "start_from" else regs[s["reg"]]
        if a != s["inputCents"]:
            raise ValueError(f"{s['id']}: input {s['inputCents']}, but {s['reg']} holds {a}")
        if o["kind"] == "reg" and regs[o["name"]] != o["value"]:
            raise ValueError(f"{s['id']}: operand {o['name']} {o['value']}, but it holds {regs[o['name']]}")
        regs[s["reg"]] = OPS[s["op"]](a, o["value"])
        if regs[s["reg"]] != s["outputCents"]:
            raise ValueError(f"{s['id']}: output {s['outputCents']}, recomputed {regs[s['reg']]}")
    return regs[v["outputs"]["payableCents"]]


def main():
    out, bad = {}, 0
    for line in filter(str.strip, sys.stdin):
        row = json.loads(line)
        try:
            out[row["id"]] = payable(row["explanation"])
            stated = row["explanation"]["decision"]["payableCents"]
            if out[row["id"]] != stated:
                raise ValueError(f"explanation states {stated}, recomputed {out[row['id']]}")
        except (ValueError, KeyError, TypeError) as e:
            bad += 1
            print(f"{row.get('id')}: {e!r}", file=sys.stderr)
    if not out:
        print("no explanations on stdin", file=sys.stderr)
    print(json.dumps(out))
    return 1 if bad or not out else 0


if __name__ == "__main__":
    sys.exit(main())
