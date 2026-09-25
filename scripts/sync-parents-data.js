/**
 * Script đồng bộ và chuẩn hóa dữ liệu Phụ huynh & Số điện thoại
 * Dùng khi nâng cấp từ phiên bản cũ (v2.0.1 trở về trước) lên v2.0.2+
 * 
 * Cách chạy:
 * 1. Kiểm tra trước không ghi vào DB (Dry-run):
 *    node scripts/sync-parents-data.js --dry-run
 * 
 * 2. Thực thi ghi trực tiếp vào DB:
 *    node scripts/sync-parents-data.js --apply
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

async function runMigration() {
  console.log('=====================================================');
  console.log(`BẮT ĐẦU QUÁ TRÌNH CHUẨN HÓA DỮ LIỆU PHỤ HUYNH`);
  console.log(`Chế độ: ${IS_APPLY ? '🔥 THỰC THI THẬT (APPLY)' : '🔍 KIỂM TRA THỬ (DRY-RUN)'}`);
  console.log('=====================================================\n');

  const fetchQuery = `
    query GetAllParents {
      allParents(first: 2000) {
        id
        code
        name
        parents
        phone {
          id
          name
          number
        }
        hocsinhs {
          id
          name
          status
        }
      }
    }
  `;

  const data = await sendGraphQL(fetchQuery);
  const parents = data.allParents || [];
  console.log(`Tổng số hồ sơ phụ huynh tìm thấy: ${parents.length}\n`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const p of parents) {
    let newName = p.name ? p.name.trim() : '';
    let isParentsJson = false;
    let parentsObj = null;

    try {
      if (p.parents && p.parents.trim().startsWith('{')) {
        parentsObj = JSON.parse(p.parents);
        isParentsJson = true;
      }
    } catch (e) {}

    const firstStudent = p.hocsinhs && p.hocsinhs.length > 0 ? p.hocsinhs[0].name.trim() : '';
    const studentNames = (p.hocsinhs || []).map((h) => (h.name || '').trim());

    let shouldUpdateName = false;

    // Trường hợp 1: Có JSON parents (Lấy tên Bố/Mẹ chuẩn)
    if (isParentsJson && parentsObj) {
      const dad = (parentsObj.dadName || '').trim();
      const mom = (parentsObj.momName || '').trim();

      if (dad && firstStudent) {
        newName = `${dad} (Bố ${firstStudent})`;
        shouldUpdateName = true;
      } else if (mom && firstStudent) {
        newName = `${mom} (Mẹ ${firstStudent})`;
        shouldUpdateName = true;
      } else if (dad) {
        newName = dad;
        shouldUpdateName = true;
      } else if (mom) {
        newName = mom;
        shouldUpdateName = true;
      }
    } 
    // Trường hợp 2: Không có JSON parents nhưng tên phụ huynh đang bị trùng với tên con
    else if (studentNames.includes(newName) && firstStudent) {
      newName = `PH ${firstStudent}`;
      shouldUpdateName = true;
    }

    if (shouldUpdateName && newName !== p.name) {
      console.log(`[${p.code || p.id}] Cập nhật tên: "${p.name}" ➔ "${newName}"`);

      if (IS_APPLY) {
        await sendGraphQL(
          `
          mutation UpdateParentName($id: ID!, $name: String!) {
            updateParent(id: $id, data: { name: $name }) {
              id
              name
            }
          }
        `,
          { id: p.id, name: newName }
        );
      }
      updatedCount++;
    } else {
      skippedCount++;
    }
  }

  console.log('\n=====================================================');
  console.log(`KẾT QUẢ ĐỒNG BỘ:`);
  console.log(`- Số hồ sơ ${IS_APPLY ? 'đã chuẩn hóa' : 'cần chuẩn hóa'}: ${updatedCount}`);
  console.log(`- Số hồ sơ giữ nguyên: ${skippedCount}`);
  console.log('=====================================================');
  if (!IS_APPLY) {
    console.log(`💡 Để áp dụng vào Database thực tế, hãy chạy lại lệnh với cờ --apply:`);
    console.log(`   node scripts/sync-parents-data.js --apply\n`);
  }
}

runMigration().catch((err) => {
  console.error('Lỗi trong quá trình migration:', err);
  process.exit(1);
});
