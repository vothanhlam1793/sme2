const { cameraRequest, syncPhoneCamera } = require('./cameraIntegration');

async function execute(context, query, variables) {
  const result = await context.executeGraphQL({ context, query, variables });
  if (result.errors?.length || !result.data) throw new Error(result.errors?.[0]?.message || 'Camera lifecycle query failed');
  return result.data;
}

async function configuration(context) {
  const data = await execute(context, 'query { allCameraIntegrations(where: {key: "school"}) { value } }');
  const value = data.allCameraIntegrations?.[0]?.value;
  return value ? JSON.parse(value) : null;
}

async function syncParentCamera(context, parentId, request = cameraRequest) {
  const config = await configuration(context);
  if (!config?.baseUrl || !config?.apiKey) return { skipped: true, reason: 'CAMERA_NOT_CONFIGURED' };
  const data = await execute(context, `query ($id: ID!) { Parent(where: {id: $id}) {
    id name status phone { id number name parent { id name status hocsinhs { id name status lophoc { id name } } } }
  } }`, { id: parentId });
  const parent = data.Parent;
  if (!parent) return { skipped: true, reason: 'PARENT_NOT_FOUND' };
  const results = [];
  for (const phone of parent.phone || []) {
    try { results.push({ phoneId: phone.id, ...(await syncPhoneCamera(config, phone, request)) }); }
    catch (error) { results.push({ phoneId: phone.id, error: error.message }); }
  }
  return { results };
}

async function syncAfterStudentChange({ operation, updatedItem, existingItem, context, originalInput }) {
  if (operation !== 'update' || (!Object.hasOwn(originalInput || {}, 'status') && !Object.hasOwn(originalInput || {}, 'lophoc'))) return;
  const parent = updatedItem.parent || existingItem?.parent;
  const parentId = typeof parent === 'string' ? parent : parent?.id || parent?._id?.toString();
  if (!parentId) return;
  try { await syncParentCamera(context, parentId); }
  catch (error) { console.error('[camera lifecycle] sync failed:', error.message); }
}

module.exports = { syncParentCamera, syncAfterStudentChange };
