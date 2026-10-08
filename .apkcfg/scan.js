const fs = require('fs');
const dir = 'dex';
const pats = {
  GDT:    /Lcom[\/]windmill[\/]gdt[A-Za-z0-9\/$]*;/g,
  KWAI:   /Lcom[\/](kwad|ks\.ad|kuaishou)[A-Za-z0-9\/$]*;/g,
  PANGLE: /Lcom[\/](pangle|bytedance\.sdk\.openadsdk)[A-Za-z0-9\/$]*;/g,
  SIGMOB: /Lcom[\/]czhj[\/]sdk[A-Za-z0-9\/$]*;/g,
};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.dex')) continue;
  const s = fs.readFileSync(dir + '/' + f).toString('latin1');
  for (const [name, re] of Object.entries(pats)) {
    const m = [...new Set((s.match(re) || []).map(x => x.slice(0, -1)))];
    if (m.length) console.log(f, name + ':', m.slice(0, 14).join(' '));
  }
}