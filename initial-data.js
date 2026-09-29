module.exports = async keystone => {
  // Count existing users
  const {
    data: {
      _allUsersMeta: { count = 0 },
    },
  } = await keystone.executeGraphQL({
    context: keystone.createContext().sudo(),
    query: `query {
      _allUsersMeta {
        count
      }
    }`,
  });

  if (count === 0) {
    const username = process.env.INITIAL_ADMIN_USERNAME;
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    const email = process.env.INITIAL_ADMIN_EMAIL || '';
    if (!username || !password || password.length < 8 || Buffer.byteLength(password) > 72) {
      throw new Error('Empty database requires INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD (8 characters minimum, 72 bytes maximum)');
    }

    const { errors } = await keystone.executeGraphQL({
      context: keystone.createContext().sudo(),
      query: `mutation initialUser($username: String!, $password: String!, $email: String) {
            createUser(data: {name: "Admin", username: $username, email: $email, isAdmin: true, password: $password}) {
              id
            }
          }`,
      variables: { username, password, email },
    });

    if (errors) {
      throw new Error('Failed to create initial administrator');
    } else {
      console.log('Initial administrator created; remove bootstrap credentials from environment.');
    }
  }
};
