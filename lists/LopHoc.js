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
    access: {
        auth: true,
    },
    hooks: {
        validateInput: async ({ operation, resolvedData }) => {
            if (resolvedData.name !== undefined && typeof resolvedData.name === 'string') {
                resolvedData.name = resolvedData.name.trim().replace(/\s+/g, ' ');
            }
            return resolvedData;
        },
        beforeDelete: async ({context, existingItem}) => {
            // Can xu ly la khong xoa du lieu khi hoc sinh con
            
        }
    }
}