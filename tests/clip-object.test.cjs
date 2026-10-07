const {test}=require('node:test');const assert=require('node:assert/strict');
const {clipObjectKey}=require('../lib/clip-object.cjs');
const config={account:'account',bucket:'cricket-videos'};
const clip={provider:'cloudflare_r2',bucket:'cricket-videos',object_key:'clips/5/ball 532.mp4',url:'https://account.r2.cloudflarestorage.com/cricket-videos/clips/5/ball%20532.mp4?expired-signature=old'};
test('verified private object requires no public base and ignores old signature',()=>assert.equal(clipObjectKey(clip,config),clip.object_key));
test('wrong bucket, account and object key cannot cross into another video',()=>{
 for(const changed of [{bucket:'other'},{url:'https://evil.example/video.mp4'},{object_key:'another.mp4'},{object_key:'../video.mp4'}])assert.throws(()=>clipObjectKey({...clip,...changed},config));
});
test('legacy public base remains supported with strict origin',()=>{
 assert.equal(clipObjectKey({url:'https://videos.example/ott/clip.mp4'},config,'https://videos.example/ott'),'clip.mp4');
 assert.throws(()=>clipObjectKey({url:'https://evil.example/ott/clip.mp4'},config,'https://videos.example/ott'));
});
