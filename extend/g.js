const { gql } = require('apollo-server-express');

function generateSortedDateArray(startDateString, endDateString) {
  var startDate = parseDateString(startDateString);
  var endDate = parseDateString(endDateString);
  var result = [];

  var currentDate = new Date(startDate);
  currentDate.setDate(1); // Đặt ngày là 1 để bắt đầu từ đầu tháng

  while (currentDate <= endDate) {
    var year = currentDate.getFullYear();
    var month = (currentDate.getMonth() + 1).toString().padStart(2, '0');
    var formattedDate = year + '_' + month;
    result.push(formattedDate);

    currentDate.setMonth(currentDate.getMonth() + 1); // Chuyển sang tháng tiếp theo
  }

  return result.sort();
}

function parseDateString(dateString) {
  var parts = dateString.split('_');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) - 1; // Giảm đi 1 vì tháng trong JavaScript bắt đầu từ 0
  return new Date(year, month);
}



var inforPhieuKetSo = `
                            id
                          code
                          status
                          createdAt
                          items {
                            id
                            data
                            code
                            lophoc {
                              id
                                      name
                            }
                            hocsinh {
                              id
                              name
                              namhocphi
                              hocphigiam
                              luuy
                              parent {
                                id
                                name
                                phone {
                                    id
                                    number
                                    name
                                }
                              }
                            }
                            total
                          }
`
async function createPhone(keystone, name, phone) {
  var ret = await keystone.executeGraphQL({
    query: gql`
        mutation {
            createPhone(data: {
              name: "${name}",
              number: "${phone}"
            }){
              id
              number
              name
            }
        }
        `
  });
  return ret.data.createPhone;
}
async function createParent(keystone, name, parents, ids) {
  var str = "[";
  ids.forEach(function (id, index) {
    if (id == undefined) {
      return;
    } else {
      if ((index != 0) && (str.length > 1)) {
        str += ",";
      }
      str += `{id: "${id}"}`
    }
  });
  str += "]";
  var parentsEscaped = parents ? parents.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';
  var ret = await keystone.executeGraphQL({
    query: gql`
        mutation {
            createParent (data: {
              name: "${name}",
              parents: "${parentsEscaped}",
              phone: {
                connect: ${str}
              },
            }) {
              id
              name
              parents
              phone {
                id
                name
                number
              }
            }
        }
        `
  });
  return ret.data.createParent;
}
async function createStudent(keystone, name, birthday, idParent) {
  var ret = await keystone.executeGraphQL({
    query: gql`
        mutation {
            createStudent (data: {
              name: "${name}",
              birthday: "${(new Date(birthday)).toISOString()}", 
              parent: {
                connect: {
                  id: "${idParent}"
                }
              },
              status: "DANG_KY",
              hocphinam: "HPN_${(new Date(birthday)).getFullYear()}"
            }){
              id
              name
            }
          }
        `
  });
  return ret.data.createStudent;
}
function connectID(ids) {
  var ret = `[`;
  ids.forEach(function (e, i) {
    if (i != 0) {
      ret += ",";
    };
    ret += `{
      id: "${e.id}"
    }`
  })
  return ret + `]`;
}
async function createDiemDanh(keystone, idLopHoc, co, khong, code, type, idGiaoVien, note) {
  // Check va xoa
  var r1 = await keystone.executeGraphQL({
    query: gql`
    query {
      allDiemDanhs(where: {
        AND: {
          code: "${code}",
          lophoc: {
            id: "${idLopHoc}"
          }, 
          type: "${type}"
        }
      }){
        id
      }
    }
    `
  });
  if (r1.data.allDiemDanhs.length > 0) {
    keystone.executeGraphQL({
      query: gql`
      mutation {
        deleteDiemDanh (id: "${r1.data.allDiemDanhs[0].id}"){
          id
        }
    }
      `
    })
  }
  var idCos;
  var idKhongs;
  try {
    idCos = JSON.parse(co);
  } catch (e) {
    idCos = [];
  }
  try {
    idKhongs = JSON.parse(khong);
  } catch (e) {
    idKhongs = [];
  }
  var strCo = connectID(idCos);
  var strKhong = connectID(idKhongs);
  var ret = await keystone.executeGraphQL({
    query: gql`
    mutation {
      createDiemDanh(data: {
        giaovien: {
          connect: {
            id: "${idGiaoVien}"
          }
        },
        co: {
          connect: ${strCo}
        },
        khong: {
          connect: ${strKhong}
        },
        lophoc: {
          connect: {
            id: "${idLopHoc}"
          }
        },
        code: "${code}",
        note: "${note}",
        type: "${type}"
      }){
        id
        co {
          id
          name
        }
        khong {
          id
          name
        }
        lophoc {
          id
          name
        }
        type 
        note
        status
        code
        giaovien {id name}
      }
    }
    `
  });

  return ret;
}
async function createCItemHoaDon(keystone, item) {
  // console.log(item);
  var ret = await keystone.executeGraphQL({
    query: gql`
    mutation {
      createItem(data: {
        sanpham: {
          connect: {
            id: "${item.sanpham.id}"
          }
        },
        price: ${parseInt(item.price)},
        amount: ${parseInt(item.amount)},
        total: ${parseInt(item.total)}
      }){
        id
      }
    }    
    `
  });
  return ret.data.createItem;
}
async function createCHoaDon(keystone, items, idParent, idStudent, type) {
  var idItems = [];
  // console.log("FUNC-", items);
  for (var j = 0; j < items.length; j++) {
    let o = await createCItemHoaDon(keystone, items[j]);
    idItems.push(o);
  }
  var total = 0;
  items.forEach(function (item) {
    total += item.total;
  });
  var ret = await keystone.executeGraphQL({
    query: gql`
    mutation {
      createHoaDon (data: {
        items: {
          connect: ${connectID(idItems)}
        },
        parent: {
          connect: {
            id: "${idParent}"
          }
        },
        student: {
          connect: {
            id: "${idStudent}"
          }
        },
        total: ${total},
        createdAt: "${(new Date()).toISOString()}",
        type: "${type}"
      }) {
        total
    id
    items {
      id
      total
      price
      sanpham {
        id
        name
      }
    }
    parent {
      code
      id
    }
      }
    }
    `
  });
  // console.log(ret);
  return ret;
  // return ret.data.createHoaDon;
}
function extend(keystone) {
  keystone.extendGraphQLSchema({
    types: [
      {
        type: 'type FooBar { foo: Int, bar: Float }'
      },
      {
        type: 'type SearchPhone{message: String, data: [Parent]}'
      },
      {
        type: 'type PS{student: Student, parent: Parent}'
      },
      {
        type: 'type CStudent{ message: String, data: PS, content: String}'
      },
      {
        type: 'type CKetSo{message: String, data: PhieuKetSo, content: String}'
      },
      {
        type: 'type CDiemDanh{message: String, data: DiemDanh, content: String, giaovien: User, lophoc: LopHoc}'
      },
      {
        type: 'type CHoaDon{message: String, data: HoaDon, content: String}'
      },
      {
        type: 'type RDoanhThu{from: String, to: String, total: Int}'
      }
    ],
    queries: [
      {
        schema: 'double(x: Int): FooBar',
        resolver: function (_, { x }) {
          return {
            foo: 2 * x,
            bar: 3 * x
          }
        }
      },
      {
        schema: 'reportDoanhThu(from: String, to: String): RDoanhThu',
        resolver: async function (_, { from, to }) {
          var sortedDateArray = generateSortedDateArray(from, to);
          var str = `query {
                        allPhieuKetSos(where: {
                          OR: [`

          sortedDateArray.forEach(function (date, index) {
            if (index != 0) {
              str += `,`;
            }
            str += `{
                            code_contains: "${date}"
                          }
                        `;
          });
          str += `]
                        }){
                          code
                          id
                          items {
                            data
                            total
                          }
                          status
                        }
                      }`
          var { data, errors } = await keystone.executeGraphQL({
            query: gql(str),
          });
          var total = 0;
          data.allPhieuKetSos.forEach(function (phieuketso) {
            phieuketso.items.forEach(function (i) {
              let j;
              try {
                j = JSON.parse(i.data);
              } catch (e) {
                j = {
                  total: 0
                }
              }
              if (j.total == undefined) {
                j.total = 0;
              }
              total += parseInt(j.total);
            });
          });
          return {
            total: parseInt(total)
          }
        }
      },
      {
        schema: 'searchParentWithPhone(phone: String): SearchPhone',
        resolver: async function (_, { phone }) {
          var { data, errors } = await keystone.executeGraphQL({
            query: gql`
                    query {
                        allPhones(where: {
                            number_contains: "${phone}"
                        }) {
                          id
                          parent {
                            id 
                            code 
                            name 
                            phone {
                              id number name
                            }
                            status
                            hocsinhs {
                              id 
                              name
                            }
                            debt
                          }
                        }
                      }
                    `,
          });
          var parents = [];
          data.allPhones.forEach(function (phone) {
            parents = parents.concat(phone.parent);
          });
          let ret = parents.filter((value, index, self) => {
            return self.findIndex((t) => t.id === value.id) === index;
          });

          if (parents.length > 0) {
            return {
              message: "FOUND",
              data: ret
            }
          } else {
            return {
              message: "NOT_FOUND",
              data: ret
            }
          }
        }
      },
      {
        schema: 'searchParentWithNameHocSinh(name: String): SearchPhone',
        resolver: async function (_, { name }) {
          var { data, errors } = await keystone.executeGraphQL({
            query: gql`
                    query {
                        allStudents(where: {
                          name_contains: "${name}"
                        }){
                          id
                          name
                          lophoc {
                            name
                            id
                          }
                          parent {
                            id 
                            code 
                            name 
                            phone {
                              id number name
                            }
                            status
                            hocsinhs {
                              id 
                              name
                            }
                            debt
                          }
                        }
                      }
                    `,
          });
          var parents = [];
          data.allStudents.forEach(function (phone) {
            parents = parents.concat(phone.parent);
          });
          let ret = parents.filter((value, index, self) => {
            return self.findIndex((t) => t.id === value.id) === index;
          });

          if (parents.length > 0) {
            return {
              message: "FOUND",
              data: ret
            }
          } else {
            return {
              message: "NOT_FOUND",
              data: ret
            }
          }
        }
      }
    ],
    mutations: [
      {
        schema: 'double(x: Int): Int',
        resolver: (_, { x }) => 2 * x,
      },
      {
        schema: 'createStudentFromFull(nameStudent: String, birthday: String, nameDad: String, phoneDad: String, nameMom: String, phoneMom: String): CStudent',
        resolver: async function (_, { nameStudent, birthday, nameDad, phoneDad, nameMom, phoneMom }) {
          nameStudent = (nameStudent || '').trim();
          nameDad = (nameDad || '').trim();
          nameMom = (nameMom || '').trim();
          phoneDad = (phoneDad || '').replace(/\D/g, '');
          phoneMom = (phoneMom || '').replace(/\D/g, '');

          if (phoneDad.length < 9 && phoneMom.length < 9) {
            return {
              message: "ERROR_NUMBER_LENGTH",
              content: "Ca 2 so dien thoai khong hop le",
              data: {
                student: null,
                parent: null
              }
            }
          }

          var wherePhones = [];
          if (phoneDad.length >= 9) wherePhones.push(`{ number: "${phoneDad}" }`);
          if (phoneMom.length >= 9) wherePhones.push(`{ number: "${phoneMom}" }`);

          var { data, errors } = await keystone.executeGraphQL({
            query: gql`
                    query {
                        allPhones (where: { OR: [
                          ${wherePhones.join(',')}
                        ]
                        }){
                          id
                          number
                          name
                          parent {
                            id
                            name
                            parents
                            phone {id number name}
                          }
                        }
                    }
                    `
          });
          
          var parents = [];
          if (data && data.allPhones) {
            data.allPhones.forEach(async function (phone) {
              if (phone.parent != null) {
                parents = parents.concat(phone.parent);
              } else {
                // delete phone du thua
                await keystone.executeGraphQL({
                  query: gql`
                  mutation {
                    deletePhone(id: "${phone.id}"){
                      id
                    }
                  }
                  `
                })
              }
            });
          }
          let ret = parents.filter((value, index, self) => {
            return self.findIndex((t) => t.id === value.id) === index;
          });

          // Chuẩn hóa tên phụ huynh đại diện
          var parentRepName = "";
          if (nameDad && nameDad.length > 0) {
            parentRepName = `${nameDad} (Bố ${nameStudent})`;
          } else if (nameMom && nameMom.length > 0) {
            parentRepName = `${nameMom} (Mẹ ${nameStudent})`;
          } else {
            parentRepName = `PH ${nameStudent}`;
          }

          var parentInfo = JSON.stringify({ dadName: nameDad, dadPhone: phoneDad, momName: nameMom, momPhone: phoneMom });

          if (ret.length == 0) {
            // Tạo mới - với 2 số điện thoại
            var idPhoneDad;
            var idPhoneMom;
            if (phoneDad.length >= 9) {
              var dad = await createPhone(keystone, nameDad ? `${nameDad} (Bố)` : "Bố", phoneDad);
              if (dad) idPhoneDad = dad.id;
            };
            if (phoneMom.length >= 9) {
              var mom = await createPhone(keystone, nameMom ? `${nameMom} (Mẹ)` : "Mẹ", phoneMom);
              if (mom) idPhoneMom = mom.id;
            }
            var parent = await createParent(keystone, parentRepName, parentInfo, [idPhoneDad, idPhoneMom]);
            var student = await createStudent(keystone, nameStudent, birthday, parent.id);
            return {
              message: "SUCCESS",
              content: "",
              data: {
                student: student,
                parent: parent
              }
            }

          } else if (ret.length == 1) {
            // ret.length == 1 => Phụ huynh đã có sẵn trong hệ thống (anh/chị của bé)
            var existingParent = ret[0];
            var existingPhoneNumbers = (existingParent.phone || []).map(p => p.number);
            
            // Nếu có SĐT mới chưa được thêm vào phụ huynh này, bổ sung ngay
            if (phoneDad.length >= 9 && !existingPhoneNumbers.includes(phoneDad)) {
              var dad = await createPhone(keystone, nameDad ? `${nameDad} (Bố)` : "Bố", phoneDad);
              if (dad) {
                await keystone.executeGraphQL({
                  query: gql`
                    mutation {
                      updateParent(id: "${existingParent.id}", data: {
                        phone: { connect: [{ id: "${dad.id}" }] }
                      }) { id }
                    }
                  `
                });
              }
            }
            if (phoneMom.length >= 9 && !existingPhoneNumbers.includes(phoneMom)) {
              var mom = await createPhone(keystone, nameMom ? `${nameMom} (Mẹ)` : "Mẹ", phoneMom);
              if (mom) {
                await keystone.executeGraphQL({
                  query: gql`
                    mutation {
                      updateParent(id: "${existingParent.id}", data: {
                        phone: { connect: [{ id: "${mom.id}" }] }
                      }) { id }
                    }
                  `
                });
              }
            }

            var student = await createStudent(keystone, nameStudent, birthday, existingParent.id);
            return {
              message: "SUCCESS",
              content: "",
              data: {
                student: student,
                parent: existingParent
              }
            }
          } else {
            // Có lỗi - nhiều hơn 1 phụ huynh được tìm thấy
            return {
              message: "ERROR_2_PARENT",
              content: "Co 2 phu huynh",
              data: {
                student: null,
                parent: null
              }
            }
          }
        }
      },
      {
        // Get phieuketso => data
        schema: 'createOrUpdatePhieuKetSo(code: String, idLopHoc: ID): CKetSo',
        resolver: async function (_, { code, idLopHoc }) {
          var ret = await keystone.executeGraphQL({
            query: gql`
                    query {
                        allPhieuKetSos(where: {
                          AND: [{
                            lophoc: {
                              id: "${idLopHoc}"
                            }
                          }, {
                            code: "${code}"
                          }]
                        }){
                          ${inforPhieuKetSo}
                        }
                    }
                    `

          });
          if (ret.data.allPhieuKetSos.length > 0) {
            // Đã tạo rồi gởi về luôn
            return {
              message: "SUCCESS",
              data: ret.data.allPhieuKetSos[0]
            }
          }

          // Chưa tạo, chuẩn bị tiến hành tạo
          ret = await keystone.executeGraphQL({
            query: gql`
                    query {
                        LopHoc(where: {
                          id: "${idLopHoc}"
                        }) {
                          id
                          name
                          hocsinhs {
                            id
                            name
                          }
                        }
                    }
                    `
          });

          // Tạo phiếu kết sổ
          var pks = await keystone.executeGraphQL({
            query: gql`
                    mutation {
                        createPhieuKetSo(data: {
                          code: "${code}",
                          lophoc: {
                            connect: {
                              id: "${idLopHoc}"
                            }
                          },
                          status: "NEW"
                        }) {
                          id
                        }
                    }
                    `
          });

          if (pks.data.createPhieuKetSo.id) {
            // Tạo thành công
            var idPKS = pks.data.createPhieuKetSo.id;
            var lophoc = ret.data.LopHoc;
            var createItemPromises = lophoc.hocsinhs.map(function (hocsinh) {
              return keystone.executeGraphQL({
                query: gql`
                            mutation {
                                createItemKetSo (data: {
                                  code: "",
                                  lophoc: {
                                    connect: {
                                      id: "${lophoc.id}"
                                    }
                                  },
                                  phieuketso: {
                                    connect: {
                                      id: "${idPKS}"
                                    }
                                  },
                                  hocsinh: {
                                    connect: {
                                      id: "${hocsinh.id}"
                                    }
                                  },
                                  data: "${JSON.stringify({})}",
                                  total: 0
                                }){
                                  id
                                }
                            }
                            `
              });
            });

            var createItemResults = await Promise.allSettled(createItemPromises);
            var hasCreateItemError = createItemResults.some(function (result) {
              if (result.status !== "fulfilled") {
                return true;
              }
              if (!result.value || !result.value.data || !result.value.data.createItemKetSo || !result.value.data.createItemKetSo.id) {
                return true;
              }
              if (result.value.errors && result.value.errors.length > 0) {
                return true;
              }
              return false;
            });

            if (hasCreateItemError) {
              await keystone.executeGraphQL({
                query: gql`
                                mutation {
                                    deletePhieuKetSo(id: "${idPKS}"){
                                      id
                                    }
                                }
                                `
              })
              return {
                message: "ERROR",
                content: `Dang tao bi dung giu chung`
              }
            }

            // Đã tạo xong => Gởi lại cho frontend
            ret = await keystone.executeGraphQL({
              query: gql`
                        query {
                            PhieuKetSo(where: {id: "${idPKS}"}){
                                ${inforPhieuKetSo}
                            }
                        }
                        `
            });
            return {
              message: "SUCCESS",
              data: ret.data.PhieuKetSo
            }
          } else {
            // Tạo thất bại
            return {
              message: "ERROR",
              content: "Khong the tao Phieu Ke So",
              data: null
            }
          }
        }
      },
      {
        schema: 'createOrUpdateCamera(idHocSinh: ID): Variable',
        resolver: async function (_, { idHocSinh }) {
          // console.log(idHocSinh);
          var ret = await keystone.executeGraphQL({
            query: gql`
                    query {
                        allVariables(where: {AND: 
                        [
                              {
                            item: "Student"
                          },
                          {
                            idItem: "${idHocSinh}"
                          },
                          {
                            key: "CAMERA"
                          }
                        ]}) {
                          id
                          key
                          value
                          item
                          idItem
                        }
                      }
                    `
          });
          if (ret.data.allVariables.length > 0) {
            // Đã tìm thấy
            return ret.data.allVariables[0];
          } else {
            // Không tìm thấy - tạo mới
            ret = await keystone.executeGraphQL({
              query: gql`
                        mutation {
                            createVariable(data: {
                              key: "CAMERA",
                              value: "1",
                              item: "Student",
                              idItem: "${idHocSinh}"
                            }){
                              id
                                                    key
                                                    value
                                                    item
                                                    idItem
                            }
                        }
                        `
            });
            return ret.data.createVariable;
          }

        }
      },
      {
        schema: 'createOrUpdateAn545(idHocSinh: ID): Variable',
        resolver: async function (_, { idHocSinh }) {
          // console.log(idHocSinh);
          var ret = await keystone.executeGraphQL({
            query: gql`
                    query {
                        allVariables(where: {AND: 
                        [
                              {
                            item: "Student"
                          },
                          {
                            idItem: "${idHocSinh}"
                          },
                          {
                            key: "AN545"
                          }
                        ]}) {
                          id
                          key
                          value
                          item
                          idItem
                        }
                      }
                    `
          });
          if (ret.data.allVariables.length > 0) {
            // Đã tìm thấy
            return ret.data.allVariables[0];
          } else {
            // Không tìm thấy - tạo mới
            ret = await keystone.executeGraphQL({
              query: gql`
                        mutation {
                            createVariable(data: {
                              key: "AN545",
                              value: "1",
                              item: "Student",
                              idItem: "${idHocSinh}"
                            }){
                              id
                                                    key
                                                    value
                                                    item
                                                    idItem
                            }
                        }
                        `
            });
            return ret.data.createVariable;
          }

        }
      },
      {
        schema: 'getHocSinhAn545(idLopHoc: ID): [Student]',
        resolver: async function (_, { idLopHoc }) {
          var ret = await keystone.executeGraphQL({
            query: gql`
              query {
                LopHoc(where: {id: "${idLopHoc}"}){
                  id
                  name
                  hocsinhs {
                    id
                    name
                  }
                }
              }
              `
          });
          var str = "";
          ret.data.LopHoc.hocsinhs.forEach(function (hocsinh, index) {
            if (index != 0) {
              str += ",";
            }
            str += `{
                key: "AN545",
                item: "Student",
                idItem: "${hocsinh.id}"
              }`
          });
          var an545 = await keystone.executeGraphQL({
            query: gql`
              query {
                allVariables(where: {
                  OR: [
                    ${str}
                  ]
                }){
                  id
                  key
                  value
                }
              }
              `
          });
          // console.log("AN545", an545);
        }
      },
      {
        schema: 'createCDiemDanh(idLopHoc: ID, co: String, khong: String, code: String, idGiaoVien: ID, type: String, note: String): CDiemDanh',
        resolver: async function (_, { idLopHoc, co, khong, code, idGiaoVien, type, note }) {
          var ret = await createDiemDanh(keystone, idLopHoc, co, khong, code, type, idGiaoVien, note);
          if (ret.errors) {
            return {
              message: "ERROR",
              content: JSON.stringify(ret.errors),
              data: null,
              giaovien: null,
              lophoc: null
            }
          } else {
            var r = {
              message: "SUCCESS",
              data: ret.data.createDiemDanh,
              giaovien: ret.data.createDiemDanh.giaovien,
              lophoc: ret.data.createDiemDanh.lophoc
            };
            return r
          }
        }
      },
      {
        schema: 'createCHoaDon(items: String, idParent: ID, idStudent: ID, type: String): CHoaDon',
        resolver: async function (_, { items, idParent, idStudent, type }) {
          var its = [];
          try {
            its = JSON.parse(items);
          } catch (e) {
            its = [];
          }
          // console.log("ITEMS", its, idParent, type);
          var ret = await createCHoaDon(keystone, its, idParent, idStudent, type);
          // console.log(ret.data.createHoaDon);
          if (ret.errors) {
            return {
              message: "ERROR",
              content: JSON.stringify(ret.errors),
              data: null
            }
          } else {
            return {
              message: "SUCCESS",
              data: ret.data.createHoaDon,
              content: null
            }
          }
        }
      },
    ],
  });
}

module.exports.extend = extend;
