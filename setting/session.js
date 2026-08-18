const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');


// Lưu trữ để phiên hoạt động chạy
var db = new MongoClient(process.env.MONGO_URL_SESSION,{
    auth: {
        "user": process.env.MONGO_SESSION_USER || process.env.MONGO_USER,
        "password": process.env.MONGO_SESSION_PASS || process.env.MONGO_PASS
    },
    authSource: process.env.MONGO_SESSION_AUTH_SOURCE || process.env.MONGO_AUTH_SOURCE || "admin",
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Nơi lúu trữ
exports.Session = {
    sessionStore: MongoStore.create({ 
        clientPromise: db.connect()
    })
}


exports.Cookie = {
    cookie: {
        secure: process.env.COOKIE_SECURE === 'true',
        // secure: process.env.NODE_ENV === 'production', // Default to true in production
        maxAge: 1000 * 60 * 60 * 24 * 60, // 60 days
        sameSite: process.env.COOKIE_SAME_SITE || false,
    }    
}
