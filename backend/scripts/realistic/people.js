// Indian names, phone numbers, PANs and GSTINs for the realistic demo. Every
// person, shop and number here is made up; GSTINs carry a correct check
// character (the same check the app applies) but belong to no one.
const { rng } = require('./clock');

const FIRST = {
  telugu: { m: ['Srinivas', 'Venkatesh', 'Ramesh', 'Suresh', 'Naresh', 'Mahesh', 'Ravi Teja', 'Kiran', 'Prasad', 'Nagaraju', 'Satyanarayana', 'Raghavendra', 'Anil', 'Chandrasekhar', 'Harish', 'Vamshi', 'Sai Kumar', 'Praveen', 'Srikanth', 'Madhusudhan'],
    f: ['Lakshmi', 'Padmavathi', 'Swathi', 'Sravani', 'Anusha', 'Divya', 'Kavitha', 'Sujatha', 'Madhavi', 'Bhavani', 'Haritha', 'Sirisha', 'Pavani', 'Radha', 'Manjula', 'Sunitha', 'Aruna', 'Deepika', 'Keerthi', 'Vani'] },
  hyderabadi: { m: ['Mohammed Irfan', 'Syed Abdul Rahman', 'Mohd. Imran', 'Abdul Khader', 'Mir Asif Ali', 'Shaik Sameer', 'Mohammed Rafi', 'Syed Ameenuddin', 'Faisal Khan', 'Mohd. Nawaz'],
    f: ['Ayesha Begum', 'Fathima', 'Sana Fatima', 'Nazia Sultana', 'Shabana', 'Rizwana Begum', 'Asma', 'Heena Kausar', 'Zeenath', 'Saba'] },
  kannada: { m: ['Manjunath', 'Prakash', 'Raghu', 'Shivakumar', 'Naveen', 'Girish', 'Basavaraj', 'Chetan', 'Sunil', 'Vinay', 'Darshan', 'Mohan', 'Harsha', 'Santosh', 'Ananth'],
    f: ['Shwetha', 'Kavya', 'Pooja', 'Rashmi', 'Nandini', 'Bhavya', 'Sowmya', 'Deepa', 'Spoorthi', 'Ranjitha', 'Archana', 'Shruthi', 'Vidya', 'Anitha', 'Megha'] },
  marathi: { m: ['Sachin', 'Rahul', 'Amol', 'Prashant', 'Nitin', 'Sandeep', 'Ganesh', 'Vijay', 'Mangesh', 'Aniket', 'Omkar', 'Tushar', 'Sagar', 'Yogesh', 'Ajinkya'],
    f: ['Sneha', 'Pooja', 'Priyanka', 'Ashwini', 'Madhuri', 'Sayali', 'Rutuja', 'Shraddha', 'Manasi', 'Gauri', 'Pallavi', 'Vaishali', 'Aparna', 'Sonali', 'Ketaki'] },
  tamil: { m: ['Karthik', 'Senthil', 'Murugan', 'Prabhu', 'Saravanan', 'Ganesh', 'Arun', 'Vignesh', 'Balaji', 'Ramesh', 'Dinesh', 'Sathish', 'Kumaravel', 'Anand', 'Manikandan'],
    f: ['Priya', 'Lakshmi', 'Meenakshi', 'Kavitha', 'Revathi', 'Divya', 'Sangeetha', 'Gayathri', 'Janani', 'Nithya', 'Malathi', 'Bhuvana', 'Deepa', 'Uma', 'Anitha'] },
  north: { m: ['Rajesh', 'Amit', 'Sanjay', 'Rohit', 'Vikas', 'Manoj', 'Deepak', 'Ankit', 'Gaurav', 'Pankaj', 'Sumit', 'Ashok', 'Naveen', 'Harish', 'Mukesh'],
    f: ['Neha', 'Pooja', 'Ritu', 'Anjali', 'Sunita', 'Kavita', 'Priyanka', 'Shalini', 'Megha', 'Sonia', 'Preeti', 'Nisha', 'Rekha', 'Swati', 'Jyoti'] },
};
const LAST = {
  telugu: ['Reddy', 'Rao', 'Goud', 'Naidu', 'Chowdary', 'Varma', 'Sharma', 'Yadav', 'Murthy', 'Achari', 'Gupta', 'Setty', 'Raju', 'Kumar', 'Prasad'],
  hyderabadi: ['', '', '', 'Siddiqui', 'Quadri', 'Hussaini', 'Ansari', 'Baig', 'Pasha', 'Khan'],
  kannada: ['Gowda', 'Shetty', 'Hegde', 'Rao', 'Kulkarni', 'Bhat', 'Naik', 'Murthy', 'Patil', 'Swamy', 'Prasad', 'Kamath'],
  marathi: ['Patil', 'Deshmukh', 'Kulkarni', 'Joshi', 'Pawar', 'Jadhav', 'Shinde', 'Deshpande', 'Gaikwad', 'More', 'Kale', 'Bhosale', 'Chavan'],
  tamil: ['', '', 'Subramanian', 'Krishnan', 'Raman', 'Natarajan', 'Sundaram', 'Venkatesan', 'Pillai', 'Iyer', 'Rajendran', 'Murugesan'],
  north: ['Sharma', 'Gupta', 'Agarwal', 'Verma', 'Singh', 'Jain', 'Bansal', 'Malhotra', 'Arora', 'Kapoor', 'Mittal', 'Chopra', 'Khanna', 'Goel'],
};

// n distinct people from a region: { name, gender }.
function people(region, n, seed) {
  const r = rng(`people|${region}|${seed}`);
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < n && guard < n * 50) {
    guard += 1;
    const gender = r.chance(0.5) ? 'm' : 'f';
    const first = r.pick(FIRST[region][gender]);
    const last = r.pick(LAST[region]);
    const name = last && !first.includes(' ') ? `${first} ${last}` : first;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, gender });
  }
  return out;
}

// A ten-digit Indian mobile number, written "98480 12345".
function mobile(seed) {
  const r = rng(`mobile|${seed}`);
  const first = r.pick(['98', '99', '97', '96', '95', '94', '93', '91', '90', '89', '88', '87', '86', '85', '84', '81', '80', '79', '78', '77', '76', '73', '70', '63']);
  let rest = '';
  for (let i = 0; i < 8; i += 1) rest += r.int(0, 9);
  const digits = first + rest;
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}

// GSTIN check character (the GSTN mod-36 scheme).
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinCheck(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}
// A PAN: three letters, the holder type (P person, F firm, C company), the
// first letter of the name, four digits and a letter.
function pan(seed, holder, nameLetter) {
  const r = rng(`pan|${seed}`);
  const L = 'ABCDEFGHIJKLMNPQRSTUVWXYZ';
  const letters = Array.from({ length: 3 }, () => r.pick([...L])).join('');
  const digits = String(r.int(1000, 9999));
  return `${letters}${holder}${nameLetter.toUpperCase()}${digits}${r.pick([...L])}`;
}
function gstin(stateCode, seed, holder = 'P', nameLetter = 'A') {
  const first14 = `${stateCode}${pan(seed, holder, nameLetter)}1Z`;
  return first14 + gstinCheck(first14);
}

module.exports = { people, mobile, gstin, gstinCheck, pan };
