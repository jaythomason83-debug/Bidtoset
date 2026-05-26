s = open("src/App.jsx").read()
old = "      const t0 = splitTeam(gs.teams[0]);\n      const t1 = splitTeam(gs.teams[1]);\n      setSetupPlayerNames([t0[0], t0[1], t1[0], t1[1]]);"
new = "      setSetupPlayerNames([\"\", \"\", \"\", \"\"]);\n      setSetupTeamNames([\"\", \"\"]);"
print("Matches:", s.count(old))
s.count(old)==1 and open("src/App.jsx","w").write(s.replace(old,new))
print("done")
