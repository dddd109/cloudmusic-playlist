#!/usr/bin/env node
// generate_m3u8.js — 从网易云歌单生成 PotPlayer m3u8 播放列表
// 用法: node generate_m3u8.js <歌单ID> <MUSIC_U cookie>
// 示例: node generate_m3u8.js 5367497751 "你的MUSIC_U值"

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PLAYLIST_ID = process.argv[2];
const MUSIC_U = process.argv[3];

if (!PLAYLIST_ID || !MUSIC_U) {
    console.error('用法: node generate_m3u8.js <歌单ID> <MUSIC_U>');
    console.error('MUSIC_U 获取: 浏览器登录 music.163.com → F12 → Application → Cookies → MUSIC_U');
    process.exit(1);
}

const MUSIC_DIR = __dirname;

function fetch(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://music.163.com/',
                'Cookie': `MUSIC_U=${MUSIC_U}`
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

async function main() {
    console.log(`正在获取歌单 ${PLAYLIST_ID} ...`);

    // 1. 获取歌单详情（包含全部曲目数据，非顺序）
    const detailUrl = `https://music.163.com/api/playlist/detail?id=${PLAYLIST_ID}&limit=1000`;
    const detailData = JSON.parse(await fetch(detailUrl));
    if (detailData.code !== 200) throw new Error(`API error: ${detailData.message || detailData.code}`);

    // 2. 获取歌单排序（v6 API 的 trackIds 按歌单顺序排列）
    const v6Url = `https://music.163.com/api/v6/playlist/detail?id=${PLAYLIST_ID}`;
    const v6Data = JSON.parse(await fetch(v6Url));
    if (v6Data.code !== 200) throw new Error(`V6 API error: ${v6Data.message || v6Data.code}`);

    // 3. 构建 track ID → track 信息 映射
    const trackMap = {};
    for (const t of detailData.result.tracks) {
        trackMap[t.id] = t;
    }

    // 4. 按 trackIds 顺序排列
    const orderedTracks = [];
    for (const item of v6Data.playlist.trackIds) {
        const id = typeof item === 'object' ? item.id : item;
        const track = trackMap[id];
        if (track) orderedTracks.push(track);
    }

    console.log(`歌单: ${v6Data.playlist.name}`);
    console.log(`曲目: ${orderedTracks.length} 首\n`);

    // 5. 扫描本地音乐文件
    const localFiles = fs.readdirSync(MUSIC_DIR)
        .filter(f => /\.(flac|mp3|wav|aac|ogg|wma|m4a)$/i.test(f));

    console.log(`本地: ${localFiles.length} 首\n`);

    // 6. 模糊匹配
    function normalize(s) {
        return s.toLowerCase().normalize('NFKC')
            .replace(/[～~〜]/g, '~').replace(/[：:]/g, '|')
            .replace(/[！!？?／\/]/g, '|').replace(/[＋+]/g, '+')
            .replace(/[＊*_•·]/g, '|').replace(/[＃#]/g, '|')
            .replace(/[＆&]/g, '&').replace(/[　 ]+/g, ' ')
            .replace(/\s*,\s*/g, '|')
            .replace(/[（）()\[\]【】「」『』〈〉]/g, '')
            .replace(/[、。，]/g, '|')
            .replace(/\s*\.\s+/g, '|')   // "feat. X" separators (dot with trailing space)
            .replace(/\./g, '')          // remove remaining dots (abbrev like S.O.S. → SOS)
            .replace(/\s*-\s*/g, '|')    // "title - year" separators (preserves T-ara since no spaces)
            .replace(/\|?feat(\|.*)?$/, '') // strip "feat. X" suffix (too generic, causes cross-match)
            .replace(/\|+/g, '|').replace(/^\||\|$/g, '')
            .replace(/\s+/g, ' ').trim();
    }

    function tokenize(s) {
        // Filter out only single ASCII letters (a-z), keep CJK chars and other meaningful single chars
        return normalize(s).split('|').filter(t => t.length > 1 || /[^\x00-\x7F]/.test(t) || /[0-9]/.test(t));
    }

    function matchScore(track, filename) {
        const fnTokens = tokenize(path.basename(filename, path.extname(filename)));
        const nameTokens = tokenize(track.name);
        const artistTokens = track.artists.flatMap(a => tokenize(a.name));
        if (nameTokens.length === 0) return { score: 0, nameRatio: 0, artistRatio: 0 };

        const nameMatch = nameTokens.filter(nt =>
            fnTokens.some(ft => ft.includes(nt) || nt.includes(ft))
        ).length / nameTokens.length;

        const artistMatch = artistTokens.length > 0
            ? artistTokens.filter(at => fnTokens.some(ft => ft.includes(at) || at.includes(ft))).length / artistTokens.length
            : 1;

        return {
            score: nameMatch * 0.6 + artistMatch * 0.4,
            nameRatio: nameMatch,
            artistRatio: artistMatch
        };
    }

    const playlistOrder = [];
    let matched = 0, missing = 0;
    const matchedFiles = new Set();

    for (const track of orderedTracks) {
        let bestFile = null, bestScore = 0, bestNameRatio = 0;
        for (const file of localFiles) {
            const { score, nameRatio } = matchScore(track, file);
            if (score > bestScore) { bestScore = score; bestFile = file; bestNameRatio = nameRatio; }
        }
        // Accept if overall score >= 0.8, OR name matches well (handles Senya/森永真由美 alias)
        if (bestScore >= 0.8 || bestNameRatio >= 0.9) {
            playlistOrder.push(bestFile);
            matchedFiles.add(bestFile.toLowerCase());
            matched++;
        } else {
            playlistOrder.push(null);
            missing++;
        }
    }

    // 7. 报告
    console.log(`========== 匹配结果 ==========`);
    console.log(`✓ 匹配成功: ${matched}`);
    console.log(`✗ 未下载:   ${missing}`);

    // 8. 生成 m3u8
    const m3uLines = ['#EXTM3U'];
    for (let i = 0; i < playlistOrder.length; i++) {
        const file = playlistOrder[i];
        if (file) {
            const track = orderedTracks[i];
            const artist = track.artists.map(a => a.name).join(', ');
            m3uLines.push(`#EXTINF:${Math.floor(track.duration / 1000)},${artist} - ${track.name}`);
            m3uLines.push(file);
        }
    }

    const m3uPath = path.join(MUSIC_DIR, 'CloudMusic_Playlist.m3u8');
    fs.writeFileSync(m3uPath, m3uLines.join('\n'), 'utf-8');
    console.log(`\n✓ M3U8: ${m3uPath} (${matched} 首)`);

    // 9. 生成顺序文本
    const orderLines = playlistOrder.map((f, i) => {
        const t = orderedTracks[i];
        const label = `${t.artists.map(a => a.name).join(', ')} - ${t.name}`;
        return `${String(i + 1).padStart(3, '0')}. ${f ? label : '[未下载] ' + label}`;
    }).join('\n');

    const orderPath = path.join(MUSIC_DIR, 'CloudMusic_Playlist_order.txt');
    fs.writeFileSync(orderPath, orderLines, 'utf-8');
    console.log(`✓ 列表: ${orderPath}`);

    // 10. 多余文件
    const extra = localFiles.filter(f => !matchedFiles.has(f.toLowerCase()));
    if (extra.length > 0) {
        console.log(`\n--- 本地多余的 ${extra.length} 首 (不在歌单中) ---`);
        extra.slice(0, 10).forEach(f => console.log(`  ? ${f}`));
        if (extra.length > 10) console.log(`  ... 还有 ${extra.length - 10} 首`);
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
