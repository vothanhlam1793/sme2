const { Keystone } = require('@keystonejs/keystone');
const { PasswordAuthStrategy } = require('@keystonejs/auth-password');
const { GraphQLApp } = require('@keystonejs/app-graphql');
const { AdminUIApp } = require('@keystonejs/app-admin-ui');
const initialiseData = require('./initial-data');


// File enviroment
const dotenv = require('dotenv')
dotenv.config()

const { MongooseAdapter: Adapter } = require('@keystonejs/adapter-mongoose');
const PROJECT_NAME = 'sme';

const adapterConfig = { 
  mongoUri: process.env.MONGO_URL,
  "user": process.env.MONGO_USER,
  "pass": process.env.MONGO_PASS,
  authSource: process.env.MONGO_AUTH_SOURCE,
  useNewUrlParser: true,
  useUnifiedTopology: true
};

const { Session, Cookie } = require("./setting/session");


const keystone = new Keystone({
  adapter: new Adapter(adapterConfig),
  cors: {
    origin: '*', // Thiết lập origin là "*"
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    credentials: true,
  },
  onConnect: process.env.CREATE_TABLES !== 'true' && initialiseData,
  sessionStore: Session.sessionStore,
  cookie: Cookie.cookie,
  cookieSecret: "CHUNGTANGHIRANGNOLAMOTTHONGSOCANPHAICAITHIEN"
});

keystone.createList('Student', require("./lists/Student"));
keystone.createList('Parent', require("./lists/Parent"));
keystone.createList('Phone', require("./lists/Phone"));
keystone.createList('LopHoc', require("./lists/LopHoc"));
keystone.createList('PhieuDiemDanh', require("./lists/PhieuDiemDanh"));
keystone.createList('Role', require("./lists/Role"));
keystone.createList('DiemDanh', require("./lists/DiemDanh"));
keystone.createList('User', require("./lists/User"));
keystone.createList('Variable', require("./lists/Variable"));
keystone.createList('HoaDon', require("./lists/HoaDon"));
keystone.createList('SanPham', require("./lists/SanPham"));
keystone.createList('Item', require("./lists/Item"));
keystone.createList('ItemKetSo', require("./lists/ItemKetSo"));
keystone.createList('PhieuKetSo', require("./lists/PhieuKetSo"));
keystone.createList('PhieuThu', require("./lists/PhieuThu"));
keystone.createList('DiemDanh545', require("./lists/DiemDanh545"));
keystone.createList('Log', require("./lists/Log"));

require("./extend/g").extend(keystone);

const authStrategy = keystone.createAuthStrategy({
  type: PasswordAuthStrategy,
  list: 'User',
  config: {
    identityField: 'username',
    // identityField: 'email',
    secretField: 'password',
  },
  // config: { protectIdentities: process.env.NODE_ENV === 'production' },
});

module.exports = {
  keystone,
  apps: [
    new GraphQLApp(),
    new AdminUIApp({
      name: PROJECT_NAME,
      enableDefaultRoute: true,
      authStrategy,
    }),
  ],
};
