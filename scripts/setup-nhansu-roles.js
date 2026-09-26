/**
 * Script dọn dẹp tài khoản rác và chuẩn hóa danh mục Role cho hệ thống
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

async function run() {
  console.log('1. Lấy danh sách Roles & Users...');
  const data = await sendGraphQL(`
    query {
      allRoles {
        id
        name
        slug
      }
      allUsers {
        id
        username
        name
        roles {
          id
          slug
        }
      }
    }
  `);

  const roles = data.allRoles || [];
  const users = data.allUsers || [];

  console.log(`Tìm thấy ${roles.length} roles và ${users.length} users.`);

  // 2. Thêm các roles chuẩn nếu chưa có
  const standardRoles = [
    { name: 'Quản trị viên', slug: 'quan-tri-vien', level: 10 },
    { name: 'Hiệu trưởng', slug: 'hieu-truong', level: 9 },
    { name: 'Hiệu phó', slug: 'hieu-pho', level: 8 },
    { name: 'Kế toán', slug: 'ke-toan', level: 7 },
    { name: 'Giáo viên', slug: 'giao-vien', level: 5 },
    { name: 'Bảo mẫu / Trợ giảng', slug: 'bao-mau', level: 4 },
    { name: 'Cấp dưỡng / Bếp', slug: 'cap-duong', level: 3 },
    { name: 'Y tế học đường', slug: 'y-te', level: 3 },
    { name: 'Tạp vụ / Cơ sở vật chất', slug: 'tap-vu', level: 2 },
  ];

  for (const sr of standardRoles) {
    const existing = roles.find((r) => r.slug === sr.slug);
    if (!existing) {
      console.log(`➕ Thêm role mới: ${sr.name} (${sr.slug})`);
      await sendGraphQL(`
        mutation {
          createRole(data: {
            name: "${sr.name}",
            slug: "${sr.slug}",
            level: ${sr.level}
          }) {
            id
            name
          }
        }
      `);
    } else {
      console.log(`✓ Role đã có: ${sr.name} (${sr.slug})`);
    }
  }

  // Xóa role rác 'x' nếu có
  const junkRole = roles.find((r) => r.slug === 'x');
  if (junkRole) {
    console.log(`🗑 Xóa role rác 'x' (ID: ${junkRole.id})`);
    await sendGraphQL(`
      mutation {
        deleteRole(id: "${junkRole.id}") {
          id
        }
      }
    `);
  }

  // 3. Dọn dẹp tài khoản rác trong allUsers
  console.log('\n2. Kiểm tra và dọn dẹp tài khoản rác...');
  for (const u of users) {
    const isJunk =
      !u.username ||
      u.username === 'null' ||
      /^(03|05|07|08|09)\d{8}$/.test(u.username); // Số điện thoại phụ huynh

    if (isJunk) {
      console.log(`🗑 Đang xóa User rác/phụ huynh nhầm: ${u.username} - ${u.name} (ID: ${u.id})`);
      try {
        await sendGraphQL(`
          mutation {
            deleteUser(id: "${u.id}") {
              id
            }
          }
        `);
      } catch (err) {
        console.error(`Lỗi khi xóa ${u.username}:`, err);
      }
    }
  }

  console.log('\n✅ Hoàn thành chuẩn hóa Roles và Users!');
}

run().catch((e) => console.error(e));
