// The platform's policies (/terms, /privacy-policy, /refunds), without React:
// what the platform really does, in plain words. Every name, number and rate
// comes from the site's info (/api/site/info): the brand, the company's
// details and grievance officer, the trial and grace days and the GST rate;
// until the company's details are entered they say "the platform company".
// A lawyer reads them before the platform takes its first payment (GO_LIVE.md).
//
// policyOf(kind, info) -> { title, description, lead, sections: [{ heading, body: [text | { list: [text] }] }] }
import { companyName, gstPercent, trialWords } from "./siteWords.js";

const where = (company = {}) =>
  [company.address, [company.city, company.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

// How to reach the company: its support contact, else its own, as entered.
const ways = (info) => [info.support?.email || info.company?.email, info.support?.phone || info.company?.phone].filter(Boolean);

const officer = (info) => `our grievance officer${info.grievance?.name ? `, ${info.grievance.name},` : ""}`;

// "Write to us at …": the company's contact, or its Contact page until one is entered.
const writeToUs = (info) => (ways(info).length ? `Write to us at ${ways(info).join(" or ")}.` : "Write to us through the Contact page.");

// Writing to the company, and where a complaint goes.
function questionsAndComplaints(info) {
  const email = info.grievance?.email;
  if (!ways(info).length && !email) return `Write to us, or to ${officer(info)} with a complaint, through the Contact page.`;
  return `${writeToUs(info)} A complaint goes to ${officer(info)} ${email ? `at ${email}` : "the same way"}.`;
}

// "our grievance officer, Meera Rao, at grievance@acme.in"
function officerTo(info) {
  const email = info.grievance?.email;
  if (email) return `${officer(info)} at ${email}`;
  return ways(info).length ? `${officer(info)} at ${ways(info).join(" or ")}` : `${officer(info)} through the Contact page`;
}

const moreDays = (days) => `${days} more ${Number(days) === 1 ? "day" : "days"}`;

const trialParagraphs = (info) =>
  Number(info.trialDays) > 0
    ? [
        `A new business is free for ${trialWords(info.trialDays)} from the day it is registered, with every module and application its type can use. Nothing is paid to start, and no payment details are asked for.`,
        "Each business you add starts a trial of its own. During the trial you choose, in Your plan, the plan your business continues on.",
      ]
    : ["A new business has no free trial: it can be used once its first payment is confirmed."];

const graceSentence = (info) =>
  Number(info.graceDays) > 0
    ? `When paid time, or time we have given, ends, the business keeps working for ${moreDays(info.graceDays)} while you renew. There are no extra days after a free trial.`
    : "When paid time, or time we have given, ends, there are no extra days.";

function terms(info) {
  const company = companyName(info);
  const brand = info.brandName;
  const address = where(info.company);
  return {
    title: "Terms of service",
    description: `The terms on which a business uses ${brand}: the free trial, paying for a plan, what happens when a plan ends, and its records.`,
    lead: `These terms apply to every business that uses ${brand}, which ${company} provides, and to the person who signs it up.`,
    sections: [
      { heading: "Who provides the service", body: [
        `${brand} is provided by ${company}${address ? `, ${address}` : ""}. In these terms "we" and "us" are ${company}, and "you" is the business that uses the service and the person who signs it up.`,
      ] },
      { heading: "Your account", body: [
        "To sign up you give your name, mobile number, email and a password, and your business's name, type, city and state, with its GSTIN if it has one. The person who signs up is the business's owner, with full access to it.",
        "Each business keeps its own records. You give your staff logins of their own, with the role and access you choose, and you answer for what is done with your business's logins. Keep your password to yourself; you can also turn on two-step sign-in.",
      ] },
      { heading: "The free trial", body: trialParagraphs(info) },
      { heading: "Plans and prices", body: [
        "Each business pays for itself: the plan for its type with the modules it includes, and the modules and applications you add, for a month or a year at a time. The Pricing page shows every price.",
        `Prices are before GST. GST at ${gstPercent(info.gstRate)} is added, and every payment we confirm gets our GST tax invoice, which you find in Your plan.`,
        "A change in our prices reaches your business at its next order: an order keeps the prices it was made with. A change of plan, or an add-on you remove, applies from your next period; a module or application you add during paid time is charged for the days left in the period.",
      ] },
      { heading: "Paying", body: [
        "Until online payment is available, you pay by UPI or bank transfer to the details shown in Your plan and enter the payment's reference there, or pay by cash or cheque as we agree with you.",
        "Your business can be used as soon as we confirm the payment. The paid time runs from the day after your trial or paid time ends, so no day is lost; once your plan has ended, from the day you made the order.",
        "A payment we cannot match to money we received is rejected, with the reason, and the order stays open for you to pay or correct.",
      ] },
      { heading: "When a plan ends", body: [
        graceSentence(info),
        "After that, and as soon as a free trial ends, the business is read-only: you and your staff can still see, print and export everything, but nothing can be added or changed until you renew in Your plan.",
        "Nothing is deleted when a plan ends. Your records stay, and everything works again when you renew.",
      ] },
      { heading: "Stopping", body: [
        "A plan never renews by itself: to stop, do not renew. A period you have paid for is not refunded and runs to its end. The refunds policy says more.",
      ] },
      { heading: "Your business's data", body: [
        "Your business's records (its customers, bills, stock, staff, patients and the rest) are yours. We keep and process them only to provide the service to you, on your instructions. For your customers' personal data, under the Digital Personal Data Protection Act, 2023, your business is the data fiduciary and we are its data processor.",
        "We do not sell your records or use them for anything but the service. Our own team sees only what it needs to run your account: your plan, payments and invoices, and counts such as how many bills your business made in a month; never your customers, bills or patients.",
        "You decide what you collect from your customers and you answer their requests. The service gives you the tools: their consent to messages, their requests to see, correct or erase their data, and a register of breaches.",
        "You can export your records at any time, whatever the state of your plan.",
      ] },
      { heading: "Questions and complaints", body: [
        questionsAndComplaints(info),
      ] },
    ],
  };
}

function privacy(info) {
  const company = companyName(info);
  const brand = info.brandName;
  return {
    title: "Privacy policy",
    description: `What ${brand} collects about the people who ask to be called back, sign up or sign in, why, and the rights they have.`,
    lead: `How ${company} collects and uses the personal data of the people who ask us to call them back, sign up for ${brand} or sign in to it.`,
    sections: [
      { heading: "What we collect", body: [{ list: [
        "When you ask us to call you back: your name and mobile number; your email, business type, city and message if you give them; when you agreed to be contacted; and the source the link that brought you names, if it names one.",
        "When you sign up: your name, mobile number and email, and your password, kept only in a form that cannot be read back; your business's name, type, city and state, and its GSTIN if you give it; and the plan you choose.",
        "When you sign in: the time, the browser and the network address of each sign-in, kept in your sign-in history.",
        "When you pay: the method, reference and date of each payment, and our invoices to your business.",
      ] }] },
      { heading: "Why we use it", body: [
        { list: [
          `To call you back about ${brand}, as you asked.`,
          "To run your account and your business's plan.",
          "To issue our GST tax invoices, and keep them as the tax law asks.",
          "To keep signing in safe: a login locks after repeated wrong passwords, and you can see your own sign-ins.",
        ] },
        "We do not use it for advertising and we do not sell it. Our own team sees it to run the service and to call you back; we share it with no one else unless the law requires it.",
      ] },
      { heading: "Your business's customers", body: [
        "The personal data your business keeps about its customers, patients and staff is your business's. We process it only on your business's instructions, to provide the service: under the Digital Personal Data Protection Act, 2023, your business is its data fiduciary and we are its data processor. A customer who wants to see, correct or erase their data asks the business they gave it to.",
      ] },
      { heading: "How long we keep it", body: [
        "Your account and your business's details stay while your business uses the service; our invoices and the payments behind them stay as long as the tax law asks.",
      ] },
      { heading: "Your rights", body: [
        "Under the Digital Personal Data Protection Act, 2023, you may ask us what personal data we hold about you, have it corrected or erased, take back your consent to be contacted, and complain to us; if we do not settle your complaint, you may take it to the Data Protection Board of India.",
        `To ask, or to complain, write to ${officerTo(info)}.`,
      ] },
      { heading: "Your browser", body: [
        "The app keeps your sign-in and a few of your choices in your browser's storage, and remembers this browser for your login. It uses no advertising or tracking cookies.",
      ] },
      { heading: "Keeping it safe", body: [
        "Passwords are kept only as hashes. A login locks after repeated wrong passwords, two-step sign-in can be turned on, and each business sees only its own records, checked on every request.",
      ] },
      { heading: "Who we are", body: [
        `${company}${where(info.company) ? `, ${where(info.company)}` : ""}. ${writeToUs(info)}`,
      ] },
    ],
  };
}

function refunds(info) {
  const brand = info.brandName;
  const trial = Number(info.trialDays) > 0;
  return {
    title: "Refunds, cancellation and service delivery",
    description: `How a ${brand} plan is paid for, stopped and delivered, and why a paid period is not refunded.`,
    lead: `How paying for ${brand} works, what happens when you stop, and how the service reaches you.`,
    sections: [
      { heading: "How the service is delivered", body: [
        `${brand} is delivered online. You and your staff use it in a web browser on a computer, tablet or phone, ${trial ? `from the moment you sign up (free for ${trialWords(info.trialDays)})` : "once your first payment is confirmed"} and then for the time you have paid for. Nothing is sent by post.`,
      ] },
      { heading: "Paying", body: [
        `You pay for each business, monthly or yearly: its plan and the modules and applications you add, at the prices on the Pricing page, with GST at ${gstPercent(info.gstRate)} on top.`,
        "Until online payment is available, pay by UPI or bank transfer to the details shown in Your plan and enter the payment's reference there, or pay by cash or cheque as we agree with you. When we confirm the payment, your business can be used at once and our GST tax invoice appears in Your plan.",
        "An order you have not paid holds its prices until the date shown on it; after that you make a new one.",
      ] },
      { heading: "Refunds", body: [
        "A period you have paid for is not refunded, in whole or in part, once its payment is confirmed: not when you stop using the service, and not when you remove a module or application before the period ends. What you paid for stays usable to the end of the period.",
        "A payment we cannot match to money we received is rejected, with the reason, and the order stays open. If you think you paid by mistake or paid twice, write to us.",
      ] },
      { heading: "Stopping", body: [
        "A plan never renews by itself and nothing is taken from your account: to stop, do not renew.",
        graceSentence(info),
        "After that the business is read-only: you can still see, print and export everything. Nothing is deleted, and renewing in Your plan brings everything back.",
      ] },
      { heading: "Questions", body: [
        questionsAndComplaints(info),
      ] },
    ],
  };
}

const POLICIES = { terms, privacy, refunds };

export const POLICY_KINDS = Object.keys(POLICIES);

export const policyOf = (kind, info) => POLICIES[kind](info);

// The page's heading before the company's details have arrived.
export const POLICY_TITLES = { terms: "Terms of service", privacy: "Privacy policy", refunds: "Refunds, cancellation and service delivery" };
