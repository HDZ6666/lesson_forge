'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {ManualRecovery}=require('../src/api/manual_recovery.cjs');
function fixture(){const control={revision:3,manualRequired:true};let resumed=0;const manager={sourceControl:{status:()=>control,resume:r=>{assert.equal(r,3);resumed++;return {paused:false}}}};const recovery=new ManualRecovery(manager);return {recovery,manager,control,resumed:()=>resumed}}
test('人工会话属于一个操作人，未检查和过期检查均不允许恢复',()=>{
 const {recovery:r}=fixture();r.current={id:'one',owner:'1',revision:3};
 assert.throws(()=>r.require({sessionId:'one',owner:'2'}),/其他管理员/);
 assert.throws(()=>r.validate({sessionId:'one',owner:'1'}),/先检查/);
 r.current.verifiedAt=Date.now()-121000;assert.throws(()=>r.validate({sessionId:'one',owner:'1'}),/先检查/);
 r.current.verifiedAt=Date.now();assert.equal(r.validate({sessionId:'one',owner:'1'}).id,'one');
});
test('来源状态变化使检查结果失效，关闭浏览器不能解除暂停',async()=>{
 const {recovery:r,control,resumed}=fixture();let closed=false;
 r.current={id:'one',owner:'1',revision:3,verifiedAt:Date.now(),context:{close:async()=>{closed=true}}};
 control.revision=4;assert.throws(()=>r.validate({sessionId:'one',owner:'1'}),/状态已变化/);
 await r.close({sessionId:'one',owner:'1'});assert.equal(closed,true);assert.equal(r.active,false);assert.equal(resumed(),0);
});
test('检查通过后先关闭浏览器再恢复来源，避免复用档案冲突',async()=>{
 const {recovery:r,manager}=fixture();const events=[];
 r.current={id:'one',owner:'1',revision:3,verifiedAt:Date.now(),context:{close:async()=>events.push('close')}};
 manager.sourceControl.resume=()=>{events.push('resume');return {paused:false}};
 await r.finish({sessionId:'one',owner:'1'});assert.deepEqual(events,['close','resume']);
});
test('非来源页面不能假装完成验证，检查不会清除暂停',async()=>{
 const {recovery:r,resumed}=fixture();r.current={id:'one',owner:'1',revision:3,input:{},target:{},expires:Date.now()+1000,page:{url:()=> 'https://example.com'}};
 const result=await r.check({sessionId:'one',owner:'1'});assert.equal(result.verified,false);assert.match(result.message,/返回组卷网/);assert.equal(resumed(),0);
});
test('远程画面桥接拒绝未授权连接，授权后传输 RFB 字节',async()=>{
 const http=require('node:http'),net=require('node:net'),{once}=require('node:events'),{WebSocket}=require('ws');
 const {recovery:r}=fixture();const tcp=net.createServer(socket=>{socket.write('RFB 003.008\n');socket.on('data',data=>socket.write(data))});
 await new Promise(resolve=>tcp.listen(5901,'127.0.0.1',resolve));
 const server=http.createServer();r.current={id:'one',owner:'1',vnc:{},input:{},target:{}};r.attach(server,'secret');
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`ws://127.0.0.1:${server.address().port}/v1/manual-recovery/display?sessionId=one`;
 const denied=new WebSocket(url);await once(denied,'error');
 const ws=new WebSocket(url,{headers:{Authorization:'Bearer secret'}});
 const message=await once(ws,'message');assert.equal(message[0].toString(),'RFB 003.008\n');
 r.current.closing=true;ws.close();await once(ws,'close');await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>tcp.close(resolve));
});
