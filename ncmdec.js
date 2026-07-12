#!/usr/bin/env node
// ncmdec.js — 网易云 NCM 文件解密，保留文件名（歌手 - 歌名）
// 用法: node ncmdec.js [输入目录]
// 默认扫描 VipSongsDownload/，输出到当前目录

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INPUT_DIR = process.argv[2] || path.join(__dirname, 'VipSongsDownload');
const OUTPUT_DIR = __dirname;

const CORE_KEY = Buffer.from('687A4852416D736F356B496E62617857', 'hex');
const META_KEY = Buffer.from('2331346C6A6B5F215C5D2630553C2728', 'hex');

function decryptNCM(inputPath) {
    const buf = fs.readFileSync(inputPath);
    if (buf.toString('utf-8', 0, 8) !== 'CTENFDAM') throw new Error('Not a valid NCM file');

    let pos = 10; // skip magic + 2 bytes gap

    // -- Key decryption --
    const keyLen = buf.readUInt32LE(pos); pos += 4;
    const encKey = buf.slice(pos, pos + keyLen); pos += keyLen;

    // XOR with 0x64, then AES-128-ECB decrypt with CORE_KEY
    const xored = Buffer.from(encKey.map(b => b ^ 0x64));
    const keyDecipher = crypto.createDecipheriv('aes-128-ecb', CORE_KEY, null);
    keyDecipher.setAutoPadding(false);
    let decryptedKey = keyDecipher.update(xored);

    // Manual PKCS7 unpad
    const pad = decryptedKey[decryptedKey.length - 1];
    if (pad > 0 && pad <= 16) decryptedKey = decryptedKey.slice(0, decryptedKey.length - pad);

    const rc4Key = decryptedKey.slice(17); // strip first 17 bytes

    // -- RC4 KSA (Key Scheduling Algorithm) --
    const key = Array.from(rc4Key);
    const S = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + S[i] + key[i % rc4Key.length]) & 0xFF;
        [S[i], S[j]] = [S[j], S[i]];
    }

    // -- Metadata decryption --
    const metaLen = buf.readUInt32LE(pos); pos += 4;
    let metaInfo = { format: 'm4a', musicName: '', artist: [['']], album: '' };

    if (metaLen > 0) {
        let meta = buf.slice(pos, pos + metaLen); pos += metaLen;

        // XOR with 0x63
        meta = Buffer.from(meta.map(b => b ^ 0x63));

        // First 22 bytes = identifier, rest = base64-encoded AES ciphertext
        const b64Part = meta.slice(22);

        const metaDecipher = crypto.createDecipheriv('aes-128-ecb', META_KEY, null);
        metaDecipher.setAutoPadding(false);
        let decMeta = metaDecipher.update(Buffer.from(b64Part.toString('utf-8'), 'base64'));

        const metaPad = decMeta[decMeta.length - 1];
        if (metaPad > 0 && metaPad <= 16) decMeta = decMeta.slice(0, decMeta.length - metaPad);

        metaInfo = JSON.parse(decMeta.slice(6).toString('utf-8'));
    }

    // -- Skip gap --
    pos += 5;

    // -- Album cover (skip, we just pass through) --
    const imageSpace = buf.readUInt32LE(pos); pos += 4;
    const imageSize = buf.readUInt32LE(pos); pos += 4;
    if (imageSize > 0) pos += imageSize;
    pos += imageSpace - imageSize;

    // -- Audio data (encrypted) --
    const audioData = buf.slice(pos);

    // -- Modified RC4 PRGA stream decryption --
    const stream = [];
    for (let i = 0; i < 256; i++) {
        stream.push(S[(S[i] + S[(i + S[i]) & 0xFF]) & 0xFF]);
    }

    const audioOut = Buffer.alloc(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
        audioOut[i] = audioData[i] ^ stream[(i + 1) & 0xFF];
    }

    return { metaInfo, audioData: audioOut };
}

function sanitize(s) {
    // Only replace chars that are truly invalid on Windows: < > : " / \ | ? *
    return s.replace(/[<>:\"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function processFile(inputPath) {
    const baseName = path.basename(inputPath, '.ncm');

    try {
        const { metaInfo, audioData } = decryptNCM(inputPath);

        const format = metaInfo.format || 'm4a';
        const ext = format === 'mp3' ? '.mp3' : format === 'flac' ? '.flac' : '.m4a';
        const title = metaInfo.musicName || baseName;
        const artist = metaInfo.artist && metaInfo.artist.length > 0
            ? metaInfo.artist.map(a => a[0]).join(', ')
            : '';

        // Use the original NCM filename (Artist - Title convention)
        // Retain original extension from meta, or default to m4a
        const outputName = `${baseName}${ext}`;
        const outputPath = path.join(OUTPUT_DIR, outputName);

        if (fs.existsSync(outputPath)) {
            console.log(`⊙ ${outputName} (已存在，跳过)`);
            return { success: true, outputPath, outputName, skipped: true };
        }

        fs.writeFileSync(outputPath, audioData);
        console.log(`✓ ${baseName}.ncm → ${outputName} [${format}]`);
        return { success: true, outputPath, outputName };

    } catch (e) {
        console.error(`✗ ${baseName}.ncm: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// --- Main ---
function main() {
    console.log('NCM 解密工具\n');

    let files = [];
    const stat = fs.statSync(INPUT_DIR);
    if (stat.isDirectory()) {
        files = fs.readdirSync(INPUT_DIR)
            .filter(f => f.toLowerCase().endsWith('.ncm'))
            .map(f => path.join(INPUT_DIR, f));
    } else if (stat.isFile()) {
        files = [INPUT_DIR];
    }

    if (files.length === 0) {
        console.log('未找到 .ncm 文件');
        return;
    }

    console.log(`找到 ${files.length} 个 NCM 文件\n`);

    let success = 0, failed = 0;
    for (const f of files) {
        const result = processFile(f);
        if (result.success) success++;
        else failed++;
    }

    console.log(`\n完成: ${success} 成功, ${failed} 失败`);
}

main();
