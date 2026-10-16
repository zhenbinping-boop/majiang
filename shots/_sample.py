
from PIL import Image
import json, sys
out = []
for n in ['jade', 'ocean', 'sandal']:
    im = Image.open(r'shots/theme-verify-%s.png' % n).convert('RGB')
    # 绒毡采样点：左上象限绒毡空区（避开罗盘/牌）
    pts = [(280, 260), (1160, 260), (720, 150)]
    out.append({n: [im.getpixel(p) for p in pts]})
print(json.dumps(out))
