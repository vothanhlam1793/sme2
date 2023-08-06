const { Text, Checkbox, Relationship, Integer } = require('@keystonejs/fields');
const { gql } = require('apollo-server-express');
const code = require('../func/code');

module.exports = {
    fields: {
        code: {
            type: Text,
            isUnique: true,
        },
        name: {
            type: Text,
        },
        phone: {
            type: Relationship,
            ref: "Phone.parent",
            many: true,
            isRequired: true
        },
        status: {
            type: Text,
        },
        hocsinhs: {
            type: Relationship,
            ref: "Student.parent",
            many: true
        }, 
        debt: {
            type: Integer
        },
        createdBy: {
            type: Relationship,
            ref: "User",
            many: false
        },
        updatedBy: {
            type: Relationship,
            ref: "User",
            many: false
        }
    },
    hooks: {
        validateInput: async ({operation, resolvedData, context}) => {
            if(operation == "create"){
                if(resolvedData.code == undefined){
                    resolvedData.code = await code.getCode(context, "PH");
                    resolvedData.debt = 0;
                } else {

                }
            }  
            const user = context.authedItem;
            if (user) {
                if (operation === 'create') {
                    resolvedData.createdBy = user.id;
                } else if (operation === 'update') {
                    resolvedData.updatedBy = user.id;
                }
            }
            return resolvedData;
        },
        beforeDelete: async ({context, existingItem}) => {
            const {data, error} = await context.executeGraphQL({
                context,
                query: gql`
                    query getParent($id: ID!){
                        Parent(where: {id: $id}){
                            phone {
                                id
                                number
                            }
                        }
                    }
                `, 
                variables: {
                    id: existingItem.id
                }
            });
            data.Parent.phone.forEach(async function (e){
                await context.executeGraphQL({
                    context,
                    query: gql`
                        mutation deletePhone($id: ID!){
                            deletePhone (id: $id){
                            id
                            }
                        }
                    `,
                    variables: {
                        id: e.id
                    }
                })
            });
        }
    }
};