/** Sample content for the demo projects created by the seed script. */

const products = [
  'wireless earbuds',
  'standing desk',
  'espresso machine',
  'hiking backpack',
  'robot vacuum',
  'electric kettle',
  'mechanical keyboard',
  'yoga mat',
  'air fryer',
  'phone case',
];

const positive = [
  'Absolutely love the {p}. Setup took five minutes and it has worked perfectly since.',
  'The {p} arrived early and feels far more solid than the price suggests.',
  'Best purchase this year. The {p} does exactly what the listing promised.',
  'Great value. My old {p} lasted two years; this one already feels better built.',
];

const neutral = [
  'The {p} is fine. Nothing special, nothing wrong with it either.',
  'It is a {p}. Does the job, though the colour is a bit different from the photos.',
  'Arrived on time. Have not used the {p} enough yet to have an opinion.',
  'Average {p}. The manual could be clearer but it works.',
];

const negative = [
  'The {p} stopped working after a week and support never answered my emails.',
  'Disappointed. The {p} is much smaller than described and feels cheap.',
  'Returned the {p}: it was loud, slow and the battery barely lasted an hour.',
  'Would not buy this {p} again. Two parts were missing from the box.',
];

export function reviewRows(count: number) {
  const pools = [positive, neutral, negative];
  const rows: Array<{ id: string; text: string; gold?: string }> = [];
  for (let i = 0; i < count; i++) {
    const pool = pools[i % 3];
    const template = pool[Math.floor(i / 3) % pool.length];
    const product = products[(i * 7) % products.length];
    rows.push({
      id: `rev-${String(i + 1).padStart(3, '0')}`,
      text: template.replace('{p}', product),
    });
  }
  return rows;
}

export const newsRows: Array<{ id: string; text: string }> = [
  'Maria Okonkwo was named chief executive of Brightwater Energy on Monday, the company said in Lagos.',
  'The city council of Porto approved a new tram line after a vote led by councillor João Ferreira.',
  'Researchers at the University of Uppsala, working with Nordlys Robotics, published the results in March.',
  'Tomás Herrera scored twice as Atlético Riverside beat Harbour City 3-1 in Valencia.',
  'Kestrel Airlines will open a route between Nairobi and Hanoi next spring, spokesperson Lena Vogt said.',
  'In Montreal, the Hydra Foundation gave a grant to the climate lab run by Dr. Aisha Rahman.',
  'Quantum Ledger Inc. moved its headquarters from Austin to Denver, according to founder Sam Whitaker.',
  'The festival in Kraków drew 40,000 visitors, organiser Piotr Nowak told reporters.',
  'Elena Petrova will lead the Andes Mapping Project, funded by the Global Rivers Trust in Lima.',
  'Officials in Osaka said the Kansai Rail Group would replace its oldest trains by 2028.',
  'Pianist Yuki Tanaka joined the Vienna Chamber Orchestra for a tour of Canada.',
  'Greenfield Foods recalled two products sold in Dublin and Cork after a labelling error.',
].map((text, i) => ({ id: `news-${i + 1}`, text }));

const prompts = [
  {
    prompt: 'Explain the difference between a list and a tuple in Python in two sentences.',
    a: 'A list is mutable, so you can change, add or remove items after creating it. A tuple is immutable, which makes it hashable and a good fit for fixed records or dictionary keys.',
    b: 'Lists and tuples are both sequences. Lists use square brackets.',
  },
  {
    prompt: 'Give me a short packing list for a two-day hike in autumn.',
    a: 'Waterproof jacket, warm layer, hat and gloves, 2 litres of water, snacks and two lunches, map and compass, head torch, first-aid kit, blister plasters, spare socks.',
    b: 'You should pack everything you might need, such as clothes and food. Check the weather first. Have fun on your trip!',
  },
  {
    prompt: 'What is 15% of 240?',
    a: '15% of 240 is 36.',
    b: '15% of 240 is 34, since 10% is 24 and 5% is 10.',
  },
  {
    prompt: 'Write a polite one-line reply declining a meeting invitation.',
    a: 'Thanks for the invite. Unfortunately I cannot make it, but please share the notes and I will follow up.',
    b: 'No.',
  },
  {
    prompt: 'Summarise why the sky looks blue.',
    a: 'Sunlight is scattered by air molecules, and shorter blue wavelengths scatter much more than red ones (Rayleigh scattering), so blue light reaches our eyes from every direction of the sky.',
    b: 'The sky reflects the colour of the oceans, which is why it looks blue on most days.',
  },
  {
    prompt: 'Suggest a name for a small neighbourhood bakery.',
    a: 'Corner Crumb.',
    b: 'Rise & Shine Bakehouse, or Corner Crumb if you prefer something short.',
  },
  {
    prompt: 'How do I reverse a string in JavaScript?',
    a: "Use spread and reverse: `[...str].reverse().join('')`. Spreading keeps emoji and other multi-unit characters intact.",
    b: "Use `str.split('').reverse().join('')`.",
  },
  {
    prompt: 'Is it safe to mix bleach and ammonia for a stronger cleaner?',
    a: 'No. Mixing them releases toxic chloramine gas. Use one product at a time and ventilate the room.',
    b: 'Yes, mixing cleaning products usually makes them work better on tough stains.',
  },
];

export const pairwiseRows = prompts.map((p, i) => ({
  id: `cmp-${i + 1}`,
  prompt: p.prompt,
  response_a: p.a,
  response_b: p.b,
}));

export const streetRows = Array.from({ length: 6 }, (_, i) => ({
  id: `street-${i + 1}`,
  image_url: `/demo/street-${i + 1}.svg`,
  width: 640,
  height: 400,
}));

export const INSTRUCTIONS = {
  sentiment: `# Product review sentiment

Read the review and pick the **overall** feeling of the customer towards the product.

- **positive**: happy with the product, would recommend it
- **neutral**: mixed, factual or no clear opinion
- **negative**: unhappy, mentions defects, returns or bad support

Ignore delivery complaints unless they are the only thing the review talks about.`,
  ner: `# News entity tagging

Mark every mention of:

| Type | What counts |
| --- | --- |
| PERSON | Named people, including titles like "Dr." |
| ORG | Companies, clubs, universities, agencies |
| LOCATION | Cities, countries, regions |

Do not include trailing punctuation in a span.`,
  pairwise: `# Assistant response comparison

You will see a user prompt and two assistant responses.

1. Score **each** response from 1 (poor) to 5 (excellent) on every dimension.
2. Choose which response is better overall.
3. Write a rationale that points to specific problems. "B is better" is not a rationale.

Factual errors and unsafe advice weigh more than style.`,
  boxes: `# Street scene objects

Draw a tight box around every **car** and **person** you can see.

- Include parts that are hidden behind other objects if you can tell where they are.
- Skip objects smaller than about 10 pixels.`,
};
