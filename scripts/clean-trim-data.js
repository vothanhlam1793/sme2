/**
 * Script quét và dọn sạch khoảng trắng thừa (trailing/leading spaces, extra spaces, \r\n)
 * Áp dụng cho các bảng: Student, Parent, Phone, LopHoc
 * 
 * Cách chạy:
 * 1. Kiểm tra trước không sửa DB:
 *    node scripts/clean-trim-data.js --dry-run
 * 
 * 2. Thực thi làm sạch thật:
 *    node scripts/clean-trim-data.js --apply
 */

const http = require('http');

const API_ENDPOINT = process.env.API_ENDPOINT || 'http://127.0.0.1:3011/admin/api';
const IS_APPLY = process.argv.includes('--apply');

async function sendGraphQL(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables });
    const url = new URL(API_ENDPOINT);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.errors) {
              return reject(parsed.errors);
            }
            resolve(parsed.data);
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function cleanString(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/\s+/g, ' ');
}

async function cleanStudents() {
  console.log('--- 1. Quét bảng Học sinh (Student) ---');
  const res = await sendGraphQL(`
    query {
      allStudents(first: 3000) {
        id
        name
        sName
      }
    }
  `);

  const students = res.allStudents || [];
  let updated = 0;

  for (const s of students) {
    const origName = s.name || '';
    const cleanName = cleanString(origName);
    const origSName = s.sName || '';
    const cleanSName = cleanString(origSName);

    if (origName !== cleanName || (origSName && origSName !== cleanSName)) {
      if (IS_APPLY) {
        await sendGraphQL(`
          mutation ($id: ID!, $name: String, $sName: String) {
            updateStudent(id: $id, data: { name: $name, sName: $sName }) {
              id
            }
          }
        `, { id: s.id, name: cleanName, sName: cleanSName });
      }
      updated++;
    }
  }
  console.log(`=> Tìm thấy ${students.length} học sinh. Đã xử lý ${updated} bản ghi có dấu cách thừa.\n`);
}

async function cleanParents() {
  console.log('--- 2. Quét bảng Phụ huynh (Parent) ---');
  const res = await sendGraphQL(`
    query {
      allParents(first: 3000) {
        id
        code
        name
        parents
      }
    }
  `);

  const parents = res.allParents || [];
  let updated = 0;

  for (const p of parents) {
    const origName = p.name || '';
    const cleanName = cleanString(origName);

    let cleanParentsField = p.parents;
    if (typeof p.parents === 'string') {
      cleanParentsField = p.parents.trim();
    }

    if (origName !== cleanName || p.parents !== cleanParentsField) {
      if (IS_APPLY) {
        await sendGraphQL(`
          mutation ($id: ID!, $name: String, $parents: String) {
            updateParent(id: $id, data: { name: $name, parents: $parents }) {
              id
            }
          }
        `, { id: p.id, name: cleanName, parents: cleanParentsField });
      }
      updated++;
    }
  }
  console.log(`=> Tìm thấy ${parents.length} phụ huynh. Đã xử lý ${updated} bản ghi có dấu cách thừa.\n`);
}

async function cleanPhones() {
  console.log('--- 3. Quét bảng Số điện thoại (Phone) ---');
  const res = await sendGraphQL(`
    query {
      allPhones(first: 3000) {
        id
        name
        number
      }
    }
  `);

  const phones = res.allPhones || [];
  let updated = 0;

  for (const ph of phones) {
    const origName = ph.name || '';
    const cleanName = cleanString(origName);
    const origNumber = ph.number || '';
    const cleanNumber = origNumber.replace(/\D/g, '');

    if (origName !== cleanName || origNumber !== cleanNumber) {
      if (IS_APPLY) {
        await sendGraphQL(`
          mutation ($id: ID!, $name: String, $number: String) {
            updatePhone(id: $id, data: { name: $name, number: $number }) {
              id
            }
          }
        `, { id: ph.id, name: cleanName, number: cleanNumber });
      }
      updated++;
    }
  }
  console.log(`=> Tìm thấy ${phones.length} số điện thoại. Đã xử lý ${updated} bản ghi có dấu cách/ký tự lạ.\n`);
}

async function cleanClasses() {
  console.log('--- 4. Quét bảng Lớp học (LopHoc) ---');
  const res = await sendGraphQL(`
    query {
      allLopHocs(first: 500) {
        id
        name
      }
    }
  `);

  const classes = res.allLopHocs || [];
  let updated = 0;

  for (const c of classes) {
    const origName = c.name || '';
    const cleanName = cleanString(origName);

    if (origName !== cleanName) {
      if (IS_APPLY) {
        await sendGraphQL(`
          mutation ($id: ID!, $name: String) {
            updateLopHoc(id: $id, data: { name: $name }) {
              id
            }
          }
        `, { id: c.id, name: cleanName });
      }
      updated++;
    }
  }
  console.log(`=> Tìm thấy ${classes.length} lớp học. Đã xử lý ${updated} bản ghi có dấu cách thừa.\n`);
}

async function run() {
  console.log('=====================================================');
  console.log(`BẮT ĐẦU DỌN SẠCH KHOẢNG TRẮNG THỪA & KÝ TỰ ENTER`);
  console.log(`Chế độ: ${IS_APPLY ? '🔥 THỰC THI THẬT (APPLY)' : '🔍 KIỂM TRA THỬ (DRY-RUN)'}`);
  console.log('=====================================================\n');

  await cleanStudents();
  await cleanParents();
  await cleanPhones();
  await cleanClasses();

  console.log('=====================================================');
  console.log('HOÀN TẤT!');
  if (!IS_APPLY) {
    console.log('💡 Để áp dụng vào Database thực tế, hãy chạy lại lệnh với cờ --apply:');
    console.log('   node scripts/clean-trim-data.js --apply\n');
  }
  console.log('=====================================================');
}

run().catch(err => {
  console.error('Lỗi khi dọn dữ liệu:', err);
  process.exit(1);
});
