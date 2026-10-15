import { readFile, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { compileCapture, packageFiles } from './theme-pipeline.mjs';

const args=process.argv.slice(2);
const source=args.find(value=>!value.startsWith('--'))??'packages/theme-chatgpt/capture/public-home-light.json';
const outArg=args.find(value=>value.startsWith('--out='));
const output=path.resolve(outArg?.slice(6)??'artifacts/theme-candidates/chatgpt');
// Never overwrite runtime source or the active package.
if(output.split(path.sep).includes('src')||output===path.resolve('packages/theme-chatgpt'))throw new Error('theme-compile:unsafe-candidate-destination');
const template=compileCapture(JSON.parse(await readFile(source,'utf8')));
const files=packageFiles(template);
files['template-contract.ts']=await readFile(new URL('../packages/display-sdk/src/template.ts',import.meta.url),'utf8');
await mkdir(path.dirname(output),{recursive:true});
const staging=await mkdtemp(`${output}.staging-`);
try {
  for(const [name,content]of Object.entries(files)){const filename=path.join(staging,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,content);}
  // Hash directories retain older candidates and never replace the active theme.
  const destination=`${output}-${template.manifest.contentHash.slice(0,12)}`;
  try{await rename(staging,destination);}catch(error){
    if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;
    for(const [name,content]of Object.entries(files))if(await readFile(path.join(destination,name),'utf8')!==content)throw new Error('theme-compile:candidate-content-conflict');
    await rm(staging,{recursive:true,force:true});
  }
  console.log(JSON.stringify({candidate:destination,runtimeReady:template.manifest.runtimeReady,evidence:template.manifest.evidence,activeThemeChanged:false}));
} catch(error){await rm(staging,{recursive:true,force:true});throw error;}
