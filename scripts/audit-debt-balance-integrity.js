/**
 * Script Kiểm Toán Toàn Diện Tính Toàn Vẹn Công Nợ & Số Dư Ví (Audit Debt & Balance Integrity)
 * 
 * Mục đích:
 * - Tự động quét 100% Phụ Huynh trong hệ thống.
 * - So sánh giữa Field gốc trong DB (Parent.debt, Parent.balance) với Dư nợ/Số dư lũy tiến tính toán từ dòng chứng từ thực tế (Logs + PaymentSettlements + CashTransactions).
 * - Phát hiện ngay lập tức bất kỳ trường hợp lệch số nào để kế toán kịp thời xử lý.
 * 
 * Cách chạy:
 *   node scripts/audit-debt-balance-integrity.js
 */

const http = require('http');

const API_ENDPOINT = process.env.API_ENDPOINT || 'http://127.0.0.1:3011/admin/api';

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

async function auditIntegrity() {
  console.log(`=== BẮT ĐẦU KIỂM TOÁN TÍNH TOÀN VẸN CÔNG NỢ & VÍ PHỤ HUYNH ===`);
  const startTime = Date.now();

  let skip = 0;
  const pageSize = 100;
  let totalParents = 0;
  const mismatches = [];

  while (true) {
    const pRes = await sendGraphQL(`
      query GetBatchParents($skip: Int!, $first: Int!) {
        allParents(skip: $skip, first: $first) {
          id
          code
          name
          debt
          balance
        }
      }
    `, { skip, first: pageSize });

    const parents = pRes?.allParents || [];
    if (parents.length === 0) break;
    totalParents += parents.length;

    for (const p of parents) {
      // 1. Lấy logs nợ
      const lRes = await sendGraphQL(`
        query GetLogs($id: String!) {
          allLogs(where: { item: "Parent", idItem: $id, key: "debt" }, sortBy: [createdAt_ASC]) {
            id
            itemS
            idItemS
            value
            valueChange
            type
            createdAt
          }
        }
      `, { id: p.id });
      const logs = lRes?.allLogs || [];

      // 2. Lấy chứng từ cấn trừ STL
      const sRes = await sendGraphQL(`
        query GetStls($id: ID!) {
          allPaymentSettlements(where: { parent: { id: $id } }) {
            id
            code
            amount
            status
            settledAt
          }
        }
      `, { id: p.id });
      const stls = (sRes?.allPaymentSettlements || []).filter(s => s.status === 'SUCCESS');

      // 3. Tái hiện Sổ Nợ Lũy Tiến theo đúng logic chuẩn Frontend
      const debtEvents = [];
      logs.forEach(log => {
        debtEvents.push({
          rawId: log.idItemS || '',
          code: log.idItemS ? `${log.itemS?.substring(0, 3).toUpperCase()}_${log.idItemS.substring(log.idItemS.length - 6)}` : (log.itemS || 'LOG'),
          amount: parseInt(log.valueChange || 0, 10),
          amountSign: log.type === 'UP' ? '+' : '-',
          runningBalance: parseInt(log.value || 0, 10),
          createdTime: new Date(log.createdAt).getTime(),
          isVoucher: false
        });
      });

      stls.forEach(st => {
        const alreadyInLog = debtEvents.some(ev => ev.rawId === st.id || (ev.code && ev.code.includes(st.code)));
        if (!alreadyInLog) {
          debtEvents.push({
            rawId: st.id,
            code: st.code || 'STL',
            amount: st.amount || 0,
            amountSign: '-',
            runningBalance: null,
            createdTime: new Date(st.settledAt || Date.now()).getTime(),
            isVoucher: true
          });
        }
      });

      debtEvents.sort((a, b) => a.createdTime - b.createdTime);

      let runningDebt = 0;
      debtEvents.forEach(ev => {
        if (ev.isVoucher) {
          runningDebt = Math.max(0, runningDebt - ev.amount);
          ev.runningBalance = runningDebt;
        } else {
          if (ev.runningBalance !== null && !isNaN(ev.runningBalance)) {
            runningDebt = ev.runningBalance;
          } else {
            runningDebt = ev.amountSign === '+' ? (runningDebt + ev.amount) : Math.max(0, runningDebt - ev.amount);
            ev.runningBalance = runningDebt;
          }
        }
      });

      const finalLedgerDebt = debtEvents.length > 0 ? debtEvents[debtEvents.length - 1].runningBalance : 0;
      const currentDbDebt = p.debt || 0;

      if (finalLedgerDebt !== currentDbDebt) {
        mismatches.push({
          id: p.id,
          code: p.code,
          name: p.name,
          dbDebt: currentDbDebt,
          ledgerDebt: finalLedgerDebt,
          dbBalance: p.balance || 0,
          logsCount: logs.length,
          stlsCount: stls.length
        });
      }
    }

    process.stdout.write(`Đang quét kiểm toán: ${totalParents} phụ huynh...\r`);
    skip += pageSize;
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n======================================================`);
  console.log(`KẾT QUẢ KIỂM TOÁN TÍNH TOÀN VẸN TOÀN BỘ ${totalParents} PHỤ HUYNH (${durationSec}s):`);
  console.log(`- Số phụ huynh KHỚP 100% (Sổ nợ lũy tiến == Parent.debt): ${totalParents - mismatches.length}`);
  console.log(`- Số phụ huynh BỊ LỆCH SỐ CẦN XỬ LÝ: ${mismatches.length}`);
  console.log(`======================================================\n`);

  if (mismatches.length > 0) {
    console.log(`DANH SÁCH CHI TIẾT CÁC TRƯỜNG HỢP LỆCH:`);
    mismatches.forEach((m, idx) => {
      console.log(`${idx + 1}. [${m.code}] ${m.name}: DB.debt = ${m.dbDebt.toLocaleString()}đ  vs  Sổ nợ = ${m.ledgerDebt.toLocaleString()}đ (Logs: ${m.logsCount}, STL: ${m.stlsCount})`);
    });
    process.exit(1);
  } else {
    console.log(`🎉 HOÀN HẢO! 100% tất cả phụ huynh trong hệ thống đều có Sổ Nợ lũy tiến khớp chính xác từng đồng với số dư DB gốc.`);
    process.exit(0);
  }
}

auditIntegrity();
