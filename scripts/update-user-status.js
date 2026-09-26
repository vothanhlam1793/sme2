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
            if (parsed.errors) return reject(parsed.errors);
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
  const data = await sendGraphQL(`query { allUsers { id username name status } }`);
  const users = data.allUsers || [];
  console.log(`Đang cập nhật status DANG_LAM cho ${users.length} users...`);

  for (const u of users) {
    if (!u.status) {
      await sendGraphQL(`
        mutation {
          updateUser(id: "${u.id}", data: { status: DANG_LAM, gender: NU }) {
            id
            username
          }
        }
      `);
    }
  }
  console.log('✅ Hoàn tất gán status DANG_LAM!');
}

run().catch(console.error);
