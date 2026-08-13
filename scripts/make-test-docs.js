/**
 * 인코딩 테스트용 문서 생성:
 *  - test-docs/encoding-cp949.md : CP949로 인코딩된 한글 문서 (F-006, F-205 테스트)
 */
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const outDir = path.join(__dirname, '..', 'test-docs');
fs.mkdirSync(outDir, { recursive: true });

const cp949Text = `# CP949 인코딩 테스트

이 문서는 CP949(EUC-KR 확장) 인코딩으로 저장되어 있습니다.

## 확인 항목

- 한글 제목과 본문이 깨지지 않아야 합니다.
- 상태 표시줄에 CP949로 표시되어야 합니다.

| 항목 | 값 |
|---|---|
| 인코딩 | CP949 |
| 언어 | 한국어 |

> 옛날 메모장에서 "ANSI"로 저장한 파일이 이 형식입니다.
`;

fs.writeFileSync(path.join(outDir, 'encoding-cp949.md'), iconv.encode(cp949Text, 'cp949'));
console.log('created test-docs/encoding-cp949.md (CP949)');
