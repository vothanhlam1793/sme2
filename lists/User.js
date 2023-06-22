const { Text, Checkbox, Password, Relationship } = require('@keystonejs/fields');
const access = require("../setting/access").access;
module.exports = {
    fields: {
      name: { 
        type: Text 
      },
      username: {
        type: Text,
        isUnique: true
      },
      email: {
        type: Text,
      },
      isAdmin: {
        type: Checkbox,
        // Field-level access controls
        // Here, we set more restrictive field access so a non-admin cannot make themselves admin.
        access: {
          update: access.userIsAdmin,
        },
      },
      password: {
        type: Password,
      },
      roles: {
        type: Relationship,
        ref: "Role",
        many: true
      },
      lophoc: {
        type: Relationship,
        ref: "LopHoc.chunhiem",
        many: true
      }
    },
    // List-level access controls
    access: {
      // read: access.userIsAdminOrOwner,
      // update: access.userIsAdminOrOwner,
      // create: access.userIsAdmin,
      // delete: access.userIsAdmin,
      // auth: true,
    },
  }