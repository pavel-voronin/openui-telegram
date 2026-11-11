import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('Telegram example sends, edits, answers, authorizes message context and resumes persisted messages without network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openui-telegram-example-'));
  try {
    const preload = join(directory, 'fake-api.mjs');
    await writeFile(preload, `
      import {writeFile,readFile} from 'node:fs/promises';
      const phase=Number(process.env.DEMO_TEST_PHASE), calls=[];
      let latest, answers=0, sent=false, command=false, waiting=false, allowed=phase!==1, disconnected=false, editFailures=0;
      globalThis.fetch=async (url,init)=>{
        const method=String(url).split('/').at(-1), body=JSON.parse(init.body); calls.push({method,body,connection:init.headers.connection});
        let result=true;
        if(method==='sendWidget'){sent=true;allowed=body.allow_queries===true;latest=JSON.parse(body.chat_data);result={message_id:phase===3?43:42};}
        else if(method==='editMessageWidgetData'){
          if(phase===1&&waiting&&answers===0&&editFailures++<2){
            if(editFailures===1)throw new TypeError('connection reset');
            latest=JSON.parse(body.chat_data); // Telegram applied the edit, but its response was lost.
            throw Object.assign(new Error('response timed out'),{name:'TimeoutError'});
          }
          if(phase===1&&waiting&&answers===0&&editFailures===3)
            return {json:async()=>({ok:false,description:'Bad Request: message is not modified'})};
          latest=JSON.parse(body.chat_data);
        }
        else if(method==='getUpdates'){
          if(phase===1&&!disconnected){disconnected=true;throw new TypeError('fetch failed',{cause:Object.assign(new Error('reset'),{code:'ECONNRESET'})});}
          if((phase===1||phase===3)&&!command){command=true;result=[{update_id:phase===1?1:30,message:{chat:{id:1,type:'private'},text:phase===1?'/simple':'/replace 42'}}];}
          else if(phase===3){
            let saved;try{saved=JSON.parse(await readFile('.demo-state/telegram/messages.json','utf8'));}catch{}
            if(sent&&saved?.records[0]?.messageId===43){await writeFile('calls.json',JSON.stringify(calls));process.emit('SIGINT');}
            else await new Promise(r=>setTimeout(r,10));
            result=[];
          }
          else if(!latest||waiting){await new Promise(r=>setTimeout(r,10));result=[];}
          else{
            if(!allowed) throw new Error('Mock widget cannot send queries: allow_queries was not enabled');
            waiting=true;
            const invalid=answers===1, stale=answers===2;
            result=[{update_id:phase*10+answers,widget_query:{id:invalid?'unauthorized':stale?'stale':'tap',chat:{id:1},from:{id:invalid?2:1},message_id:42,
              data:JSON.stringify([latest.i,latest.v,stale?-1:latest.r,'a','0'])}}];
          }
        } else if(method==='answerWidgetQuery'){
          answers++;waiting=false;
          if(answers===3){await writeFile('calls.json',JSON.stringify(calls));process.emit('SIGINT');}
        } else throw new Error('Unexpected API method '+method);
        return {json:async()=>({ok:true,result})};
      };
    `);
    const runner = fileURLToPath(new URL('../examples/telegram.mjs', import.meta.url));
    for (const phase of [1, 2, 3]) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, runner], { cwd: directory, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, TELEGRAM_BOT_TOKEN: 'offline-test', TELEGRAM_CHAT_ID: '1', DEMO_TEST_PHASE: String(phase) } });
      assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ''));
      if (phase === 1) assert.match(result.stderr, /Polling connection lost \(ECONNRESET\); retrying/);
      const calls = JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8'));
      if (phase === 1) {
        assert.equal((result.stderr.match(/delivery interrupted; retrying the same frame/g) ?? []).length, 2);
        const firstAnswer = calls.findIndex(call => call.method === 'answerWidgetQuery');
        const deliveries = calls.slice(0, firstAnswer).filter(call => call.method === 'editMessageWidgetData').slice(-3);
        assert.equal(deliveries.length, 3);
        assert.equal(new Set(deliveries.map(call => call.body.chat_data)).size, 1);
      }
      assert.ok(calls.every(call => call.connection === 'close'));
      const answers = calls.filter(call => call.method === 'answerWidgetQuery');
      assert.equal(answers.length, phase === 3 ? 0 : 3);
      if (phase !== 3) {
        assert.equal(typeof answers[0].body.data, 'string');
        assert.equal(answers[1].body.data, undefined); assert.equal(answers[2].body.data, undefined);
      }
      const sent = calls.filter(call => call.method === 'sendWidget');
      assert.equal(sent.length, phase === 2 ? 0 : 1);
      for (const call of sent) assert.equal(call.body.allow_queries, true);
      assert.ok(calls.some(call => call.method === 'editMessageWidgetData' && call.body.message_id === 42));
      const saved = JSON.parse(await readFile(join(directory, '.demo-state/telegram/messages.json'), 'utf8'));
      assert.equal(saved.records.length, 1); assert.equal(saved.records[0].saved.state.state.$count, Math.min(phase, 2));
      assert.equal(saved.records[0].messageId, phase === 3 ? 43 : 42);
      assert.ok(saved.records[0].saved.delivery.revision >= phase);
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('openui-telegram-example-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a crash during a command does not acknowledge it or later updates, and restart receives it again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openui-telegram-example-'));
  try {
    const preload = join(directory, 'crash-api.mjs');
    await writeFile(preload, `
      import {writeFile,readFile} from 'node:fs/promises';
      const crash=process.env.DEMO_TEST_CRASH==='yes', offsets=[];
      let started=false, batch=false;
      globalThis.fetch=async(url,init)=>{
        const method=String(url).split('/').at(-1),body=JSON.parse(init.body);let result=true;
        if(method==='getUpdates'){
          offsets.push(body.offset);
          if(!batch){batch=true;result=[
            {update_id:100,message:{chat:{id:1,type:'private'},text:'/simple'}},
            {update_id:101,message:{chat:{id:99,type:'private'},text:'/ignored'}}];}
          else if(crash&&started){await writeFile('offsets.json',JSON.stringify(offsets));process.exit(77);}
          else{
            let state;try{state=JSON.parse(await readFile('.demo-state/telegram/messages.json','utf8'));}catch{}
            if(!crash&&state?.records[0]?.messageId===42){await writeFile('offsets.json',JSON.stringify(offsets));process.emit('SIGINT');}
            await new Promise(r=>setTimeout(r,10));result=[];
          }
        }else if(method==='sendWidget'){
          started=true;if(crash)await new Promise(()=>{});result={message_id:42};
        }else if(method!=='editMessageWidgetData')throw new Error('Unexpected '+method);
        return{json:async()=>({ok:true,result})};
      };
    `);
    const runner = fileURLToPath(new URL('../examples/telegram.mjs', import.meta.url));
    const run = crash => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
      cwd: directory, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: 'offline-test', TELEGRAM_CHAT_ID: '1', DEMO_TEST_CRASH: crash ? 'yes' : 'no' },
    });
    const crashed = run(true); assert.equal(crashed.status, 77, crashed.stderr + String(crashed.error ?? ''));
    const interrupted = JSON.parse(await readFile(join(directory, '.demo-state/telegram/messages.json'), 'utf8'));
    assert.equal(interrupted.offset, 0); assert.equal(interrupted.records.length, 0);
    assert.ok(JSON.parse(await readFile(join(directory, 'offsets.json'), 'utf8')).every(offset => offset === 0));
    const resumed = run(false); assert.equal(resumed.status, 0, resumed.stderr + String(resumed.error ?? ''));
    assert.equal(JSON.parse(await readFile(join(directory, 'offsets.json'), 'utf8'))[0], 0);
    const completed = JSON.parse(await readFile(join(directory, '.demo-state/telegram/messages.json'), 'utf8'));
    assert.equal(completed.offset, 102); assert.equal(completed.records[0].messageId, 42);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('openui-telegram-example-'));
    await rm(directory, { recursive: true, force: true });
  }
});
