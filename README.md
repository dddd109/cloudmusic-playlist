# CloudMusic Playlist

网易云音乐歌单 → PotPlayer 播放列表

## 文件说明

| 文件 | 用途 |
|------|------|
| `CloudMusic_Playlist.m3u8` | 拖入 PotPlayer 按歌单顺序播放 |
| `CloudMusic_Playlist_order.txt` | 歌单顺序文本列表（含"未下载"标记） |
| `generate_m3u8.js` | 从网易云 API 拉取歌单并匹配本地文件生成 m3u8 的脚本 |

## 使用方式

1. 把歌曲文件放在本目录下
2. 用 PotPlayer 打开 `CloudMusic_Playlist.m3u8`

## 更新歌单

1. 获取网易云 MUSIC_U cookie（浏览器登录 music.163.com → F12 → Application → Cookies → MUSIC_U）
2. 运行 `node generate_m3u8.js <歌单ID> <MUSIC_U>`
3. 新生成的 m3u8 会覆盖现有文件
