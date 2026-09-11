import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

client = [os.environ["PI_CHILD_NODE"], os.environ["PI_CHILD_CLI"]]


def call(*args):
    return json.loads(subprocess.check_output(client + list(args), encoding="utf-8"))


tasks = [
    "Review src/ for correctness bugs. Do not modify files. Report concrete findings with file paths.",
    "Review test/ for important missing coverage. Do not modify files. Report concrete gaps with file paths.",
]

with ThreadPoolExecutor(max_workers=2) as pool:
    children = list(pool.map(lambda task: call("start", "--task", task), tasks))
    results = list(pool.map(lambda child: call("result", child["id"], "--wait"), children))

print(json.dumps(results, indent=2))
raise SystemExit(0 if all(result["status"] == "completed" for result in results) else 1)
