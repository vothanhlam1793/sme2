const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');


let sessionStore;

if (process.env.KEYSTONE_BUILD !== 'true') {
    // Lưu trữ để phiên hoạt động chạy
    const db = new MongoClient(process.env.MONGO_URL_SESSION, {
        auth: {
            "user": process.env.MONGO_SESSION_USER || process.env.MONGO_USER,
            "password": process.env.MONGO_SESSION_PASS || process.env.MONGO_PASS
        },
        authSource: process.env.MONGO_SESSION_AUTH_SOURCE || process.env.MONGO_AUTH_SOURCE || "admin",
        useNewUrlParser: true,
        useUnifiedTopology: true
    });

    sessionStore = MongoStore.create({
        clientPromise: db.connect()
    });
}

exports.Session = { sessionStore };


exports.Cookie = {
    cookie: {
        secure: process.env.COOKIE_SECURE === 'true',
        // secure: process.env.NODE_ENV === 'production', // Default to true in production
        maxAge: 1000 * 60 * 60 * 24 * 60, // 60 days
        sameSite: process.env.COOKIE_SAME_SITE || false,
    }    
}
