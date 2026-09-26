/**
 * Script đối soát và đồng bộ Parent.debt với dòng Log công nợ (key: 'debt') cuối cùng
 * 
 * Cách chạy:
 * 1. Kiểm tra trước không sửa DB (mặc định):
 *    node scripts/sync-parent-debt-with-log.js --dry-run
 * 
 * 2. Thực thi cập nhật thật:
 *    node scripts/sync-parent-debt-with-log.js --apply
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
            if (parsed.errors && !parsed.data) {
              return reject(new Error(JSON.stringify(parsed.errors)));
            }
            resolve(parsed.data);
          } catch (e) {
            reject(new Error(`Lỗi parse response: ${body}`));
          }
        });
      }
    );

    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

async function getAllParents() {
  const parents = [];
  const pageSize = 200;
  let skip = 0;

  while (true) {
    const query = `
      query GetParents($skip: Int!, $first: Int!) {
        allParents(skip: $skip, first: $first) {
          id
          code
          name
          debt
        }
      }
    `;
    const data = await sendGraphQL(query, { skip, first: pageSize });
    const list = data.allParents || [];
    parents.push(...list);
    if (list.length < pageSize) break;
    skip += pageSize;
  }
  return parents;
}

async function getLastDebtLog(parentId) {
  const query = `
    query GetLastLog($parentId: String!) {
      allLogs(
        where: { item: "Parent", idItem: $parentId, key: "debt" }
        sortBy: [createdAt_DESC]
        first: 1
      ) {
        id
        value
        createdAt
        itemS
        type
        valueChange
      }
    }
  `;
  const data = await sendGraphQL(query, { parentId });
  return (data.allLogs && data.allLogs[0]) || null;
}

async function updateParentDebt(parentId, debt) {
  const query = `
    mutation UpdateParentDebt($id: ID!, $debt: Int!) {
      updateParent(id: $id, data: { debt: $debt }) {
        id
        code
        debt
      }
    }
  `;
  return await sendGraphQL(query, { id: parentId, debt });
}

async function main() {
  console.log(`=== BẮT ĐẦU ĐỐI SOÁT & ĐỒNG BỘ NỢ PHỤ HUYNH VỚI LOG CUỐI ===`);
  console.log(`Chế độ: ${IS_APPLY ? '🚀 APPLY (CẬP NHẬT THẬT VÀO DB)' : '🔍 DRY-RUN (CHỈ KIỂM TRA, KHÔNG SỬA DB)'}\n`);

  try {
    const parents = await getAllParents();
    console.log(`Tổng số phụ huynh quét được: ${parents.length}`);

    const mismatches = [];
    const noLogs = [];
    const invalidLogs = [];

    let countChecked = 0;
    for (const p of parents) {
      countChecked++;
      if (countChecked % 100 === 0) {
        process.stdout.write(`Đã kiểm tra ${countChecked}/${parents.length}...\r`);
      }

      const lastLog = await getLastDebtLog(p.id);
      if (!lastLog) {
        noLogs.push(p);
        continue;
      }

      const logValueNum = parseInt(lastLog.value, 10);
      if (isNaN(logValueNum)) {
        invalidLogs.push({ parent: p, lastLog });
        continue;
      }

      const currentDebt = p.debt || 0;
      if (currentDebt !== logValueNum) {
        mismatches.push({
          parent: p,
          currentDebt,
          targetDebt: logValueNum,
          lastLog,
        });
      }
    }

    console.log(`\nHoàn tất quét ${countChecked} phụ huynh!\n`);
    console.log(`----------------------------------------`);
    console.log(`- Phụ huynh có số dư khớp hoàn toàn: ${parents.length - mismatches.length - noLogs.length - invalidLogs.length}`);
    console.log(`- Phụ huynh chưa có bản ghi Log nợ: ${noLogs.length}`);
    console.log(`- Phụ huynh có Log không hợp lệ (NaN): ${invalidLogs.length}`);
    console.log(`- Phụ huynh bị LỆCH NỢ cần đồng bộ: ${mismatches.length}`);
    console.log(`----------------------------------------\n`);

    if (mismatches.length > 0) {
      console.log(`Chi tiết các trường hợp bị lệch:`);
      for (const m of mismatches) {
        console.log(
          `• [${m.parent.code}] ${m.parent.name}: Nợ hiện tại = ${m.currentDebt.toLocaleString()}đ -> Log cuối = ${m.targetDebt.toLocaleString()}đ (Log: ${m.lastLog.createdAt} | ${m.lastLog.itemS || 'N/A'})`
        );
      }
      console.log('');

      if (IS_APPLY) {
        console.log(`Đang thực hiện cập nhật ${mismatches.length} phụ huynh vào Database...`);
        let successCount = 0;
        for (const m of mismatches) {
          try {
            await updateParentDebt(m.parent.id, m.targetDebt);
            console.log(`  ✓ Đã cập nhật ${m.parent.code} (${m.parent.name}) thành công: debt = ${m.targetDebt.toLocaleString()}đ`);
            successCount++;
          } catch (err) {
            console.error(`  ✗ Lỗi cập nhật ${m.parent.code}:`, err.message);
          }
        }
        console.log(`\n=> Cập nhật thành công ${successCount}/${mismatches.length} phụ huynh.`);
      } else {
        console.log(`💡 Đây là chế độ DRY-RUN. Để áp dụng cập nhật vào Database, vui lòng chạy:`);
        console.log(`   node scripts/sync-parent-debt-with-log.js --apply\n`);
      }
    } else {
      console.log(`🎉 Tuyệt vời! Tất cả các phụ huynh đã có số dư debt khớp 100% với log cuối cùng.`);
    }

  } catch (error) {
    console.error('Lỗi trong quá trình chạy script:', error);
  }
}

main();
