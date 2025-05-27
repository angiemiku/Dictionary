const { mwKey, appId, botToken, publicKey } = require('./config.json');
const express = require('express');
const nacl = require('tweetnacl');
const { fetch, request } = require('undici');
const app = express();
const port = 10000;

const trim = (text, max) => text?.length > max ? text.substring(0, max - 1) + '…' : text;
const cache = {};
const autocompleteCache = {};

const lookup = async (word) => {
  if (cache[word]) return cache[word];
  const result = await (await request(`https://dictionaryapi.com/api/v3/references/collegiate/json/${word}?key=${mwKey}`)).body.json();
  cache[word] = result;
  return result;
};

const generateComponents = (word, page, result) => [
  {
    type: 1,
    components: [{
      type: 2,
      style: 1,
      label: '1',
      custom_id: `${word}:0:first`,
      disabled: page === 0
    },
    {
      type: 2,
      style: 1,
      label: result[page - 1] ? `Previous (${page})` : 'Previous',
      custom_id: `${word}:${page - 1}:prev`,
      disabled: !result[page - 1]
    },
    {
      type: 2,
      style: 1,
      label: result[page + 1] ? `Next (${page + 2})` : 'Next',
      custom_id: `${word}:${page + 1}:next`,
      disabled: !result[page + 1]
    },
    {
      type: 2,
      style: 1,
      label: result.length,
      custom_id: `${word}:${result.length - 1}:last`,
      disabled: page === result.length - 1
    }]
  },
  {
    type: 1,
    components: [{
      type: 3,
      custom_id: 'select',
      placeholder: 'Choose a definition',
      options: result.map((d, i) => ({
        label: trim(`${i + 1}. ${d.hwi.hw.replace(/\*/g, '')}${d.fl ? ` (${d.fl})` : ''}`, 100),
        description: trim(d.shortdef.join(', ') || d.cxs && `${d.cxs[0].cxl} ${d.cxs[0].cxtis[0].cxt}`, 100),
        value: `${word}:${i}`,
        default: i === page
      }))
    }]
  }
];

const generateMessage = async (word, page, hide) => {
  const result = await lookup(word);
  const entry = result[page];
  if (!entry?.hwi) {
    return { content: 'Not found', flags: 64 };
  }
  return {
    embeds: [{
      title: `${entry.hwi.hw.replace(/\*/g, '·')}${entry.fl ? ` (${entry.fl})` : ''}`,
      url: `https://www.merriam-webster.com/dictionary/${encodeURIComponent(entry.hwi.hw.replace(/\*/g, ''))}`,
      description: entry.shortdef.map(s => `• ${s}`).join('\n') || entry.cxs && `${entry.cxs[0].cxl} ${entry.cxs[0].cxtis[0].cxt}`,
      footer: { text: 'Powered by Merriam-Webster' }
    }],
    components: generateComponents(word, page, result),
    flags: hide ? 64 : 0
  };
};

app.use(express.json({ verify: (req, res, buf) => req.rawBody = buf }));

function verifyDiscordRequest(req, res, next) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (!signature || !timestamp) return res.status(401).end();
  const isValid = nacl.sign.detached.verify(
    Buffer.concat([Buffer.from(timestamp, 'utf8'), req.rawBody]),
    Buffer.from(signature, 'hex'),
    Buffer.from(publicKey, 'hex')
  );
  if (!isValid) return res.status(401).end();
  next();
};

app.post('/interactions', verifyDiscordRequest, async (req, res) => {
  const { type, data } = req.body;
  
  if (type === 1) {
    return res.send({ type: 1 });
  }

  if (type === 2) {
    try {
      const query = data.options?.find(opt => opt.name === 'term')?.value;
      const hide = data?.options?.find(opt => opt.name === 'hide')?.value;
      if (!query) return res.send({ type: 4, data: { content: 'You didn’t enter a term.', flags: 64 } });
      return res.send({ type: 4, data: await generateMessage(query, 0, hide) });
    } catch (e) {
      console.log('/DEFINE: ', e);
      return res.send({ type: 4, data: { content: 'Something went wrong, please try again later.', flags: 64 } });
    }
  }

  if (type === 3) {
    const [word, page] = (data.values?.[0] || data.custom_id).split(':')
    return res.send({ type: 7, data: await generateMessage(word, parseInt(page)) });
  }

  if (type === 4) {
    const query = data.options?.find(opt => opt.name === 'term')?.value;
    if (!query) {
      const results = (await (await request('https://www.merriam-webster.com/lapi/v1/mwol-mp/get-lookups-data-homepage')).body.json()).data.words
      return res.send({
        type: 8,
        data: {
          choices: [
            { name: 'Type your query, or select a current top Merriam-Webster lookup:', value: '' },
            ...results.slice(0, 24).map(r => ({ name: r, value: r }))
          ]
        }
      });
    } else {
      if (!autocompleteCache[query]) {
        const results = (await (await request(`https://www.merriam-webster.com/lapi/v1/mwol-search/autocomplete?search=${query}`)).body.json()).docs
        autocompleteCache[query] = results.filter(r => r.ref === 'owl-combined').map(r => r.word).slice(0, 25);
      }
      return res.send({ type: 8, data: { choices: autocompleteCache[query].map(w => ({ name: w, value: w })) } });
    }
  }

  return res.send({ type: 4, data: { content: 'Unknown command.', flags: 64 } });
});


const COMMAND = [{
  name: 'define',
  description: "Look up a word's definition",
  options: [{
    name: 'term',
    description: 'The word to define',
    type: 3,
    required: true,
    autocomplete: true
  }, {
    type: 5,
    name: 'hide',
    description: 'Hide command output'
  }],
  integration_types: [0, 1],
  contexts: [0, 2]
}];

(async () => {
  try {
    const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(COMMAND),
    });
    console.log(response.ok ? 'Command set!' : `Command error: ${await response.text()}`);
  } catch (err) {
    console.log('Failed to register command:', err);
  }
})();

app.get('/', (req, res) => res.send('Meow!')); 
app.listen(port, () => console.log(`Listening on port: ${port}`));
