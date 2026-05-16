import fs from 'fs';
import { handleWebhook } from './src/brain.js';
import { S } from './src/stateStore.js';
const data=JSON.parse(fs.readFileSync('/mnt/data/BrainRAY_v5.1_May11_replay_1345_1616_ticks_with_secret.json','utf8'));
for (let i=0;i<data.length;i++){
 const e=data[i];
 const r=handleWebhook(e);
 if(i<80 && (e.src==='features'||e.src==='ray')) console.log(i,e.src,e.time,e.event,r.json?.kind,'lastFeature',S.lastFeatureTime,S.lastFeature?.close);
}
console.log(S.logs.filter(l=>/FIRST_ENTRY|ENTER|EXIT|DYNAMIC_TP|POST_EXIT/.test(l)).join('\n'));
