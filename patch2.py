s = open("src/App.jsx").read()
old = """  return {\n    teams: [\n      { name: t0 ? t0.name : "Team 1", score: 0, bags: 0, p: t0 ? [t0.p[0], t0.p[1]] : ["Player 1", "Player 2"] },\n      { name: t1 ? t1.name : "Team 2", score: 0, bags: 0, p: t1 ? [t1.p[0], t1.p[1]] : ["Player 3", "Player 4"] },\n    ],"""
new = """  return {\n    teams: [\n      { name: "Team 1", score: 0, bags: 0, p: ["Player 1", "Player 2"] },\n      { name: "Team 2", score: 0, bags: 0, p: ["Player 3", "Player 4"] },\n    ],"""
print("Matches:", s.count(old))
s.count(old)==1 and open("src/App.jsx","w").write(s.replace(old,new))
print("done")
