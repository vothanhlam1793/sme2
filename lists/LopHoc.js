const { Slug, Text, Checkbox, Relationship } = require('@keystonejs/fields');

module.exports = {
    fields: {
        name: {
            type: Text
        },
        hocsinhs: {
            type: Relationship,
            many: true,
            ref: "Student.lophoc"
        },
        chunhiem: {
            type: Relationship,
            ref: "User.lophoc",
            many: true
        },
        hocphi: {
            type: Text
        }
    },
    hooks: {
        beforeDelete: async ({context, existingItem}) => {
            // Can xu ly la khong xoa du lieu khi hoc sinh con
            
        }
    }
}