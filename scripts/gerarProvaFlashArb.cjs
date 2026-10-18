// Builds a strictly read-only FlashArb runtime with immutable metadata.
const fs=require('node:fs');
const path=require('node:path');
const solc=require('solc');
const source=fs.readFileSync('contracts/FlashArb.sol','utf8');
const input={language:'Solidity',sources:{'FlashArb.sol':{content:source}},
 settings:{optimizer:{enabled:true,runs:200},
 outputSelection:{'*':{'*':['evm.deployedBytecode.object',
 'evm.deployedBytecode.immutableReferences','evm.bytecode.object','abi']}}}};
const output=JSON.parse(solc.compile(JSON.stringify(input)));
const errors=(output.errors||[]).filter(e=>e.severity==='error');
if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
const c=output.contracts['FlashArb.sol'].FlashArb;
const refs=c.evm.deployedBytecode.immutableReferences;
const ranges=Object.values(refs).flat();
if(!ranges.length||ranges.some(x=>x.length!==32))
 throw Error('FlashArb owner immutable reference missing or unexpected');
const out={runtime:'0x'+c.evm.deployedBytecode.object,
 creation:'0x'+c.evm.bytecode.object,ownerReferences:ranges,
 abi:c.abi,compiler:solc.version()};
const dest='.tmp/artifacts/FlashArbProva.json';
fs.mkdirSync(path.dirname(dest),{recursive:true});
fs.writeFileSync(dest,JSON.stringify(out));
process.stdout.write('FlashArb override artifact built, owner refs '+ranges.length+'\n');
