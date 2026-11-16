import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
function harness(failSecondPage=false) {
 const routes=new Map(),calls=[];
 const data=Array.from({length:2503},(_,i)=>({id:i+1,type:'local',title:`Song ${i}`,artist:'Artist',album:`Album ${i%3}`,file_path:`music/album-${i%3}/track${i}.flac`,duration:1,file_size:2,year:2026}));
 const router={};for(const method of ['get','post','put','delete'])router[method]=(path,handler)=>routes.set(method+path,handler);
 const sdk={createRouter:()=>router,parseQuery:query=>Object.fromEntries(new URLSearchParams(query)),jsonResponse:(body,statusCode=200)=>({statusCode,body:JSON.stringify(body)})};
 const context=vm.createContext({exports:{},require:()=>sdk,URLSearchParams,console,setTimeout:callback=>{callback();return 1},songloft:{log:{info(){},error(){}},plugin:{getHostUrl:async()=>'',getToken:async()=>''},songs:{list:async options=>{calls.push({...options});if(failSecondPage&&options.offset===1000)throw new Error('page unavailable');return data.slice(options.offset,options.offset+options.limit)}}},fetch:async()=>({ok:true,text:async()=>JSON.stringify({path:'music'})})});
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInContext(js,context);
 const index=async query=>{const response=await routes.get('get/api/index')({query});return {status:response.statusCode,...JSON.parse(response.body)}};
 return {calls,index};
}
test('background indexing pages through the full library and reuses the completed index',async()=>{
 const h=harness();const first=await h.index('background=1');assert.equal(first.status,202);assert.equal(first.pending,true);
 let result;for(let i=0;i<100;i++){await new Promise(setImmediate);result=await h.index('background=1');if(!result.pending)break}
 assert.equal(result.status,200);assert.equal(result.summary.total,2503);assert.equal(result.folders.length,4);
 assert.deepEqual(h.calls.map(c=>[c.limit,c.offset]),[[1000,0],[1000,1000],[1000,2000]]);
 await h.index('background=1');assert.equal(h.calls.length,3);
 assert.equal((await h.index('background=1&refresh=1')).status,202);
});
test('a failed page is reported instead of restarting an endless loading loop',async()=>{
 const h=harness(true);await h.index('background=1');await new Promise(setImmediate);
 const result=await h.index('background=1');assert.equal(result.status,500);assert.match(result.error,/page unavailable/);
 await h.index('background=1');assert.equal(h.calls.length,2);
});
test('browser polls progress without repeatedly forcing a rebuild',async()=>{
 const script=readFileSync(new URL('../static/js/app.js',import.meta.url),'utf8');
 const urls=[],results=[{pending:true,loaded:1000},{pending:true,loaded:2000},{summary:{total:2503}}],label={};
 const context=vm.createContext({apiGet:async url=>{urls.push(url);return results.shift()},document:{querySelector:()=>label},setTimeout:callback=>callback()});
 vm.runInContext(script.slice(script.indexOf('async function loadLibraryIndex(')),context);
 const result=await vm.runInContext('loadLibraryIndex(true)',context);
 assert.equal(result.summary.total,2503);
 assert.deepEqual(urls,['/api/index?background=1&refresh=1','/api/index?background=1','/api/index?background=1']);
});
