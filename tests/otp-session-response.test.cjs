const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('OTP login response carries verified PIN status in the same response', async () => {
  for (const configured of [0, 1]) {
    const module = { exports: {} };
    const account = { uid: 'fixture', phone: '9999999999', disabled: false, pin_configured: configured };
    vm.runInNewContext(fs.readFileSync(require.resolve('../lib/mysql-accounts.cjs'), 'utf8'), {
      module, require: name => name === './mysql-pin.cjs' ? { database: () => ({
        execute: async sql => sql.startsWith('SELECT') ? [[account]] : [{ affectedRows: 1 }]
      }) } : require(name), Buffer, Date
    });
    const session = await module.exports.issueSessionForOtp(account.phone);
    assert.equal(session.pinConfigured, Boolean(configured));
    assert.equal(session.uid, account.uid);
    assert.ok(session.token.startsWith('jbmr1_'));
  }
});
