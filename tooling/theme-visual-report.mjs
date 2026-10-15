import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { REQUIRED_SLOTS, stableJSON } from './theme-pipeline.mjs';

/** Compare only measured geometry and typography under equal capture conditions.
 * This is not a screenshot/pixel score and never certifies subjective visual fidelity. */
export function compareThemeMeasurements(reference, replay, thresholds={geometry:4,fontSize:1,lineHeight:2}) {
  if(!['geometry','fontSize','lineHeight'].every(key=>Number.isFinite(thresholds[key])&&thresholds[key]>=0))throw new Error('theme-report:invalid-thresholds');
  const result={schemaVersion:1,status:'missing-reference',kind:'geometry-and-typography',thresholds,checks:[],missing:[],visualComparison:'not-established',manualReviewRequired:true};
  let origin;try{origin=new URL(reference?.origin).origin;}catch{origin=null;}
  if(!reference||reference.schemaVersion!==2||reference.evidence!=='rendered-dom'||origin!=='https://chatgpt.com'||!reference.state?.startsWith('conversation-')||reference.missing?.length||reference.truncated){result.missing.push('real-conversation-reference');return result;}
  if(!replay){result.status='missing-replay';result.missing.push('replay');return result;}
  const readCondition=(capture,name)=>name.startsWith('viewport.')?capture.viewport?.[name.slice(9)]:capture.environment?.[name];
  for(const name of ['viewport.width','viewport.height','devicePixelRatio','zoom','language']) {
    const expected=readCondition(reference,name),actual=readCondition(replay,name);
    if(expected===undefined||expected===null||actual===undefined||actual===null||(name==='language'&&(expected==='und'||actual==='und'))){result.missing.push(`condition:${name}`);continue;}
    if(expected!==actual)result.checks.push({slot:'environment',property:name,pass:false,reason:'different-condition'});
  }
  if(reference.state!==replay.state)result.checks.push({slot:'environment',property:'state',pass:false,reason:'different-condition'});
  if(reference.environment?.fontsReady!==true||replay.environment?.fontsReady!==true)result.missing.push('condition:fonts-ready');
  for(const slot of REQUIRED_SLOTS) {
    const left=reference.slots?.[slot],right=replay.slots?.[slot];
    if(!left||!right){result.missing.push(`slot:${slot}`);continue;}
    for(const property of ['x','y','width','height']) {
      const expected=left.rect?.[property],actual=right.rect?.[property];
      if(!Number.isFinite(expected)||!Number.isFinite(actual)){result.missing.push(`measurement:${slot}.${property}`);continue;}
      const difference=Math.abs(actual-expected);result.checks.push({slot,property,expected,actual,difference,tolerance:thresholds.geometry,pass:difference<=thresholds.geometry});
    }
    for(const [property,tolerance]of [['font-size',thresholds.fontSize],['line-height',thresholds.lineHeight]]) {
      const leftValue=left.css?.[property],rightValue=right.css?.[property];
      if(!/^\d+(?:\.\d+)?px$/.test(leftValue??'')||!/^\d+(?:\.\d+)?px$/.test(rightValue??'')){result.missing.push(`measurement:${slot}.${property}`);continue;}
      const expected=parseFloat(leftValue),actual=parseFloat(rightValue),difference=Math.abs(actual-expected);
      result.checks.push({slot,property,expected,actual,difference,tolerance,pass:difference<=tolerance});
    }
    if(left.css?.['font-family']&&right.css?.['font-family'])result.checks.push({slot,property:'font-family',pass:left.css['font-family']===right.css['font-family']});
    else result.missing.push(`measurement:${slot}.font-family`);
  }
  result.status=result.checks.some(check=>!check.pass)?'failed':result.missing.length?'incomplete':'measurements-passed';
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [referencePath,replayPath,outputPath]=process.argv.slice(2);
  const read=async filename=>filename&&filename!=='-'?JSON.parse(await readFile(filename,'utf8')):null;
  const report=compareThemeMeasurements(await read(referencePath),await read(replayPath));
  const json=stableJSON(report);
  if(outputPath)await writeFile(outputPath,json);else process.stdout.write(json);
}
