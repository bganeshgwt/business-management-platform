const crypto = require('node:crypto');

// Personal data in tests, through the same API an owner and the counter use.
// A consent is given on the business's privacy notice, so a business
// publishes one first: the starter text it is offered, with its contact.
// `base` is '/businesses/<id>' for a business, '' for the signed-in
// restaurant; `request(method, route, body, expected)` is the test's own caller.

async function publishNotice(request, base, contact = { contactName: 'The owner', contactPhone: '98450 00000' }) {
  const { current, starter } = await request('GET', `${base}/privacy/notice`);
  if (current) return current;
  return request('POST', `${base}/privacy/notices`, { ...starter, ...contact, requestKey: crypto.randomUUID() }, 201);
}

// Records the person's consent to these purposes, as taken at the counter.
async function giveConsent(request, base, personId, purposes, extra = {}) {
  return request('POST', `${base}/privacy/people/${personId}/consents`, { purposes, channel: 'counter', method: 'verbal', ...extra }, 201);
}

module.exports = { publishNotice, giveConsent };
