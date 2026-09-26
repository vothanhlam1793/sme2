const { Text, Select, Checkbox, Password, Relationship } = require('@keystonejs/fields');
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
      phone: {
        type: Text,
      },
      status: {
        type: Select,
        options: [
          { value: 'DANG_LAM', label: 'Đang làm việc' },
          { value: 'TAM_NGHI', label: 'Tạm nghỉ' },
          { value: 'DA_NGHI_VIEC', label: 'Đã nghỉ việc' }
        ],
        defaultValue: 'DANG_LAM'
      },
      gender: {
        type: Select,
        options: [
          { value: 'NU', label: 'Nữ (Cô)' },
          { value: 'NAM', label: 'Nam (Thầy)' }
        ],
        defaultValue: 'NU'
      },
      avatar: {
        type: Text,
      },
      note: {
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
      auth: true,
    },
  }
