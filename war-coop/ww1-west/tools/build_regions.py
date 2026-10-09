"""一戰西線(1914)戰略區建構腳本。輸入:centroids.json adj_fine.json city_cells.json;輸出 regions_v2_full.json。
規則:同國別(1914)才合併;近前線小區、遠處大區;指定城市強制獨立成區;科西嘉剔除。"""
import json,math,collections,sys
cen=json.load(open("centroids.json")); adj=json.load(open("adj_fine.json")); cc=json.load(open("city_cells.json"))
def owner(k): return "DE" if k in ("FRF11","FRF12","FRF33") else k[:2]   # 1914:亞爾薩斯-洛林屬德國
EXCLUDE={k for k in cen if k.startswith("FRM")}                              # 科西嘉
play={k for k in cen if k in adj and k not in EXCLUDE}
FORCE={"巴黎":"capital_fr","柏林":"capital_de","凡爾登":"fortress","列日":"fortress","那慕爾":"fortress","史特拉斯堡":"fortress","梅茲":"fortress","盧森堡":"hub","伊珀爾":"battlefield","色當":"battlefield","蘭斯":"battlefield","馬恩河(莫城)":"battlefield","里爾":"battlefield"}
seeds={cc[n]:(n,t) for n,t in FORCE.items() if cc.get(n) in play}
front=[(cen[k][0],cen[k][1]) for k in ("FRF21","FRF32","FRF31","FRF12")]
def d_front(k): x,y,_=cen[k]; return min(math.hypot(x-a,y-b) for a,b in front)
BASE={"FR":520,"DE":400,"BE":140,"LU":999}
def target(k,forced=False):
    if forced: return 0.7*BASE[owner(k)] if owner(k)!="BE" else 60
    d=d_front(k); f=0.55 if d<35 else 1.0 if d<75 else 1.8
    return BASE[owner(k)]*f
assigned={}; regions=[]; meta=[]
def grow(s,T,tag=None,name=None):
    reg=[s]; assigned[s]=len(regions); area=cen[s][2]
    while area<T:
        cand=[n for u in reg for n in adj.get(u,[]) if n in play and n not in assigned and owner(n)==owner(s) and n not in seeds]
        if not cand: break
        sx,sy,_=cen[s]; n=min(cand,key=lambda c:math.hypot(cen[c][0]-sx,cen[c][1]-sy))
        reg.append(n); assigned[n]=len(regions); area+=cen[n][2]
    regions.append(reg); meta.append((tag,name))
# 先長強制區(各自獨立),再長其餘
for cell,(name,tag) in seeds.items(): grow(cell,target(cell,True),tag,name)
for s in sorted(play,key=d_front):
    if s not in assigned: grow(s,target(s))
def area(r): return sum(cen[k][2] for k in r)
changed=True
while changed:
    changed=False
    for i,r in enumerate(regions):
        if not r or meta[i][0]: continue
        if area(r)<0.35*target(r[0]):
            ns=collections.Counter()
            for u in r:
                for n in adj.get(u,[]):
                    j=assigned.get(n)
                    if j is not None and j!=i and regions[j] and owner(n)==owner(r[0]) and not meta[j][0]: ns[j]+=1
            if ns:
                j=min(ns,key=lambda j:area(regions[j]))
                for u in r: assigned[u]=j
                regions[j]+=r; regions[i]=[]; changed=True
keep=[i for i,r in enumerate(regions) if r]
remap={old:new for new,old in enumerate(keep)}
regions2=[regions[i] for i in keep]; meta2=[meta[i] for i in keep]
cell2reg={k:remap[v] for k,v in assigned.items() if v in remap}
radj=collections.defaultdict(set)
for u,ns in adj.items():
    if u not in cell2reg: continue
    for n in ns:
        if n in cell2reg and cell2reg[n]!=cell2reg[u]: radj[cell2reg[u]].add(cell2reg[n])
rows=[]
for i,r in enumerate(regions2):
    A=sum(cen[k][2] for k in r)
    rows.append(dict(id=i,owner=owner(r[0]),tag=meta2[i][0],name=meta2[i][1],cells=r,area=round(A),
        cx=round(sum(cen[k][0]*cen[k][2] for k in r)/A,1),cy=round(sum(cen[k][1]*cen[k][2] for k in r)/A,1),
        rear=d_front(r[0])>=75 and not meta2[i][0],adj=sorted(radj[i])))
json.dump(rows,open("regions_v2_full.json","w"),ensure_ascii=False)
by=collections.Counter(r["owner"] for r in rows)
print("戰略區",len(rows),dict(by),"後方區",sum(r["rear"] for r in rows),"強制獨立區",sum(1 for r in rows if r["tag"]))
deg=[len(r["adj"]) for r in rows]; print("鄰接度 平均 %.1f 最小 %d 最大 %d"%(sum(deg)/len(deg),min(deg),max(deg)))
print("孤立區:",[(r["id"],r["owner"],r["adj"]) for r in rows if len(r["adj"])<=1])
