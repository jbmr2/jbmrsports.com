'use strict';

// Called only after the shared authentication middleware has set req.user.
// MySQL session verification joins the current account on every HTTP request;
// never read a phone or player selector from request headers/body/query here.
async function phoneForRequest(req) {
  const user = req.user;
  if (!user?.uid || user.simulator_preview) throw Error('Verified account required');
  if (user.auth_provider === 'mysql') {
    if (!/^\+91\d{10}$/.test(user.phone_number || '')) throw Error('Account phone unavailable');
    return user.phone_number;
  }
  // Transitional compatibility for installed clients using the old issuer.
  // This branch is removed only after those clients have migrated.
  const account = await require('firebase-admin/auth').getAuth().getUser(user.uid);
  if (account.disabled) throw Error('Account unavailable');
  return account.phoneNumber;
}

module.exports = { phoneForRequest };
