# -*- coding: utf-8 -*-
"""gen-voices.py — 一次性构建脚本：用 Microsoft Edge 神经网络 TTS 生成
游戏内真人语音 MP3，并转为 Base64 写入 js/voice-data.js（file:// 零跨域直放）。

用法：
    python scripts/gen-voices.py [代理地址]
    例：python scripts/gen-voices.py http://127.0.0.1:64901

产物：
    assets/audio/{chi,pong,kong,zimo,hu,ting}.mp3
    js/voice-data.js   →  global.MJ_VOICE_DATA = { chi: 'data:audio/mpeg;base64,...', ... }
"""
import asyncio
import base64
import os
import sys

import edge_tts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, 'assets', 'audio')

# 词条 → (文案, 音色, 语速, 音调)。按事件绑定不同角色专属音色：
#   吃 = 元气少女(晓伊) / 碰·自摸·听牌 = 清亮御姐(晓晓) / 杠 = 沉稳磁性男声(云健)
ENTRIES = [
    ('chi',  '吃！',   'zh-CN-XiaoyiNeural',   '+12%', '+8Hz'),
    ('pong', '碰！',   'zh-CN-XiaoxiaoNeural', '+8%',  '+4Hz'),
    ('kong', '杠！',   'zh-CN-YunjianNeural',  '+6%',  '-2Hz'),
    ('zimo', '自摸！', 'zh-CN-XiaoxiaoNeural', '+4%',  '+6Hz'),
    ('hu',   '胡啦！', 'zh-CN-XiaoyiNeural',   '+2%',  '+10Hz'),
    ('ting', '听牌！', 'zh-CN-XiaoxiaoNeural', '+2%',  '+2Hz'),
]


async def gen(proxy):
    os.makedirs(AUDIO_DIR, exist_ok=True)
    for key, text, voice, rate, pitch in ENTRIES:
        out = os.path.join(AUDIO_DIR, key + '.mp3')
        if os.path.exists(out) and os.path.getsize(out) > 2000:
            print('skip (exists):', key)
            continue
        for attempt in (1, 2, 3):
            try:
                kwargs = {}
                if proxy:
                    kwargs['proxy'] = proxy
                c = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, **kwargs)
                await c.save(out)
                size = os.path.getsize(out)
                if size > 2000:
                    print('gen %-5s %-22s %6d bytes' % (key, voice, size))
                    break
            except Exception as e:
                print('retry %d %s: %s' % (attempt, key, e))
                await asyncio.sleep(1.5)
        else:
            raise SystemExit('FAILED to generate: ' + key)


def build_js():
    lines = [
        '/* voice-data.js — 内置真人神经网络语音包（由 scripts/gen-voices.py 生成，勿手改）',
        '   数据为 MP3 的 Base64 data-URI，file:// 协议下零跨域直接播放。 */',
        '(function (global) {',
        "  'use strict';",
        '  global.MJ_VOICE_DATA = {',
    ]
    for key, _, _, _, _ in ENTRIES:
        p = os.path.join(AUDIO_DIR, key + '.mp3')
        with open(p, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('ascii')
        lines.append("    %s: 'data:audio/mpeg;base64,%s'," % (key, b64))
    lines += ['  };', "})(typeof window !== 'undefined' ? window : this);", '']
    out = os.path.join(ROOT, 'js', 'voice-data.js')
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    print('wrote', out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    proxy = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(gen(proxy))
    build_js()
