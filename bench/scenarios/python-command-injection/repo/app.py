import subprocess

from flask import Flask, request

app = Flask(__name__)


@app.route("/report")
def report():
    target = request.args["dir"]
    subprocess.run(f"ls {target}", shell=True)
    return "ok"
