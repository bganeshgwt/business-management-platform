// The people a business's PIN prompt offers, as each list's API gives them:
// { id, name, has_pin, pin_given }. The prompts are a manager's approval (a
// refund, an override, money handed back), a credit hold's release and a
// pharmacist's or pathologist's signature. A PIN someone else set (an admin,
// under Users) approves and signs nothing until its person chooses their own,
// so the prompt shows that person as the restaurant's approval prompt does:
// "PIN not their own yet", not to be picked, and why. The server refuses that
// PIN all the same (409 pin_not_own).

export const NOT_OWN = "PIN not their own yet";
export const NOT_YOURS = "PIN not your own yet";

const same = (a, b) => String(a) === String(b);

// Why a person cannot be picked, in the option's own words ("" when they can).
export const pinNote = (person) => (!person.has_pin ? "no PIN set" : person.pin_given ? NOT_OWN : "");

// The option's words: the name (or `label`), and why not when they cannot be picked.
export function optionText(person, label = person.name) {
  const note = pinNote(person);
  return note ? `${label} (${note})` : label;
}

// "Me" in the list, the signed-in person approving it themselves: not ready
// when the step needs their PIN and someone else set it (their own row of
// the list says so). { ready, text }
export function meChoice(people, user, needsPin = true) {
  const given = (people || []).some((p) => same(p.id, user?.id) && p.has_pin && p.pin_given);
  const ready = !needsPin || !given;
  return { ready, text: `Me (${user?.name || "you"})${ready ? "" : ` (${NOT_YOURS})`}` };
}

const listed = (words) => (words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

// The reason under the list, in the restaurant prompt's words, for those
// listed whose PIN someone else set; `me`: the signed-in person's own is one
// of them; `signs`: a signature, not an approval. "" when there is none.
export function notOwnReason(people, { me = false, signs = false } = {}) {
  const act = signs ? "sign" : "approve";
  const names = (people || []).filter((p) => p.has_pin && p.pin_given).map((p) => `${p.name}'s`);
  const parts = [];
  if (me) parts.push(`Your PIN was set by someone else: it ${act}s nothing until you choose your own under My profile.`);
  if (names.length === 1) parts.push(`${names[0]} PIN was set by someone else: it ${act}s nothing until they choose their own under My profile.`);
  if (names.length > 1) parts.push(`${listed(names)} PINs were set by someone else: they ${act} nothing until they choose their own under My profile.`);
  return parts.join(" ");
}
