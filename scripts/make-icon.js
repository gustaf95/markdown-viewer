/**
 * assets/icon-256.png 를 PNG 포맷이 내장된 단일 이미지 ICO(assets/icon.ico)로 변환한다.
 * (Vista 이후 Windows는 ICO 컨테이너에 PNG를 그대로 담는 것을 지원)
 */
const fs = require('fs');
const path = require('path');

const assets = path.join(__dirname, '..', 'assets');
const png = fs.readFileSync(path.join(assets, 'icon-256.png'));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry[0] = 0; // width 256 -> 0
entry[1] = 0; // height 256 -> 0
entry[2] = 0; // palette
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // data size
entry.writeUInt32LE(22, 12); // data offset (6 + 16)

fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, entry, png]));
console.log('created assets/icon.ico');
